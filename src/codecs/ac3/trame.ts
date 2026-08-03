import { LecteurBits } from "./bits.js";
import { allouer, BITS_MANTISSE, GROUPES, PARAMS_DEFAUT, type ParamsAllocation } from "./bitalloc.js";
import { CANAUX_ACMOD, DEBITS_KBPS, FASTGAIN, FREQUENCES } from "./tables.js";

/**
 * Analyse d'une trame AC-3 : syncinfo, BSI, puis les 6 blocs audio.
 *
 * L'objectif de ce module n'est pas encore de produire du son, mais de LIRE
 * exactement — exposants, allocation de bits, mantisses — en consommant le bon
 * nombre de bits. C'est la moitié risquée du décodeur : la synthèse (IMDCT,
 * fenêtrage) est de la DSP classique, alors qu'ici la moindre erreur d'un bit
 * désynchronise irrémédiablement.
 */

export const SYNCWORD = 0x0b77;
/** 6 blocs de 256 échantillons : une trame AC-3 fait toujours 1536 échantillons. */
export const ECHANTILLONS_PAR_TRAME = 1536;
export const BLOCS_PAR_TRAME = 6;

export type EnteteTrame = {
  fscod: number;
  frequence: number;
  frmsizecod: number;
  /** Taille de la trame en octets. */
  tailleOctets: number;
  bsid: number;
  bsmod: number;
  acmod: number;
  lfeon: boolean;
  /** Canaux à pleine bande (hors LFE). */
  canaux: number;
  dialnorm: number;
};

/**
 * Taille d'une trame, en mots de 16 bits (Table 5.18).
 *
 * Calculée plutôt que tabulée : à 48 et 32 kHz c'est une division exacte ; à
 * 44,1 kHz la spec impose un arrondi et un mot de bourrage selon la parité de
 * `frmsizecod` — d'où le `+ (frmsizecod & 1)`.
 */
export function tailleTrameMots(fscod: number, frmsizecod: number): number {
  const kbps = DEBITS_KBPS[frmsizecod >> 1];
  if (kbps === undefined) return 0;
  if (fscod === 0) return 2 * kbps; // 48 kHz
  if (fscod === 2) return 3 * kbps; // 32 kHz
  // 44,1 kHz : (bitrate × 1536 / 44100 / 16), arrondi, + bourrage éventuel.
  return Math.floor((kbps * 1536) / 44100 / 2 + 0.5) * 2 + (frmsizecod & 1);
}

/** Lit syncinfo + BSI. Renvoie null si la trame n'est pas exploitable. */
export function lireEntete(r: LecteurBits): EnteteTrame | null {
  if (r.lire(16) !== SYNCWORD) return null;
  r.sauter(16); // crc1

  const fscod = r.lire(2);
  if (fscod === 3) return null; // réservé
  const frmsizecod = r.lire(6);
  if (frmsizecod > 37) return null;

  const bsid = r.lire(5);
  // bsid 16 = E-AC-3, dont la syntaxe diffère entièrement. On ne le prétend pas.
  if (bsid > 8) return null;
  const bsmod = r.lire(3);
  const acmod = r.lire(3);

  if ((acmod & 0x1) !== 0 && acmod !== 0x1) r.sauter(2); // cmixlev
  if ((acmod & 0x4) !== 0) r.sauter(2); // surmixlev
  if (acmod === 0x2) r.sauter(2); // dsurmod
  const lfeon = r.drapeau();
  const dialnorm = r.lire(5);
  if (r.drapeau()) r.sauter(8); // compr
  if (r.drapeau()) r.sauter(8); // langcod
  if (r.drapeau()) r.sauter(7); // mixlevel(5) + roomtyp(2)

  if (acmod === 0) {
    // Mode 1+1 : deux programmes mono indépendants, chacun avec ses champs.
    r.sauter(5); // dialnorm2
    if (r.drapeau()) r.sauter(8); // compr2
    if (r.drapeau()) r.sauter(8); // langcod2
    if (r.drapeau()) r.sauter(7); // mixlevel2 + roomtyp2
  }

  r.sauter(2); // copyrightb + origbs
  if (r.drapeau()) r.sauter(14); // timecod1
  if (r.drapeau()) r.sauter(14); // timecod2
  if (r.drapeau()) {
    const addbsil = r.lire(6);
    r.sauter((addbsil + 1) * 8);
  }

  return {
    fscod,
    frequence: FREQUENCES[fscod],
    frmsizecod,
    tailleOctets: tailleTrameMots(fscod, frmsizecod) * 2,
    bsid,
    bsmod,
    acmod,
    lfeon,
    canaux: CANAUX_ACMOD[acmod],
    dialnorm,
  };
}

