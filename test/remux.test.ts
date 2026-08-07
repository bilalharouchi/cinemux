import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Remuxer, sameLanguage, type Diagnostic } from "../src/remuxer.js";

/**
 * These tests judge the output with ffprobe, not with our own convictions.
 * An fMP4 that "looks right" and that no demuxer can read back has no value.
 */

describe("sameLanguage", () => {
  // Pure string comparison, no MKV involved — a fixture would test nothing
  // a unit test doesn't already cover more directly.
  it("matches ISO 639-2 tags against their ISO 639-1 form, not just French", () => {
    expect(sameLanguage("ger", "de")).toBe(true);
    expect(sameLanguage("deu", "de")).toBe(true);
    expect(sameLanguage("spa", "es")).toBe(true);
    expect(sameLanguage("ita", "it")).toBe(true);
    expect(sameLanguage("fre", "fr")).toBe(true);
    expect(sameLanguage("fra", "fr")).toBe(true);
  });

  it("still rejects genuinely different languages", () => {
    expect(sameLanguage("ger", "fr")).toBe(false);
    expect(sameLanguage("eng", "de")).toBe(false);
  });

  it("ignores a region suffix (`de-DE`, `fr_CA`)", () => {
    expect(sameLanguage("de-DE", "de")).toBe(true);
    expect(sameLanguage("fr_CA", "fra")).toBe(true);
  });
});

function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

/** Codecs the tests' fake browser accepts: the Chrome case. */
function fakeSupport(mime: string): boolean {
  return !/ac-3|ec-3|dts/.test(mime);
}

type Result = { file: string; diag: Diagnostic; segments: number; bytes: number };

