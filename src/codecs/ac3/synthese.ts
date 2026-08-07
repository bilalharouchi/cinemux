import { SYNTHESIS_WINDOW, IMDCT_SIZE, imdct256 } from "./imdct.js";

const N = IMDCT_SIZE / 2;
/**
 * Calibration constant — NOT derived from the standard, MEASURED.
 *
 * The IMDCT+window pair (`imdct.ts`) is verified by TDAC reconstruction
 * (mathematical round-trip), but that round-trip only fixes a consistent
 * internal ratio — not the ABSOLUTE gain the AC-3 encoder actually used
 * (its own MDCT normalizes its own way, invisible from the bitstream
 * alone).
 *
 * Measured by comparing, sample by sample, our decoded PCM against the
 * real PCM from `ffmpeg -i … -f f32le` on `h264-ac3.mkv` (mono, 192 kb/s):
 * correlation −0.9999999990 (near-exact −1, the remaining noise is
 * floating-point precision over 133,632 samples) — i.e. our output EQUALS
 * the real one, up to a sign and a factor of 512. This constant corrects
 * both at once; without it the sound would come out 512× too loud AND
 * inverted. See `test/ac3-synthese.test.ts`.
 */
const SCALE = 1 << 15; // 32768 = 2²⁴ / 512

/**
 * Time-domain synthesis of ONE channel — overlap-add state between
 * consecutive blocks (see `imdct.ts` for the TDAC verification of the
 * IMDCT+window pair). A block of 256 coefficients produces 256 real PCM
 * samples, but only after being combined with the PREVIOUS block — a
 * channel therefore needs its own state, reset to zero at the start of the
 * stream (the very first block has a fade-in, normal behavior, not a bug).
 */
export class ChannelSynthesis {
  private delay = new Float64Array(N);

  /**
   * @param coeffs 256 dequantized coefficients (`FrameResult.coefficientsPerBlock[block][channel]`).
   * @returns 256 PCM samples, floats in ~[-1, 1].
   */
  next(coeffs: Float64Array): Float64Array {
    const raw = imdct256(coeffs);
    const window = new Float64Array(IMDCT_SIZE);
    for (let i = 0; i < IMDCT_SIZE; i++) window[i] = raw[i] * SYNTHESIS_WINDOW[i];

    const output = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      output[i] = -(this.delay[i] + window[i]) / SCALE;
    }
    this.delay = window.subarray(N, IMDCT_SIZE);
    return output;
  }
}