const EXP_REUSE = 0;
const EXP_D15 = 1;
const EXP_D25 = 2;
const EXP_D45 = 3;

/**
 * Décode un groupe d'exposants différentiels.
 *
 * Les exposants sont codés par différences successives, trois par mot de 7 bits
 * (valeurs 0..124 → 3 chiffres en base 5, décalés de 2). Selon la stratégie,
 * chaque différence s'applique à 1, 2 ou 4 bins consécutifs.
 */
function lireExposants(
  r: LecteurBits,
  strategie: number,
  nbGroupes: number,
  premier: number,
  sortie: Int16Array,
  debut: number,
): void {
  let exp = premier;
  sortie[debut] = exp;
  let bin = debut + 1;
  const repetition = strategie === EXP_D15 ? 1 : strategie === EXP_D25 ? 2 : 4;

  for (let g = 0; g < nbGroupes; g++) {
    const mot = r.lire(7);
    // Trois différences empaquetées en base 5, biaisées de +2.
    const d = [Math.floor(mot / 25), Math.floor(mot / 5) % 5, mot % 5];
    for (let k = 0; k < 3; k++) {
      exp += d[k] - 2;
      // Un exposant sort de [0,24] : le flux est corrompu, on borne plutôt que
      // de propager une valeur absurde dans l'allocation.
      if (exp < 0) exp = 0;
      else if (exp > 24) exp = 24;
      for (let j = 0; j < repetition && bin < sortie.length; j++) sortie[bin++] = exp;
    }
  }
}

/**
 * Nombre de mots d'exposants d'un canal à pleine bande (norme §5.4.2.7).
 *
 * Ce n'est PAS un simple `ceil` : la norme tronque après avoir ajouté un biais
 * différent par stratégie (+3 en D25, +9 en D45). Une première version avec
 * `ceil` lisait un mot de trop sur certaines largeurs de bande — soit 7 bits de
 * décalage qui ruinaient toute la suite de la trame.
 */
function nbGroupesCanal(strategie: number, endmant: number): number {
  if (strategie === EXP_D15) return Math.trunc((endmant - 1) / 3);
  if (strategie === EXP_D25) return Math.trunc((endmant - 1 + 3) / 6);
  return Math.trunc((endmant - 1 + 9) / 12);
}

/** Canal de couplage : division exacte, la plage est un multiple de 12. */
function nbGroupesCouplage(strategie: number, nbBins: number): number {
  return nbBins / (strategie === EXP_D15 ? 3 : strategie === EXP_D25 ? 6 : 12);
}

export type ResultatTrame = {
  entete: EnteteTrame;
  /** Position du lecteur à la fin de chaque bloc — sert au diagnostic. */
  positionsBlocs: number[];
  /** Position du lecteur en fin d'analyse, en bits depuis le début de la trame. */
  bitsConsommes: number;
  /** Nombre total de mantisses lues, tous canaux et tous blocs confondus. */
  mantisses: number;
};

/**
 * Analyse une trame complète et consomme tous ses champs.
 *
 * Ne restitue pas encore d'échantillons : sert à valider que le parsing et
 * l'allocation de bits sont exacts, en vérifiant où l'on retombe.
 */
