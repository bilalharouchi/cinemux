import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MatroskaDemuxer, type Sample, type Track } from "../src/matroska/demuxer.js";
import { TrackType } from "../src/ebml/ids.js";

/**
 * The fixtures are produced by ffmpeg (see test/fixtures/README.md): they're
 * real MKVs written by a real muxer, not hand-fabricated bytes. A parser
 * that only passes on its own test files proves nothing.
 */
function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

/** Demuxes in a single chunk. */
function demux(name: string) {
  const tracks: Track[] = [];
  const samples: Sample[] = [];
  const d = new MatroskaDemuxer({
    onTracks: (t) => tracks.push(...t),
    onSample: (e) => samples.push(e),
  });
  d.feed(readFixture(name));
  return { d, tracks, samples };
}

describe("Matroska demuxer", () => {
  it("reads the timestamp scale and duration", () => {
    const { d } = demux("h264-aac.mkv");
    // ffmpeg writes 1 ms per tick, the spec's default.
    expect(d.timestampScale).toBe(1_000_000);
    expect(d.durationMs).toBeGreaterThan(2900);
    expect(d.durationMs).toBeLessThan(3200);
  });

  it("finds both tracks and their codecs", () => {
    const { tracks } = demux("h264-aac.mkv");
    expect(tracks).toHaveLength(2);

    const video = tracks.find((t) => t.type === TrackType.VIDEO)!;
    expect(video.codecId).toBe("V_MPEG4/ISO/AVC");
    expect(video.video?.width).toBe(320);
    expect(video.video?.height).toBe(180);
    // Without avcC, the decoder can't be initialized: this is disqualifying.
    expect(video.codecPrivate).not.toBeNull();
    expect(video.codecPrivate!.length).toBeGreaterThan(7);

    const audio = tracks.find((t) => t.type === TrackType.AUDIO)!;
    expect(audio.codecId).toBe("A_AAC");
    expect(audio.audio?.frequency).toBe(44100);
    expect(audio.audio?.channels).toBe(1);
    expect(audio.codecPrivate).not.toBeNull(); // AudioSpecificConfig
  });

  it("the H.264 CodecPrivate is indeed an avcC", () => {
    // This is the assumption that makes remuxing possible without rewriting
    // the bitstream: configurationVersion = 1, then profile/compat/level.
    const { tracks } = demux("h264-aac.mkv");
    const avcC = tracks.find((t) => t.type === TrackType.VIDEO)!.codecPrivate!;
    expect(avcC[0]).toBe(1);
    // The top 2 bits of byte 4 are reserved as 1 (0xFC).
    expect(avcC[4] & 0xfc).toBe(0xfc);
  });

  it("extracts every frame with increasing timestamps", () => {
    const { samples } = demux("h264-aac.mkv");
    // 3s at 25fps = 75 video frames, plus audio.
    const video = samples.filter((e) => e.track === 1);
    expect(video.length).toBeGreaterThanOrEqual(74);

    // The first video sample must be a keyframe.
    expect(video[0].keyframe).toBe(true);

    // Decode order: timestamps must never go backwards.
    for (let i = 1; i < video.length; i++) {
      expect(video[i].timestamp).toBeGreaterThanOrEqual(video[i - 1].timestamp);
    }
  });

  it("no empty frame ever comes out of the demuxer", () => {
    // A 0-byte frame would pass the type system and break the downstream decoder.
    const { samples } = demux("h264-aac.mkv");
    expect(samples.length).toBeGreaterThan(0);
    for (const e of samples) expect(e.data.length).toBeGreaterThan(0);
  });

  it("chunking doesn't change the result", () => {
    // THE test that matters for streaming: an element split across a chunk
    // boundary must be deferred, not lost or duplicated.
    const bytes = readFixture("h264-aac.mkv");
    const wholeFile = demux("h264-aac.mkv").samples;

    for (const size of [1, 7, 64, 1000, 65536]) {
      const samples: Sample[] = [];
      const d = new MatroskaDemuxer({ onSample: (e) => samples.push(e) });
      for (let i = 0; i < bytes.length; i += size) {
        d.feed(bytes.subarray(i, Math.min(i + size, bytes.length)));
      }
      expect(samples.length, `${size}-byte chunks`).toBe(wholeFile.length);
      expect(samples[0].data, `${size}-byte chunks`).toEqual(wholeFile[0].data);
      const last = samples.length - 1;
      expect(samples[last].timestamp).toBe(wholeFile[last].timestamp);
    }
  });

  it("recognizes AC3, which no browser decodes", () => {
    const { tracks } = demux("h264-ac3.mkv");
    const audio = tracks.find((t) => t.type === TrackType.AUDIO)!;
    expect(audio.codecId).toBe("A_AC3");
    // The spec doesn't provide a CodecPrivate for AC3: everything is in the stream.
    expect(audio.codecPrivate).toBeNull();
  });

  it("sees both audio tracks of a multi-language file", () => {
    const { tracks } = demux("h264-multi-audio.mkv");
    const audio = tracks.filter((t) => t.type === TrackType.AUDIO);
    expect(audio).toHaveLength(2);
    expect(audio.map((t) => t.codecId).sort()).toEqual(["A_AAC", "A_AC3"]);
  });

  it("collects the seek index (Cues)", () => {
    const { d } = demux("h264-aac.mkv");
    expect(d.cues.length).toBeGreaterThan(0);
    // Positions are relative to the Segment: we made them absolute.
    for (const c of d.cues) expect(c.clusterPosition).toBeGreaterThan(0);
    // The first seek point is at zero.
    expect(d.cues[0].time).toBe(0);
  });
});
