import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decodeFrame, readHeader } from "../src/codecs/ac3/trame.js";
import { BitReader } from "../src/codecs/ac3/bits.js";
import { ChannelSynthesis } from "../src/codecs/ac3/synthese.js";

/**
 * Stereo AC-3 (acmod=2) — two distinct bugs that mono could NOT reveal (a
 * single channel, never a boundary between channels):
 *
 *   1. The state of grouped mantissas (bap 1/2/4, `mantisse.ts`) was reset
 *      to zero for EVERY channel. `decode_transform_coeffs` (ac3dec.c)
 *      declares `mant_groups m` ONCE per block and passes it by pointer to
 *      each channel (and to coupling) — a leftover group from channel 0
 *      must be consumed by channel 1 before it reads a new word. Real
 *      symptom: crackling/clipping stereo audio, bitstream catastrophically
 *      desynchronized as early as block 1 or 2.
 *
 *   2. The COUPLING channel (high frequencies shared between channels,
 *      §7.4) decoded its exponents with the structure of normal channels
 *      (absolute value alone in its own bin, differential chain starting
 *      from the next bin). Wrong specifically for coupling:
 *      `decode_exponents` writes the differential chain starting from the
 *      VERY FIRST bin (`start_freq[CPL_CH] + !!ch`, zero for `ch==CPL_CH==0`)
 *      — all coupling exponents were shifted by one position, throwing off
 *      psd and then bap across the whole coupling bandwidth.
 *
 * Both are verified end to end — bit-exact stream alignment (`verify`) AND
 * audio correlation against an INDEPENDENT reference PCM (ffmpeg), same
 * methodology as `ac3-synthese.test.ts` for mono.
 */

function decodeStream(stream: Uint8Array): [Float64Array, Float64Array] {
  const synthL = new ChannelSynthesis();
  const synthR = new ChannelSynthesis();
  const pcmL: number[] = [];
  const pcmR: number[] = [];
  let offset = 0;
  let frames = 0;
  let aligned = 0;
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
    const frame = stream.subarray(offset, offset + header.sizeBytes);
    const res = decodeFrame(frame);
    frames++;
    if (res) {
      const remaining = header.sizeBytes * 8 - res.bitsConsumed;
      // Never negative: a negative remainder is the direct symptom of a
      // deficit of skipped bits somewhere earlier (see the two bugs above).
      expect(remaining, `frame #${frames} @ offset ${offset}`).toBeGreaterThanOrEqual(0);
      if (remaining < 300) aligned++;
      for (const block of res.coefficientsPerBlock) {
        pcmL.push(...synthL.next(block[0]));
        pcmR.push(...synthR.next(block[1]));
      }
    }
    offset += header.sizeBytes;
  }
  expect(frames).toBeGreaterThan(50);
  // At least 90% of frames land cleanly on the next syncword — the rest can
  // be legitimate auxdata (same margin as mono), but never a negative
  // remainder (checked above on every frame).
  expect(aligned / frames, `${aligned}/${frames} frames aligned`).toBeGreaterThan(0.9);
  return [Float64Array.from(pcmL), Float64Array.from(pcmR)];
}

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

function deinterleave(ref: Float32Array): [Float32Array, Float32Array] {
  const l = new Float32Array(ref.length / 2);
  const r = new Float32Array(ref.length / 2);
  for (let i = 0; i < l.length; i++) {
    l[i] = ref[i * 2];
    r[i] = ref[i * 2 + 1];
  }
  return [l, r];
}

describe("AC-3 stereo — no coupling (two distinct tones)", () => {
  it("bit-exact stream AND correlates above 0.999 on BOTH channels — like mono", () => {
    const stream = new Uint8Array(readFileSync(new URL("./fixtures/stereo-simple.ac3", import.meta.url)));
    const [pcmL, pcmR] = decodeStream(stream);
    const ref = new Float32Array(
      readFileSync(new URL("./fixtures/stereo-simple-reference.f32", import.meta.url)).buffer,
    );
    const [refL, refR] = deinterleave(ref);

    // Raw content (no MKV container to demux): ffmpeg doesn't have the same
    // priming delay as a stream demuxed from a .mkv — zero offset here,
    // verified empirically against the independent reference.
    expect(correlate(pcmL, refL, 0)).toBeGreaterThan(0.999);
    expect(correlate(pcmR, refR, 0)).toBeGreaterThan(0.999);
  });
});

describe("AC-3 stereo — with coupling (pink noise, realistic wideband content)", () => {
  it("bit-exact stream AND correlates above 0.98 on BOTH channels", () => {
    // Pink noise forces real high-frequency content into the coupling
    // channel (unlike a pure tone): that's what distinguishes "coupling
    // bits are consumed" from "coupling coefficients are CORRECTLY
    // distributed to the channels" (bug #2 above).
    //
    // Lower threshold than mono/no-coupling (0.98 instead of 0.999): bap=0
    // (dither noise, §7.3.4) returns 0 here instead of random noise like
    // ffmpeg does — a stream WITHOUT coupling on this same pink noise caps
    // out at the same correlation (~0.99), so the gap comes from the
    // wideband content, not a coupling bug. See mantisse.ts.
    const stream = new Uint8Array(readFileSync(new URL("./fixtures/stereo-coupling.ac3", import.meta.url)));
    const [pcmL, pcmR] = decodeStream(stream);
    const ref = new Float32Array(
      readFileSync(new URL("./fixtures/stereo-coupling-reference.f32", import.meta.url)).buffer,
    );
    const [refL, refR] = deinterleave(ref);

    expect(correlate(pcmL, refL, 0)).toBeGreaterThan(0.98);
    expect(correlate(pcmR, refR, 0)).toBeGreaterThan(0.98);
  });
});