export function analyserTrame(data: Uint8Array): ResultatTrame | null {
  const r = new LecteurBits(data);
  const entete = lireEntete(r);
  if (!entete) return null;

  const { acmod, lfeon, fscod } = entete;
  const nch = entete.canaux;
  let mantissesLues = 0;
  const positionsBlocs: number[] = [];

  // État persistant entre blocs — l'AC-3 réutilise beaucoup d'un bloc à l'autre.
  let cplinu = false;
  const chincpl = new Array<boolean>(nch).fill(false);
  let cplbegf = 0;
  let cplendf = 0;
  let ncplbnd = 0;
  let ncplsubnd = 0;
  const cplbndstrc = new Array<number>(18).fill(0);
  let params: ParamsAllocation = { ...PARAMS_DEFAUT };
  let phsflginu = false;

  /**
   * ÉTAT PERSISTANT ENTRE BLOCS — c'est tout l'esprit de l'AC-3 : un bloc qui ne
   * transmet pas un paramètre réutilise celui du précédent. `snroffste = 0` ne
   * veut pas dire « décalage nul », mais « le même qu'avant ».
   *
   * Les remettre à zéro à chaque bloc donnait une allocation fausse dès le bloc 1
   * (le bloc 0 restant juste, ce qui rendait le bug difficile à voir) : mesuré à
   * 4422 bits consommés là où on en attendait ~1011.
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
  let deltbaCouplage: Int8Array | undefined;

  const chbwcod = new Array<number>(nch).fill(0);
  const endmant = new Array<number>(nch).fill(0);
  const exposants: Int16Array[] = Array.from({ length: nch }, () => new Int16Array(256));
  const expCouplage = new Int16Array(256);
  const expLfe = new Int16Array(256);
  const bapCanal: Uint8Array[] = Array.from({ length: nch }, () => new Uint8Array(256));
  const bapCouplage = new Uint8Array(256);
  const bapLfe = new Uint8Array(256);

  for (let blk = 0; blk < BLOCS_PAR_TRAME; blk++) {
    for (let ch = 0; ch < nch; ch++) r.sauter(1); // blksw
    for (let ch = 0; ch < nch; ch++) r.sauter(1); // dithflag
    if (r.drapeau()) r.sauter(8); // dynrng
    if (acmod === 0 && r.drapeau()) r.sauter(8); // dynrng2

    if (r.drapeau()) {
      // cplstre : la structure de couplage est (re)définie
      cplinu = r.drapeau();
      if (cplinu) {
        for (let ch = 0; ch < nch; ch++) chincpl[ch] = r.drapeau();
        if (acmod === 0x2) phsflginu = r.drapeau();
        cplbegf = r.lire(4);
        cplendf = r.lire(4);
        ncplsubnd = 3 + cplendf - cplbegf;
        ncplbnd = ncplsubnd;
        for (let bnd = 1; bnd < ncplsubnd; bnd++) {
          cplbndstrc[bnd] = r.drapeau() ? 1 : 0;
          ncplbnd -= cplbndstrc[bnd];
        }
      }
    }

    if (cplinu) {
      let cplcoeUn = false;
      for (let ch = 0; ch < nch; ch++) {
        if (!chincpl[ch]) continue;
        if (r.drapeau()) {
          cplcoeUn = true;
          r.sauter(2); // mstrcplco
          for (let bnd = 0; bnd < ncplbnd; bnd++) r.sauter(8); // cplcoexp + cplcomant
        }
      }
      if (acmod === 0x2 && phsflginu && cplcoeUn) {
        for (let bnd = 0; bnd < ncplbnd; bnd++) r.sauter(1); // phsflg
      }
    }

    if (acmod === 0x2 && r.drapeau()) {
      // rematstr : bandes de rematriçage, leur nombre dépend du couplage.
      const nrematbnd = !cplinu ? 4 : cplbegf === 0 ? 2 : cplbegf <= 2 ? 3 : 4;
      for (let b = 0; b < nrematbnd; b++) r.sauter(1);
    }

    const cplexpstr = cplinu ? r.lire(2) : EXP_REUSE;
    const chexpstr = new Array<number>(nch);
    for (let ch = 0; ch < nch; ch++) chexpstr[ch] = r.lire(2);
    const lfeexpstr = lfeon ? r.lire(1) : EXP_REUSE;

    for (let ch = 0; ch < nch; ch++) {
      if (chexpstr[ch] === EXP_REUSE) continue;
      if (chincpl[ch]) {
        endmant[ch] = 37 + 12 * cplbegf; // le couplage prend la suite
      } else {
        chbwcod[ch] = r.lire(6);
        endmant[ch] = 37 + 3 * (chbwcod[ch] + 12);
      }
    }

    // --- Exposants du canal de couplage ---
    const cplstrtmant = 37 + 12 * cplbegf;
    const cplendmant = 37 + 12 * (cplendf + 3);
    if (cplinu && cplexpstr !== EXP_REUSE) {
      const nb = cplendmant - cplstrtmant;
      const premier = r.lire(4) << 1; // cplabsexp, échelle double
      const groupes = nbGroupesCouplage(cplexpstr, nb);
      lireExposants(r, cplexpstr, groupes, premier, expCouplage, cplstrtmant);
    }

    // --- Exposants des canaux ---
    for (let ch = 0; ch < nch; ch++) {
      if (chexpstr[ch] === EXP_REUSE) continue;
      const premier = r.lire(4);
      const groupes = nbGroupesCanal(chexpstr[ch], endmant[ch]);
      lireExposants(r, chexpstr[ch], groupes, premier, exposants[ch], 0);
      r.sauter(2); // gainrng
    }

    // --- Exposants du LFE (toujours 7 bins) ---
    if (lfeon && lfeexpstr !== EXP_REUSE) {
      const premier = r.lire(4);
      // nlfegrps vaut 2, toujours : le LFE fait 7 bins en D15.
      lireExposants(r, EXP_D15, 2, premier, expLfe, 0);
    }

    // --- Paramètres d'allocation ---
    if (r.drapeau()) {
      params = {
        sdcycod: r.lire(2),
        fdcycod: r.lire(2),
        sgaincod: r.lire(2),
        dbpbcod: r.lire(2),
        floorcod: r.lire(3),
      };
    }

    if (r.drapeau()) {
      csnroffst = r.lire(6);
      if (cplinu) {
        cplfsnroffst = r.lire(4);
        cplfgaincod = r.lire(3);
      }
      for (let ch = 0; ch < nch; ch++) {
        fsnroffst[ch] = r.lire(4);
        fgaincod[ch] = r.lire(3);
      }
      if (lfeon) {
        lfefsnroffst = r.lire(4);
        lfefgaincod = r.lire(3);
      }
    }

    if (cplinu && r.drapeau()) {
      cplfleak = r.lire(3);
      cplsleak = r.lire(3);
    }

    // --- Ajustements delta de l'allocation ---
    // ORDRE CRUCIAL (§5.3.3) : la norme lit d'abord TOUS les codes `deltbae`
    // (couplage puis chaque canal), et SEULEMENT ENSUITE les segments de chacun.
    // Les entrelacer — lire le code d'un canal puis ses segments — désynchronise
    // le flux dès qu'un seul canal porte des ajustements.
    if (r.drapeau()) {
      const cpldeltbae = cplinu ? r.lire(2) : 2;
      const deltbae = new Array<number>(nch);
      for (let ch = 0; ch < nch; ch++) deltbae[ch] = r.lire(2);

      /** Lit les segments d'un canal. `deltbae == 1` = nouvelles données. */
      const lireSegments = (): Int8Array => {
        const nseg = r.lire(3) + 1;
        const table = new Int8Array(50);
        let bnd = 0;
        for (let s = 0; s < nseg; s++) {
          bnd += r.lire(5); // offset
          const longueur = r.lire(4);
          const valeur = r.lire(3);
          // Les valeurs 0..3 sont positives, 4..7 négatives (−4..−1).
          const applique = valeur >= 4 ? valeur - 8 : valeur;
          for (let k = 0; k < longueur && bnd < 50; k++) table[bnd++] = applique;
        }
        return table;
      };

      if (cplinu) {
        if (cpldeltbae === 1) deltbaCouplage = lireSegments();
        else if (cpldeltbae === 2) deltbaCouplage = undefined; // « aucun delta »
      }
      for (let ch = 0; ch < nch; ch++) {
        if (deltbae[ch] === 1) deltba[ch] = lireSegments();
        else if (deltbae[ch] === 2) deltba[ch] = undefined;
      }
    }

    if (r.drapeau()) {
      // skiple : champ de bourrage explicite
      const skipl = r.lire(9);
      r.sauter(skipl * 8);
    }

    // --- Allocation puis lecture des mantisses ---
    // §7.2.2.1 : (((csnroffst − 15) << 4) + fsnroffst) << 2
    const snr = (fine: number) => ((((csnroffst - 15) << 4) + fine) << 2);

    if (cplinu) {
      allouer(
        {
          exp: expCouplage,
          start: cplstrtmant,
          end: cplendmant,
          fgain: FASTGAIN_SUR(cplfgaincod),
          snroffset: snr(cplfsnroffst),
          // (cplfleak << 8) + 768 — la constante vient de la norme §7.2.2.1,
          // elle n'est pas un réglage.
          fastleak: (cplfleak << 8) + 768,
          slowleak: (cplsleak << 8) + 768,
          deltba: deltbaCouplage,
          fscod,
          params,
          estCouplage: true,
        },
        bapCouplage,
      );
    }

    for (let ch = 0; ch < nch; ch++) {
      allouer(
        {
          exp: exposants[ch],
          start: 0,
          end: endmant[ch],
          fgain: FASTGAIN_SUR(fgaincod[ch]),
          snroffset: snr(fsnroffst[ch]),
          deltba: deltba[ch],
          fscod,
          params,
        },
        bapCanal[ch],
      );
    }

    if (lfeon) {
      allouer(
        {
          exp: expLfe,
          start: 0,
          end: 7,
          fgain: FASTGAIN_SUR(lfefgaincod),
          snroffset: snr(lfefsnroffst),
          fscod,
          params,
        },
        bapLfe,
      );
    }

    // Les mantisses arrivent canal par canal ; le couplage est intercalé au
    // premier canal couplé qui atteint sa borne.
    const consommer = (bap: Uint8Array, debut: number, fin: number) => {
      // Les groupes ne franchissent pas la frontière d'un canal : chaque plage
      // repart avec ses compteurs à zéro, sinon on décale d'un mot sur deux.
      const restesGroupe: Record<number, number> = { 1: 0, 2: 0, 4: 0 };
      for (let bin = debut; bin < fin; bin++) {
        const b = bap[bin];
        if (b === 0) continue;
        mantissesLues++;
        const groupe = GROUPES[b as 1 | 2 | 4];
        if (groupe) {
          // Un mot est lu pour le premier du groupe, les suivants sont gratuits.
          if (restesGroupe[b] === 0) {
            r.sauter(groupe.bits);
            restesGroupe[b] = groupe.parGroupe - 1;
          } else {
            restesGroupe[b]--;
          }
        } else {
          r.sauter(BITS_MANTISSE[b]);
        }
      }
    };

    let couplageLu = false;
    for (let ch = 0; ch < nch; ch++) {
      consommer(bapCanal[ch], 0, endmant[ch]);
      if (cplinu && chincpl[ch] && !couplageLu) {
        consommer(bapCouplage, cplstrtmant, cplendmant);
        couplageLu = true;
      }
    }
    if (lfeon) consommer(bapLfe, 0, 7);
    positionsBlocs.push(r.position);
  }

  return { entete, bitsConsommes: r.position, mantisses: mantissesLues, positionsBlocs };
}

