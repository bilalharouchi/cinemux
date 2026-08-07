import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MatroskaDemuxer } from "../src/matroska/demuxer.js";
import { TrackType } from "../src/ebml/ids.js";
import { decodeFrame, readHeader } from "../src/codecs/ac3/trame.js";
import { BitReader } from "../src/codecs/ac3/bits.js";
import { ChannelSynthesis } from "../src/codecs/ac3/synthese.js";

/**
 * THE test that matters: decode a real AC-3 stream (a real fixture from the
 * repo, not fabricated bytes) all the way to PCM, and compare sample by
 * sample against `ffmpeg -i h264-ac3.mkv -f f32le` — an independent
 * reference decoder, not us grading ourselves.
 *
 * `h264-ac3-reference.f32` is generated ONCE (see `fixtures/README.md`),
 * not on every run: this test doesn't depend on ffmpeg being installed.
 */
function ac3Track(): Uint8Array {
  const data = new Uint8Array(readFileSync(new URL("./fixtures/h264-ac3.mkv", import.meta.url)));
  const samples: { track: number; data: Uint8Array }[] = [];
  let audioNumber = -1;
  const d = new MatroskaDemuxer({
    onTracks: (tracks) => {
      audioNumber = tracks.find((t) => t.type === TrackType.AUDIO)!.number;
    },
    onSample: (e) => samples.push(e),
  });
  d.feed(data);

  const chunks = samples.filter((e) => e.track === audioNumber).map((e) => e.data);
  const total = chunks.reduce((n, m) => n + m.length, 0);
  const stream = new Uint8Array(total);
  let off = 0;
  for (const m of chunks) {
    stream.set(m, off);
    off += m.length;
  }
  return stream;
}

function decode(stream: Uint8Array): Float64Array {
  const synth = new ChannelSynthesis();
  const pcm: number[] = [];
  let offset = 0;
  while (offset + 6 < stream.length) {
    if (!(stream[offset] === 0x0b && stream[offset + 1] === 0x77)) {
      offset++;
      continue;
    }
    const header = readHeader(new BitReader(stream.subarray(offset)));
    if (!header || header.sizeBytes === 0 || offset + header.sizeBytes > stream.length) {
      offset++;
      continue;
    }
    const res = decodeFrame(stream.subarray(offset, offset + header.sizeBytes));
    if (res) {
      for (const block of res.coefficientsPerBlock) {
        pcm.push(...synth.next(block[0]));
      }
    }
    offset += header.sizeBytes;
  }
  return Float64Array.from(pcm);
}

/**
 * Normalized correlation between two signals, `pcm` shifted by `offset`
 * samples relative to `ref` (0 = no offset).
 */
function correlate(pcm: Float64Array, ref: Float32Array, offset: number): number {
  const n = Math.min(pcm.length - offset, ref.length);
  let dot = 0;
  let normPcm = 0;
  let normRef = 0;
  for (let i = 0; i < n; i++) {
    const x = pcm[i + offset];
    const y = ref[i];
    dot += x * y;
    normPcm += x * x;
    normRef += y * y;
  }
  return dot / (Math.sqrt(normPcm) * Math.sqrt(normRef));
}

describe("AC-3 synthesis — comparison against ffmpeg", () => {
  /**
   * ONE-BLOCK (256 samples) ALGORITHMIC DELAY, expected and documented —
   * not a bug. The very first decoded block has no previous block to
   * overlap-add with (`ChannelSynthesis` starts at zero delay): it's a
   * fade-in, not real signal yet. `ffmpeg` (like any overlap-based decoder
   * — same principle as AAC's "encoder delay") does not emit it; our PCM
   * therefore has exactly 256 more samples than it, at the start. Measured:
   * with no offset, correlation −0.94 (real signal but misaligned); shifted
   * by one block, 0.9999999990.
   */
  const PRIMING_DELAY = 256;

  it("decodes one block more than the reference — the fade-in of the very first block", () => {
    const pcm = decode(ac3Track());
    const ref = new Float32Array(
      readFileSync(new URL("./fixtures/h264-ac3-reference.f32", import.meta.url)).buffer,
    );
    expect(pcm.length).toBe(ref.length + PRIMING_DELAY);
  });

  it("correlates above 0.999 with ffmpeg's real PCM, once the priming delay is removed — NEAR EXACT", () => {
    // A real bug (wrong window, inverted phase, wrong dequant) gives a
    // correlation close to 0 (unrelated noise) at ANY offset, not 0.999
    // exactly at this one: this threshold is generous, but nothing between
    // "it works" and "it's broken" hits it precisely there.
    const pcm = decode(ac3Track());
    const ref = new Float32Array(
      readFileSync(new URL("./fixtures/h264-ac3-reference.f32", import.meta.url)).buffer,
    );
    expect(correlate(pcm, ref, PRIMING_DELAY)).toBeGreaterThan(0.999);
  });

  it("without removing the delay, correlation collapses — proof the offset isn't arbitrary", () => {
    const pcm = decode(ac3Track());
    const ref = new Float32Array(
      readFileSync(new URL("./fixtures/h264-ac3-reference.f32", import.meta.url)).buffer,
    );
    expect(Math.abs(correlate(pcm, ref, 0))).toBeLessThan(0.95);
  });
});