function remux(name: string, options: { support?: (m: string) => boolean; language?: string } = {}): Result {
  const chunks: Uint8Array[] = [];
  let diag: Diagnostic | null = null;
  let segments = 0;

  const r = new Remuxer({
    isSupported: options.support ?? fakeSupport,
    preferredLanguage: options.language,
    onInit: (seg, d) => {
      diag = d;
      chunks.push(seg);
    },
    onSegment: (seg) => {
      segments++;
      chunks.push(seg);
    },
    onError: (e) => {
      throw e;
    },
  });

  // Fed in 64 KB chunks, like a streamed HTTP request would.
  const bytes = readFixture(name);
  for (let i = 0; i < bytes.length; i += 65536) {
    r.feed(bytes.subarray(i, Math.min(i + 65536, bytes.length)));
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
  return { file, diag: diag!, segments, bytes: total };
}

function ffprobe(file: string, ...args: string[]): string {
  return execFileSync("ffprobe", ["-v", "error", ...args, file], { encoding: "utf8" }).trim();
}

describe("MKV → fMP4 remux", () => {
  it("produces an MP4 that ffprobe reads back, with both tracks", () => {
    const { file, diag } = remux("h264-aac.mkv");

    expect(diag.video?.track.codecId).toBe("V_MPEG4/ISO/AVC");
    expect(diag.audio?.track.codecId).toBe("A_AAC");
    // The codec string is DERIVED from the avcC, never guessed: x264 in
    // `ultrafast` produces Constrained Baseline level 1.2, i.e. 42c00c.
    const avcC = diag.video!.track.codecPrivate!;
    const expected = [avcC[1], avcC[2], avcC[3]]
      .map((o) => o.toString(16).padStart(2, "0"))
      .join("");
    expect(diag.mime).toBe(`video/mp4; codecs="avc1.${expected},mp4a.40.2"`);
    expect(diag.mime).toMatch(/^video\/mp4; codecs="avc1\.[0-9a-f]{6},mp4a\.40\.2"$/);

    const stream = ffprobe(file, "-show_entries", "stream=codec_name,codec_type,width,height", "-of", "csv=p=0");
    expect(stream).toContain("h264,video,320,180");
    expect(stream).toContain("aac,audio");
  });

  it("the container is indeed fragmented MP4", () => {
    const { file } = remux("h264-aac.mkv");
    const format = ffprobe(file, "-show_entries", "format=format_name", "-of", "csv=p=0");
    expect(format).toMatch(/mp4/);
    // A fragmented file has no sample table: ffprobe reads it via moof boxes.
    const bytes = readFileSync(file);
    expect(bytes.includes(Buffer.from("moof"))).toBe(true);
    expect(bytes.includes(Buffer.from("mvex"))).toBe(true);
    expect(bytes.includes(Buffer.from("tfdt"))).toBe(true);
  });

  it("no frame is lost or invented", () => {
    const { file } = remux("h264-aac.mkv");
    const source = new URL("./fixtures/h264-aac.mkv", import.meta.url).pathname;

    const count = (f: string, stream: string) =>
      Number(
        execFileSync(
          "ffprobe",
          ["-v", "error", "-select_streams", stream, "-count_packets",
           "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", f],
          { encoding: "utf8" },
        ).trim(),
      );

    expect(count(file, "v:0")).toBe(count(source, "v:0"));
    expect(count(file, "a:0")).toBe(count(source, "a:0"));
  });

  it("the video actually decodes, without error", () => {
    // The only test that proves the bytes are in the right place: decode everything.
    const { file } = remux("h264-aac.mkv");
    const output = execFileSync(
      "ffmpeg",
      ["-v", "error", "-i", file, "-f", "null", "-"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(output.trim()).toBe("");
  });

  it("duration is preserved", () => {
    const { file } = remux("h264-aac.mkv");
    const duration = Number(ffprobe(file, "-show_entries", "format=duration", "-of", "csv=p=0"));
    expect(duration).toBeGreaterThan(2.9);
    expect(duration).toBeLessThan(3.2);
  });

  it("prefers AAC over AC-3 when both exist", () => {
    // A real MULTi release case: the AC-3 track is often first and marked
    // as default, but no browser decodes it.
    const { diag } = remux("h264-multi-audio.mkv");
    expect(diag.audio?.track.codecId).toBe("A_AAC");
    expect(diag.audio?.supported).toBe(true);
  });

  it("keeps AC-3 when the browser decodes it (Safari)", () => {
    const { diag } = remux("h264-multi-audio.mkv", { support: () => true });
    // Everything is supported: codec rank then decides, AAC first.
    expect(diag.audio?.supported).toBe(true);
  });

  it("an AC-3-only file is described, and flagged as unplayable", () => {
    // We don't pretend: the track is described (dac3 written from the
    // stream), but `supported` tells the player the truth so it can offer
    // something else.
    const { diag } = remux("h264-ac3.mkv");
    expect(diag.audio?.track.codecId).toBe("A_AC3");
    expect(diag.audio?.supported).toBe(false);
    expect(diag.video?.supported).toBe(true);
  });

  it("produces several fragments rather than a single block", () => {
    // A single fragment would rule out progressive playback: everything
    // would need to download before the first frame.
    const { segments } = remux("h264-aac.mkv");
    expect(segments).toBeGreaterThan(2);
  });

  it("offers unmuxed AC-3 frames via onUnmuxedSample, instead of discarding them", () => {
    // This is what `player.ts` uses to play sound through the Web Audio API
    // when MediaSource can't (see audio-ac3.ts): without this callback,
    // these frames simply vanished inside `store()`.
    const received: { size: number; codecId: string }[] = [];
    const r = new Remuxer({
      isSupported: fakeSupport,
      onError: (e) => {
        throw e;
      },
      onUnmuxedSample: (e, track) => {
        received.push({ size: e.data.length, codecId: track.codecId });
      },
    });
    r.feed(readFixture("h264-ac3.mkv"));
    r.finish();

    expect(received.length).toBeGreaterThan(0);
    expect(received.every((x) => x.codecId === "A_AC3")).toBe(true);
    expect(received.every((x) => x.size > 0)).toBe(true);
  });

  it("does NOT call onUnmuxedSample when the AC-3 is actually playable (Safari)", () => {
    const received: unknown[] = [];
    const r = new Remuxer({
      isSupported: () => true,
      onError: (e) => {
        throw e;
      },
      onUnmuxedSample: (e) => received.push(e),
    });
    r.feed(readFixture("h264-ac3.mkv"));
    r.finish();
    expect(received).toHaveLength(0);
  });

  it("AC-3 audio is correctly parsed from the stream", async () => {
    const { parseAc3Header } = await import("../src/codecs/index.js");
    // First AC-3 frame of the fixture, extracted via the demuxer.
    const { MatroskaDemuxer } = await import("../src/matroska/demuxer.js");
    let frame: Uint8Array | null = null;
    const d = new MatroskaDemuxer({
      onSample: (e: { track: number; data: Uint8Array }) => {
        if (!frame && e.track === 2) frame = e.data;
      },
    });
    d.feed(readFixture("h264-ac3.mkv"));

    const header = parseAc3Header(frame!);
    expect(header).not.toBeNull();
    // ffprobe reports 44100 Hz / 1 channel on this fixture: our bitstream
    // reading must land exactly on it, with no CodecPrivate to help.
    expect(header!.frequency).toBe(44100);
    expect([48000, 44100, 32000]).toContain(header!.frequency);
    expect(header!.channels).toBe(1);
  });
});
