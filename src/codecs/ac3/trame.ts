import { BitReader } from "./bits.js";
import { allocate, DEFAULT_PARAMS, type AllocationParams } from "./bitalloc.js";
import { CHANNELS_BY_ACMOD, BITRATES_KBPS, FASTGAIN, FREQUENCIES, WORD_SIZE_44_1 } from "./tables.js";
import { freshMantissaState, readMantissa } from "./mantisse.js";

/**
 * Parsing of an AC-3 frame: syncinfo, BSI, then the 6 audio blocks.
 *
 * The goal of this module is not yet to produce sound, but to READ
 * exactly — exponents, bit allocation, mantissas — consuming the right
 * number of bits. This is the risky half of the decoder: synthesis
 * (IMDCT, windowing) is classic DSP, whereas here the smallest one-bit
 * error irreversibly desyncs everything.
 */

export const SYNCWORD = 0x0b77;
/** 6 blocks of 256 samples: an AC-3 frame is always 1536 samples. */
export const SAMPLES_PER_FRAME = 1536;
export const BLOCKS_PER_FRAME = 6;
/** Table 7.5.4 — bounds of the 4 stereo rematrixing bands, in bins. */
const REMATRIXING_BANDS = [13, 25, 37, 61, 253] as const;

export type FrameHeader = {
  fscod: number;
  frequency: number;
  frmsizecod: number;
  /** Frame size in bytes. */
  sizeBytes: number;
  bsid: number;
  bsmod: number;
  acmod: number;
  lfeon: boolean;
  /** Full-bandwidth channels (excluding LFE). */
  channels: number;
  dialnorm: number;
};

/**
 * Size of a frame, in 16-bit words (Table 5.18).
 *
 * This is NOT a simple `ceil`: at 44.1 kHz [WORD_SIZE_44_1] (`tables.ts`)
 * tabulates the two sizes (frmsizecod parity) measured for each of the 19
 * bitrates — see its comment for why a derived formula turned out to be
 * wrong by a factor of ~70.
 */
export function frameSizeWords(fscod: number, frmsizecod: number): number {
  const index = frmsizecod >> 1;
  const kbps = BITRATES_KBPS[index];
  if (kbps === undefined) return 0;
  if (fscod === 0) return 2 * kbps; // 48 kHz
  if (fscod === 2) return 3 * kbps; // 32 kHz
  const pair = WORD_SIZE_44_1[index];
  if (!pair) return 0;
  return pair[frmsizecod & 1];
}

/** Reads syncinfo + BSI. Returns null if the frame isn't usable. */
export function readHeader(r: BitReader): FrameHeader | null {
  if (r.read(16) !== SYNCWORD) return null;
  r.skip(16); // crc1

  const fscod = r.read(2);
  if (fscod === 3) return null; // reserved
  const frmsizecod = r.read(6);
  if (frmsizecod > 37) return null;

  const bsid = r.read(5);
  // bsid 16 = E-AC-3, whose syntax differs entirely. We don't pretend to support it.
  if (bsid > 8) return null;
  const bsmod = r.read(3);
  const acmod = r.read(3);

  if ((acmod & 0x1) !== 0 && acmod !== 0x1) r.skip(2); // cmixlev
  if ((acmod & 0x4) !== 0) r.skip(2); // surmixlev
  if (acmod === 0x2) r.skip(2); // dsurmod
  const lfeon = r.flag();
  const dialnorm = r.read(5);
  if (r.flag()) r.skip(8); // compr
  if (r.flag()) r.skip(8); // langcod
  if (r.flag()) r.skip(7); // mixlevel(5) + roomtyp(2)

  if (acmod === 0) {
    // 1+1 mode: two independent mono programs, each with its own fields.
    r.skip(5); // dialnorm2
    if (r.flag()) r.skip(8); // compr2
    if (r.flag()) r.skip(8); // langcod2
    if (r.flag()) r.skip(7); // mixlevel2 + roomtyp2
  }

  r.skip(2); // copyrightb + origbs
  if (r.flag()) r.skip(14); // timecod1
  if (r.flag()) r.skip(14); // timecod2
  if (r.flag()) {
    const addbsil = r.read(6);
    r.skip((addbsil + 1) * 8);
  }

  return {
    fscod,
    frequency: FREQUENCIES[fscod],
    frmsizecod,
    sizeBytes: frameSizeWords(fscod, frmsizecod) * 2,
    bsid,
    bsmod,
    acmod,
    lfeon,
    channels: CHANNELS_BY_ACMOD[acmod],
    dialnorm,
  };
}

const EXP_REUSE = 0;
const EXP_D15 = 1;
const EXP_D25 = 2;
const EXP_D45 = 3;

