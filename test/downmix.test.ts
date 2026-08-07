import { describe, expect, it } from "vitest";
import { DEFAULT_MIX_LEVEL, downmixToStereo } from "../src/codecs/ac3/downmix.js";

/**
 * One sample per channel, each channel a distinct constant, so every gain
 * shows up as a distinct, easy-to-hand-check term in the sum.
 */
function chan(value: number): Float32Array {
  return new Float32Array([value]);
}

describe("downmixToStereo", () => {
  it("acmod 1 (mono, C only) duplicates to both speakers", () => {
    const [l, r] = downmixToStereo(1, [chan(1)]);
    expect(l[0]).toBe(1);
    expect(r[0]).toBe(1);
  });

  it("acmod 2 (L, R) passes through unchanged", () => {
    const [l, r] = downmixToStereo(2, [chan(1), chan(2)]);
    expect(l[0]).toBe(1);
    expect(r[0]).toBe(2);
  });

  it("acmod 0 (dual mono) is not a real downmix: each program stays on its own side", () => {
    const [l, r] = downmixToStereo(0, [chan(1), chan(2)]);
    expect(l[0]).toBe(1);
    expect(r[0]).toBe(2);
  });

  it("acmod 3 (L, C, R) mixes center into both at -3dB", () => {
    const [l, r] = downmixToStereo(3, [chan(1), chan(2), chan(3)]);
    expect(l[0]).toBeCloseTo(1 + 2 * DEFAULT_MIX_LEVEL, 6);
    expect(r[0]).toBeCloseTo(3 + 2 * DEFAULT_MIX_LEVEL, 6);
  });

  it("acmod 6 (L, R, Ls, Rs) sends each surround to its matching side only", () => {
    const [l, r] = downmixToStereo(6, [chan(1), chan(2), chan(3), chan(4)]);
    expect(l[0]).toBeCloseTo(1 + 3 * DEFAULT_MIX_LEVEL, 6);
    expect(r[0]).toBeCloseTo(2 + 4 * DEFAULT_MIX_LEVEL, 6);
  });

  it("acmod 7 (L, C, R, Ls, Rs — the common 5.1 case) puts the center in BOTH speakers, not just one", () => {
    // The bug lived: center (index 1, almost all dialogue) used to land only
    // on the right speaker via the browser's undefined 5-channel fallback.
    const [l, r] = downmixToStereo(7, [chan(1), chan(2), chan(3), chan(4), chan(5)]);
    const level = DEFAULT_MIX_LEVEL;
    expect(l[0]).toBeCloseTo(1 + 2 * level + 4 * level, 6);
    expect(r[0]).toBeCloseTo(3 + 2 * level + 5 * level, 6);
    // Dialogue (center=2) reaches both speakers, not just one.
    expect(l[0]).toBeGreaterThan(1);
    expect(r[0]).toBeGreaterThan(3);
  });

  it("every full-bandwidth channel across every acmod contributes to the output (none silently dropped)", () => {
    // Regression guard for the actual symptom: R/Ls/Rs used to vanish entirely.
    for (const [acmod, count] of [
      [0, 2], [1, 1], [2, 2], [3, 3], [4, 3], [5, 4], [6, 4], [7, 5],
    ] as const) {
      const channels = Array.from({ length: count }, (_, i) => chan(i + 1));
      const [l, r] = downmixToStereo(acmod, channels);
      expect(l[0] + r[0]).toBeGreaterThan(0);
    }
  });
});
