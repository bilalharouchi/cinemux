import { describe, expect, it } from "vitest";
import { SYNTHESIS_WINDOW, IMDCT_SIZE, imdct256 } from "../src/codecs/ac3/imdct.js";

const N = IMDCT_SIZE / 2; // 256

/**
 * Forward MDCT — ONLY for this test, to verify the perfect reconstruction
 * (TDAC) of `imdct256`. The decoder never needs to encode: this function
 * must not be exported from `src/`.
 */
function mdct(x: Float64Array): Float64Array {
  const X = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let s = 0;
    for (let n = 0; n < IMDCT_SIZE; n++) {
      s += x[n] * Math.cos((Math.PI / N) * (n + N / 2 + 0.5) * (k + 0.5));
    }
    X[k] = s;
  }
  return X;
}

/** Deterministic PRNG (no Math.random in tests). */
function whiteNoise(size: number, seed = 1): Float64Array {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff - 0.5;
  };
  return Float64Array.from({ length: size }, () => next());
}

describe("IMDCT + AC-3 synthesis window", () => {
  it("the window satisfies the TDAC condition (Princen-Bradley)", () => {
    // w[i]² + w[i+N]² = 1 for all i — WITHOUT this equality, overlap-add
    // never cancels the aliasing introduced by the MDCT's critical
    // subsampling, and the sound stays audibly wrong.
    for (let i = 0; i < N; i++) {
      const sum = SYNTHESIS_WINDOW[i] ** 2 + SYNTHESIS_WINDOW[i + N] ** 2;
      expect(sum).toBeCloseTo(1, 9);
    }
  });

  it("reconstructs a random signal to floating-point precision (TDAC)", () => {
    // The test that actually proves something: encode two overlapping
    // blocks, decode, overlap-add, and land back on the original in the
    // zone fully covered. A phase shift, a wrong scale factor, or an
    // incompatible window would fail HERE, not subtly somewhere else.
    const signal = whiteNoise(4 * N, 42);
    const block0 = signal.subarray(0, IMDCT_SIZE);
    const block1 = signal.subarray(N, N + IMDCT_SIZE);

    const applyWindow = (b: Float64Array) => b.map((v, i) => v * SYNTHESIS_WINDOW[i]);

    const X0 = mdct(applyWindow(block0));
    const X1 = mdct(applyWindow(block1));

    const y0 = imdct256(X0).map((v, i) => v * SYNTHESIS_WINDOW[i]);
    const y1 = imdct256(X1).map((v, i) => v * SYNTHESIS_WINDOW[i]);

    // Overlap-add: second half of y0 + first half of y1 = samples [N, 2N)
    // of the original signal (the zone covered by both windows).
    for (let i = 0; i < N; i++) {
      const reconstructed = y0[N + i] + y1[i];
      expect(reconstructed).toBeCloseTo(signal[N + i], 9);
    }
  });

  it("produces 512 samples from 256 coefficients", () => {
    const coeffs = new Float64Array(N);
    coeffs[0] = 1;
    expect(imdct256(coeffs)).toHaveLength(IMDCT_SIZE);
  });
});