/**
 * Decodes a group of differential exponents.
 *
 * Exponents are coded as successive differences, three per 7-bit word
 * (values 0..124 → 3 base-5 digits, offset by 2). Depending on the
 * strategy, each difference applies to 1, 2 or 4 consecutive bins.
 *
 * `rawBin`: does `first` (the ABSOLUTE, non-differential value) occupy ITS
 * OWN bin before the differential chain starts at the next bin?
 * REGRESSION HIT LIVE — coupling channel broken while channel/LFE worked:
 * `decode_exponents` (ac3dec.c) always writes into `&dexps[ch][start_freq[ch]
 * + !!ch]`. For a normal channel or the LFE (`ch != 0`), `!!ch == 1`: `first`
 * stays alone at bin 0 (already written by the caller BEFORE the call), the
 * differential chain starts at bin 1 — exactly what this function does with
 * `rawBin=true`. For coupling (`ch == CPL_CH == 0`), `!!ch == 0`: the
 * differential chain writes STARTING AT `start_freq[CPL_CH]`, with no
 * separate bin for the absolute value — `rawBin=false`. Conflating the two
 * meant ALL coupling bins were shifted one position relative to the encoder:
 * psd then bap wrong across the whole coupling width, while channel/LFE
 * (`start` always 0 for them) couldn't reveal the bug — never covered by
 * the tests (mono never enables coupling).
 */
function readExponents(
  r: BitReader,
  strategy: number,
  groupCount: number,
  first: number,
  output: Int16Array,
  start: number,
  rawBin: boolean,
): void {
  let exp = first;
  let bin = start;
  if (rawBin) {
    output[start] = exp;
    bin = start + 1;
  }
  const repeat = strategy === EXP_D15 ? 1 : strategy === EXP_D25 ? 2 : 4;

  for (let g = 0; g < groupCount; g++) {
    const word = r.read(7);
    // Three differences packed in base 5, biased by +2.
    const d = [Math.floor(word / 25), Math.floor(word / 5) % 5, word % 5];
    for (let k = 0; k < 3; k++) {
      exp += d[k] - 2;
      // An exponent outside [0,24]: the stream is corrupt, we clamp rather
      // than propagate an absurd value into the allocation.
      if (exp < 0) exp = 0;
      else if (exp > 24) exp = 24;
      for (let j = 0; j < repeat && bin < output.length; j++) output[bin++] = exp;
    }
  }
}

/**
 * Number of exponent words for a full-bandwidth channel (standard §5.4.2.7).
 *
 * This is NOT a simple `ceil`: the standard truncates after adding a bias
 * that differs by strategy (+3 in D25, +9 in D45). An earlier version using
 * `ceil` read one word too many for certain band widths — a 7-bit shift
 * that ruined the rest of the frame.
 */
function groupCountForChannel(strategy: number, endmant: number): number {
  if (strategy === EXP_D15) return Math.trunc((endmant - 1) / 3);
  if (strategy === EXP_D25) return Math.trunc((endmant - 1 + 3) / 6);
  return Math.trunc((endmant - 1 + 9) / 12);
}

/**
 * Coupling channel (§7.4.2, `num_exp_groups[CPL_CH]` in ac3dec.c): the same
 * integer truncation as `groupCountForChannel` (C-style division, not
 * float) — the range is NOT always an exact multiple of the divisor
 * (`ncplsubnd` can merge subbands via `cplbndstrc`), so without
 * `Math.trunc` a nonzero remainder caused one too many exponent words to be
 * read.
 */
function groupCountForCoupling(strategy: number, binCount: number): number {
  return Math.trunc(binCount / (strategy === EXP_D15 ? 3 : strategy === EXP_D25 ? 6 : 12));
}

/**
 * Dequantization of a coupling coordinate (§7.4.3) — a GAIN, not a
 * frequency coefficient: 4-bit mantissa normalized to [16,31] (implicit bit
 * like a float), shifted by the 4-bit exponent + the 2-bit common master
 * (`mstrcplco × 3`). `exp==15` is a special case (denormalized value,
 * without the +16). Checked against `coupling_coordinates` (ac3dec.c) —
 * same formula as mantissa dequantization (`mantisse.ts`): a signed
 * integer, to be divided by 2²⁴ for a [-1,1[ float.
 */
function couplingCoordinate(exp: number, mant: number, master: number): number {
  const base = exp === 15 ? mant << 22 : (mant + 16) << 21;
  return base >> (exp + master);
}

export type FrameResult = {
  header: FrameHeader;
  /** Reader position at the end of each block — used for diagnostics. */
  blockPositions: number[];
  /** Reader position at the end of parsing, in bits from the start of the frame. */
  bitsConsumed: number;
  /** Total number of mantissas read, across all channels and blocks. */
  mantissas: number;
  /**
   * Dequantized frequency coefficients (mantissa ≫ exponent), per block
   * then per channel — 256 bins, zero beyond `endmant[channel]`. This is
   * the INPUT of the IMDCT (`synthese.ts`), not sound yet: the time-domain
   * synthesis (transform + window + overlap-add) is still to be done.
   */
  coefficientsPerBlock: Float64Array[][];
};

