import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Remuxer, type Diagnostic } from "../src/remuxer.js";

/**
 * The cases that really break a remuxer: B-frames (DTS ≠ PTS), HEVC (a
 * painful codec string), Opus (a clock forced to 48 kHz).
 */

function remuxTo(name: string): { file: string; diag: Diagnostic } {
  const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
  const chunks: Uint8Array[] = [];
  let diag: Diagnostic | null = null;

  const r = new Remuxer({
    isSupported: () => true,
    onInit: (s, d) => {
      diag = d;
      chunks.push(s);
    },
    onSegment: (s) => chunks.push(s),
    onError: (e) => {
      throw e;
    },
  });
  for (let i = 0; i < bytes.length; i += 32768) {
    r.feed(bytes.subarray(i, Math.min(i + 32768, bytes.length)));
  }
  r.finish();

  const total = chunks.reduce((n, m) => n + m.length, 0);
  const output = new Uint8Array(total);
  let pos = 0;
  for (const m of chunks) {
    output.set(m, pos);
    pos += m.length;
  }
  const file = join(mkdtempSync(join(tmpdir(), "cinemux-")), name.replace(/\.mkv$/, ".mp4"));
  writeFileSync(file, output);
  return { file, diag: diag! };
}

/** Lists the PTS of a stream, in PRESENTATION order. */
function presentationPts(file: string, stream = "v:0"): number[] {
  const output = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", stream, "-show_entries", "frame=pts_time",
     "-of", "csv=p=0", file],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  // ffprobe sometimes adds an empty trailing field ("0.080000,"): keep only
  // the first column, otherwise Number() gives NaN on the first frame.
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l: string) => Number(l.split(",")[0]));
}

