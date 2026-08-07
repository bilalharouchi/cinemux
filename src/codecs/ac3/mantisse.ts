import type { BitReader } from "./bits.js";

/**
 * Mantissa dequantization — Section 7.3, Tables 7.19 to 7.23.
 *
 * Each coefficient has a `bap` (bit allocation pointer, computed by
 * `bitalloc.ts`) that says HOW to read its value: nothing (bap 0), a word
 * shared by 2-3 values (bap 1/2/4, "grouped"), or direct two's-complement
 * bits (bap 3/5/6-15). Symmetric for all except 6-15
 * ("asymmetric" — the value IS the bits, just scaled).
 *
 * PROVENANCE — generators and tables copied from
 * ffmpeg/libavcodec/ac3dec_data.c (`ff_ac3_init_static`, `SYMMETRIC_DEQUANT`)
 * rather than reinvented: this is where the `MANTISSA_BITS[3]/[5]` bug
 * (see `trame.ts`) lived — for this module, we work from the source text,
 * not from memory.
 *
 * SCALE — each dequantized value is a signed 24-bit integer (same
 * convention as ffmpeg's fixed-point decoder): dividing by 2^24 gives a
 * float in [-1, 1[. `exponent` (0-24, read per block) further reduces the
 * amplitude by a factor of 2^exponent BEFORE this division — it's the AC-3
 * exponent that carries most of the dynamic range, the mantissa only the
 * fine precision.
 */

/** (code − levels/2) × 2²⁴ / levels — Section 7.3.3. */
function dequantizeSymmetric(code: number, levels: number): number {
  return Math.trunc(((code - (levels >> 1)) * (1 << 24)) / levels);
}

/** 3-in-5-bit table (bap 1): ff_ac3_ungroup_3_in_5_bits_tab. */
const UNGROUP_3_IN_5 = Array.from({ length: 32 }, (_, i) => [
  Math.trunc(i / 9),
  Math.trunc((i % 9) / 3),
  (i % 9) % 3,
]);

/** 3-in-7-bit table (bap 2, and the exponents in trame.ts). */
const UNGROUP_3_IN_7 = Array.from({ length: 128 }, (_, i) => [
  Math.trunc(i / 25),
  Math.trunc((i % 25) / 5),
  (i % 25) % 5,
]);

const BAP1: readonly (readonly [number, number, number])[] = UNGROUP_3_IN_5.map(
  ([a, b, c]) => [dequantizeSymmetric(a, 3), dequantizeSymmetric(b, 3), dequantizeSymmetric(c, 3)],
);

const BAP2: readonly (readonly [number, number, number])[] = UNGROUP_3_IN_7.map(
  ([a, b, c]) => [dequantizeSymmetric(a, 5), dequantizeSymmetric(b, 5), dequantizeSymmetric(c, 5)],
);

/** Table 7.21 — bap 3, 7 levels, DIRECT mantissa (not grouped). */
const BAP3: readonly number[] = Array.from({ length: 7 }, (_, i) => dequantizeSymmetric(i, 7));

const BAP4: readonly (readonly [number, number])[] = Array.from({ length: 128 }, (_, i) => [
  dequantizeSymmetric(Math.trunc(i / 11), 11),
  dequantizeSymmetric(i % 11, 11),
]);

/** Table 7.23 — bap 5, 15 levels, DIRECT mantissa (not grouped). */
const BAP5: readonly number[] = Array.from({ length: 15 }, (_, i) => dequantizeSymmetric(i, 15));

/** Table 7.18 — bits to read directly for bap 6-15 (asymmetric). */
const BITS_ASYMMETRIC = [0, 0, 0, 0, 0, 0, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16] as const;

/**
 * State of grouped mantissas, SHARED BY AN ENTIRE BLOCK — channels,
 * coupling AND LFE included — and reset only at the next block: bap 1/2/4
 * read one word for 2-3 values, and a remainder left by one channel is
 * consumed by the very first coefficient of the same bap encountered next,
 * even if that's already the following channel (see `mant_groups` in
 * ac3dec.c, passed by pointer to every channel of the block — never reset
 * between two channels).
 */
export function freshMantissaState() {
  return {
    b1: 0,
    b1Mant: [0, 0] as [number, number],
    b2: 0,
    b2Mant: [0, 0] as [number, number],
    b4: 0,
    b4Mant: 0,
  };
}
export type MantissaState = ReturnType<typeof freshMantissaState>;

/**
 * Reads ONE mantissa for `bap`, advances the reader by as many bits as
 * needed (0 for bap 0, or by pulling from the grouped state without
 * reading anything), and returns its dequantized value (signed 24-bit
 * scale, before division by the exponent).
 */
export function readMantissa(r: BitReader, bap: number, state: MantissaState): number {
  switch (bap) {
    case 0:
      // Dither noise in a real decoder; 0 is an acceptable quantization
      // silence for a first version — no bits to read either way.
      return 0;
    case 1:
      if (state.b1 > 0) {
        state.b1--;
        return state.b1Mant[state.b1];
      } else {
        const word = r.read(5);
        const [a, b, c] = BAP1[word];
        state.b1Mant = [c, b];
        state.b1 = 2;
        return a;
      }
    case 2:
      if (state.b2 > 0) {
        state.b2--;
        return state.b2Mant[state.b2];
      } else {
        const word = r.read(7);
        const [a, b, c] = BAP2[word];
        state.b2Mant = [c, b];
        state.b2 = 2;
        return a;
      }
    case 3:
      return BAP3[r.read(3)];
    case 4:
      if (state.b4 > 0) {
        state.b4 = 0;
        return state.b4Mant;
      } else {
        const word = r.read(7);
        const [a, b] = BAP4[word];
        state.b4Mant = b;
        state.b4 = 1;
        return a;
      }
    case 5:
      return BAP5[r.read(4)];
    default: {
      // 6-15: direct, two's complement, scaled to 24 bits by left shift.
      const bits = BITS_ASYMMETRIC[bap] ?? 16;
      return r.readSigned(bits) << (24 - bits);
    }
  }
}
