import {
  BAPTAB,
  BNDSZ,
  BNDTAB,
  DBPBTAB,
  FASTDEC,
  FLOORTAB,
  HTH,
  LATAB,
  SLOWDEC,
  SLOWGAIN,
} from "./tables.js";

/**
 * AC-3 bit allocation — a FAITHFUL transcription of the pseudo-code from the
 * ATSC A/52:2018 standard, §7.2.2.
 *
 * THIS IS THE FRAGILE CORE OF THE DECODER. This routine doesn't produce
 * sound: it says, for each frequency coefficient, HOW MANY BITS its
 * mantissa occupies in the stream. The encoder did exactly the same
 * calculation. A single unit of drift on a single band, and the next
 * mantissa gets read at the wrong spot: the rest of the frame becomes
 * noise. This isn't degraded, it's lost.
 *
 * A first version written "from memory" overflowed by several thousand bits
 * per frame — hence this literal transcription, including the `lowcomp`
 * mechanism that intuition doesn't guess.
 */

export type AllocationParams = {
  sdcycod: number;
  fdcycod: number;
  sgaincod: number;
  dbpbcod: number;
  floorcod: number;
};

export const DEFAULT_PARAMS: AllocationParams = {
  sdcycod: 2,
  fdcycod: 1,
  sgaincod: 1,
  dbpbcod: 2,
  floorcod: 7,
};

/** masktab: bin → masking band. Derived from BNDTAB/BNDSZ, so never wrong. */
const MASKTAB = (() => {
  const t = new Uint8Array(256);
  for (let bnd = 0; bnd < 50; bnd++) {
    for (let k = 0; k < BNDSZ[bnd]; k++) t[BNDTAB[bnd] + k] = bnd;
  }
  return t;
})();

export type AllocationEntry = {
  exp: Int16Array;
  start: number;
  end: number;
  /** FASTGAIN[fgaincod]. */
  fgain: number;
  /** (((csnroffst − 15) << 4) + fsnroffst) << 2 */
  snroffset: number;
  /** Initial leaks of the coupling channel, already shifted (`(cplfleak << 8) + 768`). */
  fastleak?: number;
  slowleak?: number;
  /** Per-band delta adjustment, when `deltbae` is 0 or 1. */
  deltba?: Int8Array;
  fscod: number;
  params: AllocationParams;
  /** Coupling channel: the curve starts at `bndstrt`, with no low-frequency compensation. */
  isCoupling?: boolean;
};

/** §7.2.2.4 — low-frequency compensation, which the ear masks poorly. */
function calcLowcomp(a: number, b0: number, b1: number, bin: number): number {
  if (bin < 7) {
    // The standard writes `if ((b0 + 256) == b1) ;` — the semicolon is a
    // known typo in the document: the assignment that follows is indeed
    // conditional.
    if (b0 + 256 === b1) return 384;
    if (b0 > b1) return Math.max(0, a - 64);
    return a;
  }
  if (bin < 20) {
    if (b0 + 256 === b1) return 320;
    if (b0 > b1) return Math.max(0, a - 64);
    return a;
  }
  return Math.max(0, a - 128);
}

/** Logarithmic addition (§7.2.2.3). */
function logadd(a: number, b: number): number {
  const c = a - b;
  const address = Math.min(Math.abs(c) >> 1, 255);
  return c >= 0 ? a + LATAB[address] : b + LATAB[address];
}

/**
 * −960 = `((0 − 15) << 4 + 0) << 2`: `csnroffst` AND the fine offset both
 * zero — not a normal case of the calculation, a SPECIAL CODE from the
 * standard (`ac3_bit_alloc_calc_bap_c`, ac3dsp.c) that mutes the whole
 * channel: bap forced to 0 everywhere, without going through the masking
 * curve. Missed here, the normal formula computes non-zero bap for this
 * case — so mantissas get read where the encoder wrote NONE at all,
 * desyncing the rest of the block. `csnroffst`/`fsnroffst` default to 0
 * before any transmission: a channel (or the coupling channel) that stays
 * on this default hits this case directly.
 */
const SNROFFSET_MUTE = -960;