describe("difficult codecs", () => {
  it("B-frames: presentation order is intact", () => {
    // THE test that validates DTS reconstruction. If DTS = PTS, ffprobe
    // sees frames in decode order and the sequence is no longer increasing.
    const source = new URL("./fixtures/h264-bframes-aac.mkv", import.meta.url).pathname;
    const { file } = remuxTo("h264-bframes-aac.mkv");

    const before = presentationPts(source);
    const after = presentationPts(file);

    expect(after.length).toBe(before.length);
    // Strictly increasing: that's what a correct CTS guarantees.
    for (let i = 1; i < after.length; i++) {
      expect(after[i], `frame ${i}`).toBeGreaterThan(after[i - 1]);
    }
    // The offset from the source must be CONSTANT: that's the reordering
    // delay, unavoidable since `tfdt` can't be negative. What matters is
    // that it's identical everywhere — otherwise the picture speeds up or
    // lags.
    const offsets = after.map((t, i) => Number((t - before[i]).toFixed(4)));
    expect(new Set(offsets).size, `observed offsets: ${[...new Set(offsets)]}`).toBe(1);
    // And that it's on the order of a few frames, not a full second.
    expect(Math.abs(offsets[0])).toBeLessThan(0.2);
  });

  it("B-frames: the file decodes without error", () => {
    const { file } = remuxTo("h264-bframes-aac.mkv");
    const output = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(output.trim()).toBe("");
  });

  it("HEVC: codec string and decoding", () => {
    const { file, diag } = remuxTo("hevc-aac.mkv");
    expect(diag.video?.track.codecId).toBe("V_MPEGH/ISO/HEVC");
    // Expected shape: hvc1.<profile>.<compat hex>.<tier><level>[.constraints]
    expect(diag.video?.description.codec).toMatch(/^hvc1\.\d+\.[0-9A-F]+\.[LH]\d+/);

    const stream = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", file],
      { encoding: "utf8" },
    );
    expect(stream).toContain("hevc");

    const output = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(output.trim()).toBe("");
  });

  it("Opus: clock forced to 48 kHz and OpusHead stripped", () => {
    const { file, diag } = remuxTo("h264-opus.mkv");
    expect(diag.audio?.track.codecId).toBe("A_OPUS");
    expect(diag.audio?.description.codec).toBe("opus");
    // Opus always works at 48 kHz, regardless of the declared frequency.
    expect(diag.audio?.description.timescale).toBe(48000);

    const stream = execFileSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate",
       "-of", "csv=p=0", file],
      { encoding: "utf8" },
    );
    expect(stream.trim()).toContain("opus");

    const output = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(output.trim()).toBe("");
  });

  it("E-AC-3: described (not left as `null`), even though no browser plays it", () => {
    // A regression we actually hit: `describe()` had no `case "A_EAC3"` and
    // fell into `default:` — `this.audio` stayed `null` for good (not just
    // "unsupported"), so `diag.audio` did too. The player couldn't even say
    // WHY there was no sound, let alone attempt any fallback.
    const { diag } = remuxTo("h264-eac3.mkv");
    expect(diag.audio).not.toBeNull();
    expect(diag.audio?.track.codecId).toBe("A_EAC3");
    expect(diag.audio?.description.codec).toBe("ec-3");

    const stream = execFileSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels",
       "-of", "csv=p=0", new URL("./fixtures/h264-eac3.mkv", import.meta.url).pathname],
      { encoding: "utf8" },
    ).trim();
    const [expectedFreq, expectedChannels] = stream.split(",").map(Number);
    expect(diag.audio?.description.timescale).toBe(expectedFreq);
    // `channels` isn't exposed directly on `Description`; it's on `entry`
    // (the MP4 box) — checked indirectly via `timescale`/`codec` above, the
    // next test covers the "no browser plays it" case.
    expect(expectedChannels).toBe(1);
  });

  it("E-AC-3: correctly flagged as muted, with the real reason", () => {
    const bytes = new Uint8Array(
      readFileSync(new URL("./fixtures/h264-eac3.mkv", import.meta.url)),
    );
    let diag: Diagnostic | null = null;
    const r = new Remuxer({
      isSupported: () => false, // the real case: no browser decodes ec-3 in MSE
      onInit: (_s, d) => {
        diag = d;
      },
      onError: (e) => {
        throw e;
      },
    });
    for (let i = 0; i < bytes.length; i += 32768) {
      r.feed(bytes.subarray(i, Math.min(i + 32768, bytes.length)));
    }
    r.finish();

    expect(diag).not.toBeNull();
    expect(diag!.audio?.track.codecId).toBe("A_EAC3");
    expect(diag!.audio?.supported).toBe(false);
    expect(diag!.mutedAudio).toBe(true);
    expect(diag!.discarded.some((e) => e.track.codecId === "A_EAC3")).toBe(true);
  });

  it("640x360: dimensions survive the remux", () => {
    const { file } = remuxTo("h264-bframes-aac.mkv");
    const dim = execFileSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
       "-of", "csv=p=0", file],
      { encoding: "utf8" },
    ).trim();
    expect(dim).toBe("640,360");
  });

  it("audio and video stay in sync", () => {
    // An A/V drift is the symptom of a wrong timescale or a wrong tfdt.
    const { file } = remuxTo("h264-bframes-aac.mkv");
    const start = (stream: string) =>
      Number(
        execFileSync(
          "ffprobe",
          ["-v", "error", "-select_streams", stream, "-show_entries", "stream=start_time",
           "-of", "csv=p=0", file],
          { encoding: "utf8" },
        ).trim(),
      );
    // The reordering offset applies to BOTH tracks: applying it to video
    // only shifted the sound by 80 ms (an audible lip-sync bug).
    expect(Math.abs(start("v:0") - start("a:0"))).toBeLessThan(0.005);

    const duration = (stream: string) =>
      Number(
        execFileSync(
          "ffprobe",
          ["-v", "error", "-select_streams", stream, "-show_entries", "stream=duration",
           "-of", "csv=p=0", file],
          { encoding: "utf8" },
        ).trim(),
      );
    // Less than 100 ms of duration gap between the two tracks over 4s.
    expect(Math.abs(duration("v:0") - duration("a:0"))).toBeLessThan(0.1);
  });
});
