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
 * Allocation de bits AC-3 — transcription FIDÈLE du pseudo-code de la norme
 * ATSC A/52:2018, §7.2.2.
 *
 * C'EST LE CŒUR FRAGILE DU DÉCODEUR. Cette routine ne produit pas du son : elle
 * dit, pour chaque coefficient fréquentiel, COMBIEN DE BITS sa mantisse occupe
 * dans le flux. L'encodeur a fait exactement le même calcul. Une seule unité
 * d'écart sur une seule bande, et on lit la mantisse suivante au mauvais endroit :
 * toute la fin de la trame devient du bruit. Ce n'est pas dégradé, c'est perdu.
 *
 * Une première version écrite « de tête » débordait de plusieurs milliers de bits
 * par trame — d'où cette transcription littérale, y compris le mécanisme `lowcomp`
 * que l'intuition ne devine pas.
 */

export type ParamsAllocation = {
  sdcycod: number;
  fdcycod: number;
  sgaincod: number;
  dbpbcod: number;
  floorcod: number;
};

export const PARAMS_DEFAUT: ParamsAllocation = {
  sdcycod: 2,
  fdcycod: 1,
  sgaincod: 1,
  dbpbcod: 2,
  floorcod: 7,
};

/** masktab : bin → bande de masquage. Déduit de BNDTAB/BNDSZ, donc jamais faux. */
const MASKTAB = (() => {
  const t = new Uint8Array(256);
  for (let bnd = 0; bnd < 50; bnd++) {
    for (let k = 0; k < BNDSZ[bnd]; k++) t[BNDTAB[bnd] + k] = bnd;
  }
  return t;
})();

export type EntreeAllocation = {
  exp: Int16Array;
  start: number;
  end: number;
  /** FASTGAIN[fgaincod]. */
  fgain: number;
  /** (((csnroffst − 15) << 4) + fsnroffst) << 2 */
  snroffset: number;
  /** Fuites initiales du canal de couplage, déjà décalées (`(cplfleak << 8) + 768`). */
  fastleak?: number;
  slowleak?: number;
  /** Ajustement delta par bande, quand `deltbae` vaut 0 ou 1. */
  deltba?: Int8Array;
  fscod: number;
  params: ParamsAllocation;
  /** Canal de couplage : la courbe démarre à `bndstrt`, sans compensation grave. */
  estCouplage?: boolean;
};

/** §7.2.2.4 — compensation des basses fréquences, que l'oreille masque mal. */
function calcLowcomp(a: number, b0: number, b1: number, bin: number): number {
  if (bin < 7) {
    // La norme écrit `if ((b0 + 256) == b1) ;` — le point-virgule est une
    // coquille connue du document : l'affectation qui suit est bien conditionnelle.
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

/** Addition logarithmique (§7.2.2.3). */
function logadd(a: number, b: number): number {
  const c = a - b;
  const adresse = Math.min(Math.abs(c) >> 1, 255);
  return c >= 0 ? a + LATAB[adresse] : b + LATAB[adresse];
}

export function allouer(e: EntreeAllocation, bap: Uint8Array): Uint8Array {
  const { exp, start, end, fscod, params } = e;
  if (end <= start) return bap;

  const sdecay = SLOWDEC[params.sdcycod];
  const fdecay = FASTDEC[params.fdcycod];
  const sgain = SLOWGAIN[params.sgaincod];
  const dbknee = DBPBTAB[params.dbpbcod];
  const floor = FLOORTAB[params.floorcod];

  // --- §7.2.2.2 psd ---
  const psd = new Int32Array(end);
  for (let bin = start; bin < end; bin++) psd[bin] = 3072 - (exp[bin] << 7);

  // --- §7.2.2.3 intégration par bande ---
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
    // Canaux à pleine bande et LFE : les 7 premières bandes ont un traitement
    // particulier, avec la compensation `lowcomp`.
    lowcomp = calcLowcomp(lowcomp, bndpsd[0], bndpsd[1], 0);
    excite[0] = bndpsd[0] - e.fgain - lowcomp;
    lowcomp = calcLowcomp(lowcomp, bndpsd[1], bndpsd[2], 1);
    excite[1] = bndpsd[1] - e.fgain - lowcomp;
    begin = 7;

    for (let bin = 2; bin < 7; bin++) {
      // La dernière bande du LFE (bin 6) est exclue : elle n'a pas de suivante.
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
    // Canal de couplage : il hérite des fuites transmises dans le flux.
    fastleak = e.fastleak ?? 0;
    slowleak = e.slowleak ?? 0;
    begin = bndstrt;
  }

  for (let bin = begin; bin < bndend; bin++) {
    fastleak = Math.max(fastleak - fdecay, bndpsd[bin] - e.fgain);
    slowleak = Math.max(slowleak - sdecay, bndpsd[bin] - sgain);
    excite[bin] = Math.max(fastleak, slowleak);
  }

  // --- §7.2.2.5 courbe de masquage ---
  const masque = new Int32Array(50);
  for (let bin = bndstrt; bin < bndend; bin++) {
    if (bndpsd[bin] < dbknee) excite[bin] += (dbknee - bndpsd[bin]) >> 2;
    masque[bin] = Math.max(excite[bin], HTH[fscod][bin]);
  }

  // --- §7.2.2.6 ajustements delta ---
  if (e.deltba) {
    for (let bnd = bndstrt; bnd < bndend; bnd++) {
      const d = e.deltba[bnd];
      if (d) masque[bnd] += d * 128;
    }
  }

  // --- §7.2.2.7 bap ---
  let i = start;
  j = MASKTAB[start];
  do {
    lastbin = Math.min(BNDTAB[j] + BNDSZ[j], end);
    masque[j] -= e.snroffset;
    masque[j] -= floor;
    if (masque[j] < 0) masque[j] = 0;
    masque[j] &= 0x1fe0;
    masque[j] += floor;
    for (; i < lastbin; i++) {
      let adresse = (psd[i] - masque[j]) >> 5;
      adresse = Math.min(63, Math.max(0, adresse));
      bap[i] = BAPTAB[adresse];
    }
    j++;
  } while (end > lastbin);

  return bap;
}

/** Nombre de bits d'une mantisse selon son `bap` (Table 7.17). */
export const BITS_MANTISSE = [0, 0, 0, 0, 0, 0, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16] as const;

/**
 * Mantisses groupées : les bap 1, 2 et 4 empaquettent plusieurs valeurs dans un
 * seul mot, pour ne pas gaspiller de bits sur des quantificateurs à peu de niveaux.
 *   bap 1 → 3 valeurs sur 5 bits · bap 2 → 3 sur 7 bits · bap 4 → 2 sur 7 bits
 */
export const GROUPES: Record<number, { parGroupe: number; bits: number; niveaux: number }> = {
  1: { parGroupe: 3, bits: 5, niveaux: 3 },
  2: { parGroupe: 3, bits: 7, niveaux: 5 },
  4: { parGroupe: 2, bits: 7, niveaux: 11 },
};