export function allocate(e: AllocationEntry, bap: Uint8Array): Uint8Array {
  const { exp, start, end, fscod, params } = e;
  if (end <= start) return bap;
  if (e.snroffset === SNROFFSET_MUTE) {
    bap.fill(0);
    return bap;
  }

  const sdecay = SLOWDEC[params.sdcycod];
  const fdecay = FASTDEC[params.fdcycod];
  const sgain = SLOWGAIN[params.sgaincod];
  const dbknee = DBPBTAB[params.dbpbcod];
  const floor = FLOORTAB[params.floorcod];

  // --- §7.2.2.2 psd ---
  const psd = new Int32Array(end);
  for (let bin = start; bin < end; bin++) psd[bin] = 3072 - (exp[bin] << 7);

  // --- §7.2.2.3 per-band integration ---
  const bndpsd = new Int32Array(50);
  let j = start;
  let k = MASKTAB[start];
  let lastbin = 0;
  do {
    lastbin = Math.min(BNDTAB[k] + BNDSZ[k], end);
    bndpsd[k] = psd[j];
    j++;
    for (let i = j; i < lastbin; i++) {
      bndpsd[k] = logadd(bndpsd[k], psd[j]);
      j++;
    }
    k++;
  } while (end > lastbin);

  // --- §7.2.2.4 excitation ---
  const bndstrt = MASKTAB[start];
  const bndend = MASKTAB[end - 1] + 1;
  const excite = new Int32Array(50);
  let fastleak = 0;
  let slowleak = 0;
  let lowcomp = 0;
  let begin: number;

  if (bndstrt === 0) {
    // Full-bandwidth and LFE channels: the first 7 bands get special
    // treatment, with the `lowcomp` compensation.
    lowcomp = calcLowcomp(lowcomp, bndpsd[0], bndpsd[1], 0);
    excite[0] = bndpsd[0] - e.fgain - lowcomp;
    lowcomp = calcLowcomp(lowcomp, bndpsd[1], bndpsd[2], 1);
    excite[1] = bndpsd[1] - e.fgain - lowcomp;
    begin = 7;

    for (let bin = 2; bin < 7; bin++) {
      // The last LFE band (bin 6) is excluded: it has no following band.
      if (bndend !== 7 || bin !== 6) {
        lowcomp = calcLowcomp(lowcomp, bndpsd[bin], bndpsd[bin + 1], bin);
      }
      fastleak = bndpsd[bin] - e.fgain;
      slowleak = bndpsd[bin] - sgain;
      excite[bin] = fastleak - lowcomp;
      if (bndend !== 7 || bin !== 6) {
        if (bndpsd[bin] <= bndpsd[bin + 1]) {
          begin = bin + 1;
          break;
        }
      }
    }

    for (let bin = begin; bin < Math.min(bndend, 22); bin++) {
      if (bndend !== 7 || bin !== 6) {
        lowcomp = calcLowcomp(lowcomp, bndpsd[bin], bndpsd[bin + 1], bin);
      }
      fastleak = Math.max(fastleak - fdecay, bndpsd[bin] - e.fgain);
      slowleak = Math.max(slowleak - sdecay, bndpsd[bin] - sgain);
      excite[bin] = Math.max(fastleak - lowcomp, slowleak);
    }
    begin = 22;
  } else {
    // Coupling channel: it inherits the leaks transmitted in the stream.
    fastleak = e.fastleak ?? 0;
    slowleak = e.slowleak ?? 0;
    begin = bndstrt;
  }

  for (let bin = begin; bin < bndend; bin++) {
    fastleak = Math.max(fastleak - fdecay, bndpsd[bin] - e.fgain);
    slowleak = Math.max(slowleak - sdecay, bndpsd[bin] - sgain);
    excite[bin] = Math.max(fastleak, slowleak);
  }

  // --- §7.2.2.5 masking curve ---
  const mask = new Int32Array(50);
  for (let bin = bndstrt; bin < bndend; bin++) {
    if (bndpsd[bin] < dbknee) excite[bin] += (dbknee - bndpsd[bin]) >> 2;
    mask[bin] = Math.max(excite[bin], HTH[fscod][bin]);
  }

  // --- §7.2.2.6 delta adjustments ---
  if (e.deltba) {
    for (let bnd = bndstrt; bnd < bndend; bnd++) {
      const d = e.deltba[bnd];
      if (d) mask[bnd] += d * 128;
    }
  }

  // --- §7.2.2.7 bap ---
  let i = start;
  j = MASKTAB[start];
  do {
    lastbin = Math.min(BNDTAB[j] + BNDSZ[j], end);
    mask[j] -= e.snroffset;
    mask[j] -= floor;
    if (mask[j] < 0) mask[j] = 0;
    mask[j] &= 0x1fe0;
    mask[j] += floor;
    for (; i < lastbin; i++) {
      let address = (psd[i] - mask[j]) >> 5;
      address = Math.min(63, Math.max(0, address));
      bap[i] = BAPTAB[address];
    }
    j++;
  } while (end > lastbin);

  return bap;
}

/**
 * Number of bits of a DIRECT (ungrouped) mantissa given its `bap`
 * (Table 7.18 — Mapping of bap to Quantizer). bap 1, 2, 4 are grouped (see
 * [GROUPS], ignore this table). bap 0 has no mantissa in the stream.
 *
 * BUG FIXED (2026-08-06): bap=3 and bap=5 were 0 here — treated as grouped
 * when they actually read a DIRECT mantissa of 3 and 4 bits respectively
 * (checked against `ac3_decode_transform_coeffs_ch` in
 * ffmpeg/libavcodec/ac3dec.c: `case 3: get_bits(gbc, 3)`, `case 5:
 * get_bits(gbc, 4)`, neither one in `GROUPS`). Result: every bap=3 or bap=5
 * encountered skipped 0 bit instead of 3 or 4 — a deficit that accumulates
 * and desyncs the rest of the frame. bap 6-15 remain the
 * `ff_ac3_quantization_tab[6..15]` table (5,6,7,8,9,10,11,12,14,16),
 * unchanged — that part was already correct.
 */
export const MANTISSA_BITS = [0, 0, 0, 3, 0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16] as const;

/**
 * Grouped mantissas: bap 1, 2 and 4 pack several values into a single word,
 * to avoid wasting bits on quantizers with few levels.
 *   bap 1 → 3 values in 5 bits · bap 2 → 3 in 7 bits · bap 4 → 2 in 7 bits
 */
export const GROUPS: Record<number, { perGroup: number; bits: number; levels: number }> = {
  1: { perGroup: 3, bits: 5, levels: 3 },
  2: { perGroup: 3, bits: 7, levels: 5 },
  4: { perGroup: 2, bits: 7, levels: 11 },
};