/** FASTGAIN indexé, avec garde-fou : le champ fait 3 bits, la table 8 entrées. */
function FASTGAIN_SUR(code: number): number {
  return FASTGAIN[code & 7];
}




/**
 * ÉTAT — INACHEVÉ, NON CÂBLÉ. Mesure du 03/08/2026.
 *
 * Ce qui est JUSTE, vérifié contre ffprobe : syncinfo et BSI (fréquence, acmod,
 * LFE, taille de trame), sur du stéréo comme du 5.1.
 *
 * Ce qui ne l'est pas : la lecture des blocs. MESURE CLÉ — en désactivant
 * complètement les mantisses, une trame stéréo consomme déjà 107 % de son
 * budget : le défaut est donc dans les ENTÊTES ou les EXPOSANTS, pas dans
 * l'allocation comme je l'ai d'abord cru. Sur une trame isolée le coût tombe
 * à 65 %, et un bloc sans exposants coûte 25 bits — cohérent ; c'est la
 * variance d'un bloc à l'autre qui trahit la mauvaise lecture.
 *
 * (ancienne piste, invalidée) L'allocation sur-alloue. Un bloc
 * consomme 1176 à 3612 bits là où le budget en prévoit ~1011. Les `bap` obtenus
 * tournent autour de 7-15 (6 à 16 bits par mantisse) alors qu'un flux 192 kb/s
 * stéréo impose une moyenne de ~2 bits.
 *
 * Cinq bugs réels ont déjà été trouvés et corrigés en confrontant le code à la
 * norme, chacun ayant déplacé la mesure :
 *   1. mécanisme `lowcomp` de la courbe d'excitation, entièrement absent ;
 *   2. comptage des groupes d'exposants (la norme tronque après un biais +3/+9,
 *      là où j'arrondissais au supérieur) ;
 *   3. `deltbae` : la norme lit TOUS les codes avant les segments, pas en
 *      alternance ;
 *   4. csnroffst/fsnroffst/fgaincod PERSISTENT entre blocs — les remettre à zéro
 *      faussait tout dès le bloc 1 (le bloc 0 restant correct, ce qui masquait
 *      le problème) ;
 *   5. `floortab[7] = 0xf800` est un entier SIGNÉ (−2048), pas 63488.
 *
 * La piste restante : la courbe de masquage sort trop basse d'environ 1500
 * unités, donc `address = (psd − mask) >> 5` explose. C'est soit `bndpsd`, soit
 * l'excitation, soit l'échelle de `snroffset`.
 *
 * Rien n'est branché : `Remuxer` exclut proprement les pistes AC-3, et le remux
 * vidéo n'est pas concerné. Pas d'audio promis tant que
 * `scripts/verifier-ac3.mts` n'affiche pas 100 % d'alignement.
 */
