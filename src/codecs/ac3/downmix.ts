/**
 * Downmixes AC-3's full-bandwidth channels (bitstream order, A/52 §6.1.2,
 * Table "Audio coding mode") to stereo.
 *
 * WHY THIS EXISTS — the Web Audio API only defines automatic up/down-mixing
 * for 1, 2, 4 or 6 discrete channels ("speakers" interpretation). A 5.1 AC-3
 * track decodes to 5 full-bandwidth channels (LFE excluded, never decoded —
 * see audio-ac3.ts); connected straight to a stereo destination, the browser
 * had no defined rule for 5 and fell back to a raw "discrete" mapping:
 * output channel 0 = input 0 (L), output channel 1 = input 1 — which for
 * acmod 7 (3/2, the common 5.1 layout: L, C, R, Ls, Rs) is the CENTER
 * channel, where nearly all dialogue lives. Symptom lived: dialogue audibly
 * coming out of the right speaker, R/Ls/Rs entirely dropped. Every acmod
 * with 3+ full-bandwidth channels was affected the same way, not just 5.1.
 *
 * Coefficients are the AC-3 spec's DEFAULT center/surround mix levels
 * (clev = slev = 0.707, "-3dB", A/52 §7.8.2 downmix equations) — `cmixlev`/
 * `surmixlev` are read from the header and discarded (see readHeader,
 * trame.ts) rather than applied per-frame. The default is by far the most
 * common encoded value; reading the other two levels per stream is a
 * possible future refinement, not attempted here.
 */

/** 10^(-3/20) — a -3dB voltage gain, the spec's default clev/slev. */
export const DEFAULT_MIX_LEVEL = 0.7071067811865476;

function mix(n: number, parts: [Float32Array, number][]): Float32Array {
  const out = new Float32Array(n);
  for (const [src, gain] of parts) {
    if (gain === 0) continue;
    for (let i = 0; i < n; i++) out[i] += src[i] * gain;
  }
  return out;
}

/**
 * @param acmod Bitstream audio coding mode (`FrameHeader.acmod`).
 * @param ch Full-bandwidth channels in bitstream order, one per index below.
 */
export function downmixToStereo(acmod: number, ch: readonly Float32Array[]): [Float32Array, Float32Array] {
  const n = ch[0]?.length ?? 0;
  const L = DEFAULT_MIX_LEVEL;
  switch (acmod) {
    case 1: // 1/0 — mono (C only): duplicate to both speakers.
      return [mix(n, [[ch[0], 1]]), mix(n, [[ch[0], 1]])];
    case 3: // 3/0 — L, C, R
      return [mix(n, [[ch[0], 1], [ch[1], L]]), mix(n, [[ch[2], 1], [ch[1], L]])];
    case 4: // 2/1 — L, R, S (single surround, shared equally by both speakers)
      return [mix(n, [[ch[0], 1], [ch[2], L]]), mix(n, [[ch[1], 1], [ch[2], L]])];
    case 5: // 3/1 — L, C, R, S
      return [
        mix(n, [[ch[0], 1], [ch[1], L], [ch[3], L]]),
        mix(n, [[ch[2], 1], [ch[1], L], [ch[3], L]]),
      ];
    case 6: // 2/2 — L, R, Ls, Rs
      return [mix(n, [[ch[0], 1], [ch[2], L]]), mix(n, [[ch[1], 1], [ch[3], L]])];
    case 7: // 3/2 — L, C, R, Ls, Rs : the common 5.1 case.
      return [
        mix(n, [[ch[0], 1], [ch[1], L], [ch[3], L]]),
        mix(n, [[ch[2], 1], [ch[1], L], [ch[4], L]]),
      ];
    case 0: // 1+1 — two independent mono programs (e.g. bilingual), not a real downmix.
    case 2: // 2/0 — already L, R.
    default:
      return [mix(n, [[ch[0], 1]]), mix(n, [[ch[Math.min(1, ch.length - 1)], 1]])];
  }
}