/**
 * Parses a complete frame, consumes all its fields, AND dequantizes the
 * mantissas into coefficients (`mantisse.ts`) — in the same pass as the
 * bit-exact verification, so there is never two implementations of the
 * parsing that could diverge.
 */
export function decodeFrame(data: Uint8Array): FrameResult | null {
  const r = new BitReader(data);
  const header = readHeader(r);
  if (!header) return null;

  const { acmod, lfeon, fscod } = header;
  const nch = header.channels;
  let mantissasRead = 0;
  const blockPositions: number[] = [];
  const coefficientsPerBlock: Float64Array[][] = [];

  // State persistent across blocks — AC-3 reuses a lot from one block to the next.
  let cplinu = false;
  const chincpl = new Array<boolean>(nch).fill(false);
  let cplbegf = 0;
  let cplendf = 0;
  let ncplbnd = 0;
  let ncplsubnd = 0;
  const cplbndstrc = new Array<number>(18).fill(0);
  /** Starting bin of each coordinate band, plus an end bound — recomputed whenever `cplbndstrc` changes. */
  let cplBandStart: number[] = [];
  /** Current coupling coordinate per channel and per band (§7.4.3) — PERSISTENT: a channel that doesn't retransmit `cplcoe` this block reuses the last one received. */
  const cplco: number[][] = Array.from({ length: nch }, () => new Array<number>(18).fill(0));
  /** Phase flag per band (stereo only) — PERSISTENT like `cplco`. */
  const phsflg: boolean[] = new Array(18).fill(false);
  let params: AllocationParams = { ...DEFAULT_PARAMS };
  let phsflginu = false;
  /**
   * Stereo rematrixing flags (acmod=2) — PERSISTENT like everything else: a
   * block that doesn't retransmit `rematstr` reuses those from the
   * previous block, never implicitly reset to false. Regression hit live:
   * until now these bits were skipped WITHOUT being kept or applied — the
   * left/right channel stayed sum/difference instead of L/R whenever the
   * encoder had rematrixed, which to the ear sounds saturated/crackly on a
   * real stereo file (never covered by the tests, which are mono).
   */
  const rematflg: boolean[] = [false, false, false, false];
  /**
   * Number of rematrixing bands CURRENTLY in effect — PERSISTENT on the
   * same basis as `rematflg`. Pitfall hit live: `do_rematrixing` (ac3dec.c)
   * applies ONLY `s->num_rematrixing_bands` bands, not systematically all
   * 4 — a block that does NOT retransmit `rematstr` reuses the count from
   * the previous block (often reduced by coupling, §7.5.4), so hardcoding
   * all 4 bands would have rematrixed a high band that the encoder had
   * deliberately left out of rematrixing this time.
   */
  let nrematbnd = 4;

  /**
   * STATE PERSISTENT ACROSS BLOCKS — this is the whole spirit of AC-3: a
   * block that doesn't transmit a parameter reuses the previous one's.
   * `snroffste = 0` doesn't mean "zero offset", it means "same as before".
   *
   * Resetting these to zero on every block produced a wrong allocation
   * starting at block 1 (block 0 stayed correct, which made the bug hard
   * to see): measured at 4422 bits consumed where ~1011 were expected.
   */
  let csnroffst = 0;
  const fsnroffst = new Array<number>(nch).fill(0);
  const fgaincod = new Array<number>(nch).fill(0);
  let cplfsnroffst = 0;
  let cplfgaincod = 0;
  let lfefsnroffst = 0;
  let lfefgaincod = 0;
  let cplfleak = 0;
  let cplsleak = 0;
  const deltba: (Int8Array | undefined)[] = new Array(nch).fill(undefined);
  let couplingDeltba: Int8Array | undefined;

  const chbwcod = new Array<number>(nch).fill(0);
  const endmant = new Array<number>(nch).fill(0);
  const exponents: Int16Array[] = Array.from({ length: nch }, () => new Int16Array(256));
  const cplExponents = new Int16Array(256);
  const lfeExponents = new Int16Array(256);
  const channelBap: Uint8Array[] = Array.from({ length: nch }, () => new Uint8Array(256));
  const cplBap = new Uint8Array(256);
  const lfeBap = new Uint8Array(256);
  /** Dequantized coefficients of the coupling channel — reset to zero every block, distributed to the coupled channels right after the mantissas are read. */
  const cplCoeffs = new Float64Array(256);

  for (let blk = 0; blk < BLOCKS_PER_FRAME; blk++) {
    for (let ch = 0; ch < nch; ch++) r.skip(1); // blksw
    for (let ch = 0; ch < nch; ch++) r.skip(1); // dithflag
    if (r.flag()) r.skip(8); // dynrng
    if (acmod === 0 && r.flag()) r.skip(8); // dynrng2

    if (r.flag()) {
      // cplstre: the coupling structure is (re)defined
      cplinu = r.flag();
      if (cplinu) {
        for (let ch = 0; ch < nch; ch++) chincpl[ch] = r.flag();
        if (acmod === 0x2) phsflginu = r.flag();
        cplbegf = r.read(4);
        cplendf = r.read(4);
        ncplsubnd = 3 + cplendf - cplbegf;
        ncplbnd = ncplsubnd;
        for (let bnd = 1; bnd < ncplsubnd; bnd++) {
          cplbndstrc[bnd] = r.flag() ? 1 : 0;
          ncplbnd -= cplbndstrc[bnd];
        }
        // Bin bounds of each COORDINATE band (distinct from the exponent
        // bands): each subchannel is 12 bins wide; `cplbndstrc[sub]` true
        // merges subchannel `sub` into the previous band instead of opening
        // a new one (§7.4.3, `decode_band_structure` with `ecpl=0`).
        const start = 37 + 12 * cplbegf;
        cplBandStart = [start];
        for (let sub = 1; sub < ncplsubnd; sub++) {
          if (!cplbndstrc[sub]) cplBandStart.push(start + 12 * sub);
        }
        cplBandStart.push(start + 12 * ncplsubnd);
      }
    }

    if (cplinu) {
      let cplcoeSet = false;
      for (let ch = 0; ch < nch; ch++) {
        if (!chincpl[ch]) continue;
        if (r.flag()) {
          cplcoeSet = true;
          const master = 3 * r.read(2); // mstrcplco
          for (let bnd = 0; bnd < ncplbnd; bnd++) {
            const exp = r.read(4); // cplcoexp
            const mant = r.read(4); // cplcomant
            cplco[ch][bnd] = couplingCoordinate(exp, mant, master);
          }
        }
      }
      // Unlike `cplco` (which stays as-is when not retransmitted), a
      // FRESHLY read set of coordinates (`cplcoeSet`) ALWAYS resets the
      // phase flags to false when `phsflginu` is false this frame — this
      // isn't just a skipped bit, `coupling_coordinates` (ac3dec.c)
      // explicitly writes `phase_flags[bnd] = phase_flags_in_use ?
      // get_bits1() : 0`. Without this `else`, a frame that had used phase
      // and then disabled it would have kept the last flag seen.
      if (acmod === 0x2 && cplcoeSet) {
        for (let bnd = 0; bnd < ncplbnd; bnd++) phsflg[bnd] = phsflginu ? r.flag() : false;
      }
    }

    if (acmod === 0x2 && r.flag()) {
      // rematstr: rematrixing bands, their count depends on coupling.
      nrematbnd = !cplinu ? 4 : cplbegf === 0 ? 2 : cplbegf <= 2 ? 3 : 4;
      for (let b = 0; b < nrematbnd; b++) rematflg[b] = r.flag();
    }

    const cplexpstr = cplinu ? r.read(2) : EXP_REUSE;
    const chexpstr = new Array<number>(nch);
    for (let ch = 0; ch < nch; ch++) chexpstr[ch] = r.read(2);
    const lfeexpstr = lfeon ? r.read(1) : EXP_REUSE;

    for (let ch = 0; ch < nch; ch++) {
      if (chexpstr[ch] === EXP_REUSE) continue;
      if (chincpl[ch]) {
        endmant[ch] = 37 + 12 * cplbegf; // coupling takes over from here
      } else {
        chbwcod[ch] = r.read(6);
        endmant[ch] = 37 + 3 * (chbwcod[ch] + 12);
      }
    }

    // --- Coupling channel exponents ---
    const cplstrtmant = 37 + 12 * cplbegf;
    const cplendmant = 37 + 12 * (cplendf + 3);
    if (cplinu && cplexpstr !== EXP_REUSE) {
      const binCount = cplendmant - cplstrtmant;
      const first = r.read(4) << 1; // cplabsexp, double scale
      const groups = groupCountForCoupling(cplexpstr, binCount);
      readExponents(r, cplexpstr, groups, first, cplExponents, cplstrtmant, false);
    }

    // --- Channel exponents ---
    for (let ch = 0; ch < nch; ch++) {
      if (chexpstr[ch] === EXP_REUSE) continue;
      const first = r.read(4);
      const groups = groupCountForChannel(chexpstr[ch], endmant[ch]);
      readExponents(r, chexpstr[ch], groups, first, exponents[ch], 0, true);
      r.skip(2); // gainrng
    }

    // --- LFE exponents (always 7 bins) ---
    if (lfeon && lfeexpstr !== EXP_REUSE) {
      const first = r.read(4);
      // nlfegrps is always 2: the LFE is 7 bins in D15.
      readExponents(r, EXP_D15, 2, first, lfeExponents, 0, true);
    }

    // --- Allocation parameters ---
    if (r.flag()) {
      params = {
        sdcycod: r.read(2),
        fdcycod: r.read(2),
        sgaincod: r.read(2),
        dbpbcod: r.read(2),
        floorcod: r.read(3),
      };
    }

    if (r.flag()) {
      csnroffst = r.read(6);
      if (cplinu) {
        cplfsnroffst = r.read(4);
        cplfgaincod = r.read(3);
      }
      for (let ch = 0; ch < nch; ch++) {
        fsnroffst[ch] = r.read(4);
        fgaincod[ch] = r.read(3);
      }
      if (lfeon) {
        lfefsnroffst = r.read(4);
        lfefgaincod = r.read(3);
      }
    }

    if (cplinu && r.flag()) {
      cplfleak = r.read(3);
      cplsleak = r.read(3);
    }

    // --- Allocation delta adjustments ---
    // ORDER IS CRUCIAL (§5.3.3): the standard first reads ALL `deltbae`
    // codes (coupling then each channel), and ONLY THEN the segments of
    // each. Interleaving them — reading one channel's code then its
    // segments — desyncs the stream as soon as a single channel carries
    // adjustments.
    if (r.flag()) {
      const cpldeltbae = cplinu ? r.read(2) : 2;
      const deltbae = new Array<number>(nch);
      for (let ch = 0; ch < nch; ch++) deltbae[ch] = r.read(2);

      /** Reads a channel's segments. `deltbae == 1` = new data. */
      const readSegments = (): Int8Array => {
        const nseg = r.read(3) + 1;
        const table = new Int8Array(50);
        let bnd = 0;
        for (let s = 0; s < nseg; s++) {
          bnd += r.read(5); // offset
          const length = r.read(4);
          const value = r.read(3);
          // NOT two's complement: 0..3 → −4..−1, 4..7 → +1..+4 (zero
          // deliberately absent). Checked against
          // `ff_ac3_bit_alloc_calc_mask` (ac3.c): `dba_values>=4 ? v-3 :
          // v-4`. An earlier version used true two's complement
          // (0..3→0..3, 4..7→−4..−1) — never exercised by the tests
          // (mono, no real encoder used delta bit allocation on the
          // existing fixtures).
          const adjustment = value >= 4 ? value - 3 : value - 4;
          for (let k = 0; k < length && bnd < 50; k++) table[bnd++] = adjustment;
        }
        return table;
      };

      if (cplinu) {
        if (cpldeltbae === 1) couplingDeltba = readSegments();
        else if (cpldeltbae === 2) couplingDeltba = undefined; // "no delta"
      }
      for (let ch = 0; ch < nch; ch++) {
        if (deltbae[ch] === 1) deltba[ch] = readSegments();
        else if (deltbae[ch] === 2) deltba[ch] = undefined;
      }
    }

    if (r.flag()) {
      // skiple: explicit padding field
      const skipl = r.read(9);
      r.skip(skipl * 8);
    }

    // --- Allocation, then mantissa reading ---
    // §7.2.2.1: (((csnroffst − 15) << 4) + fsnroffst) << 2
    const snr = (fine: number) => ((((csnroffst - 15) << 4) + fine) << 2);

    if (cplinu) {
      allocate(
        {
          exp: cplExponents,
          start: cplstrtmant,
          end: cplendmant,
          fgain: fastgainAt(cplfgaincod),
          snroffset: snr(cplfsnroffst),
          // (cplfleak << 8) + 768 — the constant comes from the standard
          // §7.2.2.1, it isn't a tunable.
          fastleak: (cplfleak << 8) + 768,
          slowleak: (cplsleak << 8) + 768,
          deltba: couplingDeltba,
          fscod,
          params,
          isCoupling: true,
        },
        cplBap,
      );
    }

    for (let ch = 0; ch < nch; ch++) {
      allocate(
        {
          exp: exponents[ch],
          start: 0,
          end: endmant[ch],
          fgain: fastgainAt(fgaincod[ch]),
          snroffset: snr(fsnroffst[ch]),
          deltba: deltba[ch],
          fscod,
          params,
        },
        channelBap[ch],
      );
    }

    if (lfeon) {
      allocate(
        {
          exp: lfeExponents,
          start: 0,
          end: 7,
          fgain: fastgainAt(lfefgaincod),
          snroffset: snr(lfefsnroffst),
          fscod,
          params,
        },
        lfeBap,
      );
    }

    // Mantissas arrive channel by channel; coupling is interleaved at the
    // first coupled channel that reaches its bound.
    //
    // `exp`/`output` are optional: the coupling channel does NOT yet have
    // a distribution to the coupled channels (`calc_transform_coeffs_cpl`
    // on the ffmpeg side — coupling coordinates are read but discarded
    // further up, see the `r.skip(8)` for `cplcoexp+cplcomant`): we
    // consume its bits to stay in sync, without producing coefficients
    // for it for now. A planned next step, not an oversight.
    //
    // `state` is SHARED across all calls within a single block (channels,
    // coupling, LFE) — never recreated between two channels. REGRESSION
    // HIT LIVE: an earlier version recreated a fresh state on EVERY call,
    // assuming a group (bap 1/2/4, 2-3 values per word) never crossed a
    // channel boundary. Wrong: `decode_transform_coeffs` (ac3dec.c)
    // declares `mant_groups m` ONCE per block and passes it by pointer to
    // EVERY channel (and to coupling) — a group remainder left by channel
    // 0 is indeed consumed by channel 1 before the latter reads a new
    // word. Invisible in mono (a single channel, never a boundary),
    // catastrophic in stereo: the number of words read by channel 1
    // depends on what channel 0 left behind, otherwise everything drifts
    // as soon as a range doesn't end exactly on a group boundary.
    const mantissaState = freshMantissaState();
    const consume = (bap: Uint8Array, start: number, end: number, exp?: Int16Array, output?: Float64Array) => {
      for (let bin = start; bin < end; bin++) {
        const b = bap[bin];
        if (b === 0) continue;
        mantissasRead++;
        const mantissa = readMantissa(r, b, mantissaState);
        if (output && exp) output[bin] = mantissa >> exp[bin];
      }
    };

    const blockCoeffs: Float64Array[] = Array.from({ length: nch }, () => new Float64Array(256));
    let couplingRead = false;
    for (let ch = 0; ch < nch; ch++) {
      consume(channelBap[ch], 0, endmant[ch], exponents[ch], blockCoeffs[ch]);
      if (cplinu && chincpl[ch] && !couplingRead) {
        consume(cplBap, cplstrtmant, cplendmant, cplExponents, cplCoeffs);
        couplingRead = true;
      }
    }
    if (lfeon) consume(lfeBap, 0, 7);

    // Distribution of the coupling channel (§7.4.3): AFTER dequantization,
    // BEFORE rematrixing — `calc_transform_coeffs_cpl` (ac3dec.c) runs
    // inside `decode_transform_coeffs`, and `do_rematrixing` only after it
    // returns. Each coordinate band multiplies the SHARED spectrum by a
    // gain specific to each coupled channel — this isn't one more
    // frequency coefficient, it's how the top of the spectrum (beyond a
    // channel's own bandwidth) gets reconstructed for that channel.
    if (cplinu) {
      for (let bnd = 0; bnd < ncplbnd; bnd++) {
        const startBin = cplBandStart[bnd];
        const endBin = cplBandStart[bnd + 1];
        for (let ch = 0; ch < nch; ch++) {
          if (!chincpl[ch]) continue;
          const gain = cplco[ch][bnd];
          for (let i = startBin; i < endBin; i++) {
            blockCoeffs[ch][i] = (cplCoeffs[i] * gain) / (1 << 23);
          }
          // Inverted phase (stereo only): the standard applies it only to
          // the second full-bandwidth channel (`ch==2` in ffmpeg's
          // 1-based indexing → our channel 1).
          if (acmod === 0x2 && ch === 1 && phsflg[bnd]) {
            for (let i = startBin; i < endBin; i++) blockCoeffs[ch][i] = -blockCoeffs[ch][i];
          }
        }
      }
    }

    // Stereo rematrixing (§7.5.4): AFTER dequantization, on the frequency
    // coefficients, before the IMDCT. `REMATRIXING_BANDS` = bin bounds
    // (standard Table 7.5.4, [13, 25, 37, 61, 253]).
    if (acmod === 0x2) {
      const end = Math.min(endmant[0], endmant[1]);
      for (let bnd = 0; bnd < nrematbnd; bnd++) {
        if (!rematflg[bnd]) continue;
        const startBin = REMATRIXING_BANDS[bnd];
        const endBin = Math.min(end, REMATRIXING_BANDS[bnd + 1]);
        for (let i = startBin; i < endBin; i++) {
          const g = blockCoeffs[0][i];
          blockCoeffs[0][i] = g + blockCoeffs[1][i];
          blockCoeffs[1][i] = g - blockCoeffs[1][i];
        }
      }
    }

    coefficientsPerBlock.push(blockCoeffs);
    blockPositions.push(r.position);
  }

  return {
    header,
    bitsConsumed: r.position,
    mantissas: mantissasRead,
    blockPositions,
    coefficientsPerBlock,
  };
}

/** FASTGAIN indexed, with a guard: the field is 3 bits, the table 8 entries. */
function fastgainAt(code: number): number {
  return FASTGAIN[code & 7];
}




/**
 * STATE — READING (syncinfo, BSI, blocks, exponents, allocation, bap) is
 * VERIFIED CORRECT. Measured on 2026-08-06, after two major bugs found by
 * checking the code, bit by bit, against the REAL ffmpeg/libavcodec source
 * (`ac3.c`, `ac3dec.c`, `ac3dsp.c`, `ac3dec_data.c` — not the model's
 * memory, the actual text):
 *
 *   6. `frameSizeWords` at 44.1 kHz used a derived formula that gave 6-7
 *      words (12-14 bytes) instead of ~417-418 (834-836 bytes) for a
 *      192 kb/s stream — a factor of ~70 error. EVERY frame at 44.1 kHz
 *      (the most common case) desynced right at the next syncword.
 *      Replaced with [WORD_SIZE_44_1] (`tables.ts`), measured by generating
 *      the 19 bitrates with `ffmpeg -c:a ac3` and counting the actual gap
 *      between syncwords — no more formula, a table like the others.
 *
 *   7. THE BUG THAT BLOCKED EVERYTHING: `MANTISSA_BITS[3]` and
 *      `MANTISSA_BITS[5]` (`bitalloc.ts`) were 0 — treated as GROUPED
 *      mantissas (like bap 1/2/4) when `ac3_decode_transform_coeffs_ch`
 *      (ac3dec.c) reads them DIRECTLY: `case 3: get_bits(gbc, 3)`, `case
 *      5: get_bits(gbc, 4)`. Every bap=3 or bap=5 encountered (frequent)
 *      skipped 0 bit instead of 3 or 4 → the rest of the frame drifted,
 *      with a misleading symptom (`cplinu=true` read on a MONO stream at
 *      block 2, even though `coupling_strategy()` explicitly forbids it
 *      outside stereo+ — proof that it was already a desync, not real
 *      data).
 *
 * MEASURED RESULT on a real stream (mono, 192 kb/s, 87 frames, extracted
 * from `h264-ac3.mkv` with `ffmpeg -c copy`): 1 → 85/87 frames aligned
 * (98%), ZERO overrun (reading past the frame). The remaining 2 have a
 * trailing remainder more generous than the verification threshold
 * (legitimate auxdata, probably), not an overrun — so not the same class
 * of bug. `test/ac3-trame.test.ts` locks all this down: frame size, the
 * bap→bits table, AND a block-by-block parse of the ENTIRE real fixture in
 * the repo, never reading past a frame.
 *
 * ────────────────────────────────────────────────────────────────────────
 * UPDATE 2026-08-06 (continued) — SOUND WORKS. Measured, not assumed.
 * ────────────────────────────────────────────────────────────────────────
 *
 * `mantisse.ts` (dequantization, Tables 7.19-7.23, tables generated like
 * ffmpeg's `ac3_init_static`) + `imdct.ts` (IMDCT 256→512 and the KBD
 * window α=5, VERIFIED in Python by perfect TDAC reconstruction — 1.9e-13
 * of deviation on a random signal, before the TypeScript version was even
 * written) + `synthese.ts` (overlap-add) now form a complete
 * coefficients → PCM chain. `consume()` above produces the coefficients
 * (`FrameResult.coefficientsPerBlock`), in the same pass as the bit-exact
 * verification — a single implementation of the parsing, never two that
 * could diverge.
 *
 * PROOF — not intuition: `test/ac3-synthese.test.ts` decodes the real
 * fixture in the repo (`h264-ac3.mkv`) end to end and compares, sample by
 * sample, against `ffmpeg -i h264-ac3.mkv -f f32le` (an INDEPENDENT
 * decoder — libavcodec, not us). Result: **correlation 0.9999999990**
 * (near-exact 1) once the priming delay of ONE block is removed (256
 * samples — the very first block decoded has no previous block for the
 * overlap-add, it's a fade-in that ffmpeg doesn't emit either, same
 * principle as AAC's "encoder delay" — not a bug).
 *
 * One constant wasn't derivable from reading the stream alone: the
 * absolute gain of the synthesis (TDAC reconstruction only fixes a
 * consistent internal ratio, not the gain the encoder actually used).
 * Measured empirically against this same ffmpeg reference: ×(−1/512) — a
 * clean factor, a power of 2, not a patch (see the `SCALE` constant in
 * `synthese.ts`).
 *
 * ────────────────────────────────────────────────────────────────────────
 * UPDATE 2026-08-07 — STEREO AND COUPLING. Mono couldn't reveal these bugs
 * (a single channel, never a boundary); wired into `player.ts`/
 * `audio-ac3.ts` (Web Audio API), the user heard a clear crackle/glitch on
 * real stereo content despite flawless mono. Two bugs found by checking,
 * once again, the REAL ffmpeg source (`ac3dec.c`, `ac3.c`, `ac3dsp.c` —
 * not memory):
 *
 *   8. THE MAIN BUG: the state of grouped mantissas (bap 1/2/4, one word
 *      shared by 2-3 values, `mantisse.ts`) was recreated FRESH on every
 *      call to `consume()` — one per channel, plus coupling. Wrong:
 *      `decode_transform_coeffs` (ac3dec.c) declares `mant_groups m` ONCE
 *      per BLOCK and passes it by pointer to EVERY channel (and to
 *      coupling) — a group remainder left by channel 0 must be consumed
 *      by channel 1 before the latter reads a single new word. Invisible
 *      in mono, systematic in stereo as soon as a range doesn't end
 *      exactly on a group boundary (nearly always): every channel after
 *      the first reads too many or too few words, and everything drifts.
 *      By itself: stereo stream WITHOUT coupling went from 22/58 aligned
 *      frames to 58/58, and audio correlation (channel by channel, against
 *      an independent ffmpeg PCM) from near 0 to 0.9999999959 — the same
 *      precision as mono.
 *
 *   9. The COUPLING channel read its exponents with the structure of
 *      normal channels (absolute value alone in its own bin, differential
 *      chain starting at the NEXT bin). Wrong specifically for it:
 *      `decode_exponents` writes into `&dexps[ch][start_freq[ch] + !!ch]`
 *      — `!!ch` is 1 for a normal channel (absolute value at bin 0, chain
 *      starting at bin 1: what this code already did) but 0 for coupling
 *      (`ch == CPL_CH == 0`: the differential chain starts AT the very
 *      first bin, no separate bin for the absolute value). All coupling
 *      exponents were therefore shifted by one position — psd then bap
 *      wrong across the whole coupling width. Fixed via the `rawBin`
 *      parameter of `readExponents`. On a stereo stream WITH forced
 *      coupling (`-channel_coupling 1`): 5/58 → 56/58 aligned frames, ZERO
 *      overrun (against tens of thousands of bits before).
 *
 * Besides these two, four more subtle bugs found in the same pass (none
 * blocked as much, but each would eventually have bitten on a real file):
 * `groupCountForCoupling` without `Math.trunc` (truncated C-style division,
 * not float — `bitalloc.ts`); the value→delta lookup table for delta bit
 * allocation was inverted (`ff_ac3_bit_alloc_calc_mask`, never triggered by
 * the ffmpeg encoder on our fixtures, hence invisible until now); the
 * special case `snroffset == −960` (channel muted by the standard,
 * `ac3_bit_alloc_calc_bap_c`) didn't exist, letting the normal formula
 * compute non-zero bap for a channel that should be silent; and
 * `s->num_rematrixing_bands` — the number of rematrixing bands APPLIED
 * (not just read) must stay the last transmitted value, not hardcoded 4.
 *
 * Coupling is now DISTRIBUTED, not just consumed: `calc_transform_
 * coeffs_cpl` (ac3dec.c) — each coordinate band multiplies the SHARED
 * spectrum of the coupling channel by a gain specific to each coupled
 * channel (`couplingCoordinate()`, fixed-point formula checked against
 * `MULH` + `mathops.h`), before stereo rematrixing (order matters:
 * coordinates then rematrixing, never the reverse). Proof, not intuition:
 * on a stereo+coupling stream of PINK NOISE (not a pure tone — real
 * content strength across the whole coupling width), correlation
 * 0.976 → 0.992 after the distribution. The remaining gap (0.992 instead
 * of 0.9999+) is NOT a coupling bug: a stereo pink-noise stream WITHOUT any
 * coupling plateaus at exactly the same correlation (~0.99) — it's
 * `mantisse.ts` (bap=0 rendered as 0 instead of the standard's random
 * dither noise, §7.3.4) showing up on wideband noise, not on a tone.
 * `test/ac3-stereo.test.ts` locks all this down: bit-exact alignment AND
 * correlation, on both cases (with and without coupling), on BOTH
 * channels.
 *
 * WHAT ACTUALLY REMAINS:
 *   - Dither noise (bap=0, §7.3.4): rendered as 0 instead of random noise
 *     — quantization silence instead of the slight expected hiss,
 *     especially visible on wideband content at a tight bitrate (see bug 9
 *     above). Quality, not sync: never made a single bit drift.
 *   - `block_switch` (128-point short blocks): read (`blksw`) but ignored
 *     — the IMDCT always assumes a 256-coefficient long block.
 *   - Real 5.1/multichannel: coupling is verified in stereo (acmod=2): the
 *     distribution above is generic (loops over `nch`), but no real 5.1
 *     fixture has exercised it yet. (Output channel order — bitstream acmod
 *     vs. WAV/Web Audio convention — IS handled now, see `downmix.ts`;
 *     this point is only about coupling's own decode correctness on a real
 *     5.1 stream, not about where the decoded channels end up.)
 *   - Performance: the IMDCT is O(N²) (precomputed cosine table, but no
 *     FFT) — correct before fast, to revisit if real-time playback
 *     struggles on an actual multichannel film.
 */
