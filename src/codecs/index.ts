import { boite, joindre, u16, u32, u8, descripteur, pleine } from "../mp4/box.js";
import type { Piste } from "../matroska/demuxer.js";

/**
 * Traduction Matroska → MP4 : entrée d'échantillon (« sample entry ») et chaîne
 * de codec MSE.
 *
 * C'EST ICI QUE TOUT SE JOUE. Le remux ne fonctionne que parce que le MKV et le
 * MP4 emballent les MÊMES flux élémentaires, et que Matroska range déjà la
 * configuration du décodeur au format MP4 :
 *   - H.264  : CodecPrivate = AVCDecoderConfigurationRecord = contenu de `avcC`
 *   - HEVC   : CodecPrivate = HEVCDecoderConfigurationRecord = contenu de `hvcC`
 *   - AV1    : CodecPrivate = AV1CodecConfigurationRecord   = contenu de `av1C`
 *   - AAC    : CodecPrivate = AudioSpecificConfig           → à emballer en `esds`
 *   - Opus   : CodecPrivate = OpusHead                      → à emballer en `dOps`
 * Aucun octet du bitstream n'est réécrit : on recopie, on ré-emballe.
 *
 * La chaîne de codec, elle, doit être EXACTE : une lettre fausse et
 * `MediaSource.isTypeSupported` renvoie false, ou pire, `appendBuffer` lève.
 */

export type Description = {
  /** Boîte d'entrée d'échantillon complète (avc1, mp4a…). */
  entree: Uint8Array;
  /** Chaîne pour `isTypeSupported`, ex. `avc1.640028`. */
  codec: string;
  /** `video/mp4` ou `audio/mp4`. */
  type: "video" | "audio";
  /** Cadence de l'horloge de la piste. */
  timescale: number;
};

export class CodecNonSupporte extends Error {
  constructor(readonly codecId: string, readonly raison: string) {
    super(`${codecId} : ${raison}`);
  }
}

// ---------------------------------------------------------------------------
// Vidéo
// ---------------------------------------------------------------------------

const octetHex = (v: number) => v.toString(16).padStart(2, "0");

/** `avc1.PPCCLL` — profil, contraintes, niveau, lus dans l'avcC. */
function codecAvc(avcC: Uint8Array): string {
  if (avcC.length < 4) throw new CodecNonSupporte("V_MPEG4/ISO/AVC", "avcC tronqué");
  return `avc1.${octetHex(avcC[1])}${octetHex(avcC[2])}${octetHex(avcC[3])}`;
}

/**
 * `hvc1.P.C.TL.CC…` — la partie pénible du HEVC.
 *
 * Les 32 bits de compatibilité doivent être écrits en hexadécimal **avec l'ordre
 * des bits inversé** (ISO 14496-15 §E.3). C'est le piège classique : sans
 * l'inversion, la chaîne paraît plausible et le navigateur refuse le flux.
 */
function codecHevc(hvcC: Uint8Array): string {
  if (hvcC.length < 13) throw new CodecNonSupporte("V_MPEGH/ISO/HEVC", "hvcC tronqué");

  const espaceProfil = (hvcC[1] >> 6) & 0x03;
  const tier = (hvcC[1] >> 5) & 0x01;
  const profil = hvcC[1] & 0x1f;

  let compat = 0;
  for (let i = 2; i <= 5; i++) compat = (compat << 8) | hvcC[i];
  let compatInverse = 0;
  for (let i = 0; i < 32; i++) {
    compatInverse = (compatInverse << 1) | ((compat >>> i) & 1);
  }

  const parties = [
    "hvc1",
    (espaceProfil === 0 ? "" : String.fromCharCode(64 + espaceProfil)) + profil,
    (compatInverse >>> 0).toString(16).toUpperCase(),
    (tier === 0 ? "L" : "H") + hvcC[12],
  ];

  // 6 octets de contraintes, zéros de queue retirés.
  const contraintes: string[] = [];
  for (let i = 6; i <= 11; i++) contraintes.push(hvcC[i].toString(16).toUpperCase().padStart(2, "0"));
  while (contraintes.length > 0 && contraintes[contraintes.length - 1] === "00") contraintes.pop();

  return [...parties, ...contraintes].join(".");
}

/** `av01.P.LLT.BB` — profil, niveau, tier, profondeur. */
function codecAv1(av1C: Uint8Array): string {
  if (av1C.length < 3) throw new CodecNonSupporte("V_AV1", "av1C tronqué");
  const profil = (av1C[1] >> 5) & 0x07;
  const niveau = av1C[1] & 0x1f;
  const tier = (av1C[2] >> 7) & 0x01;
  const hautePrecision = (av1C[2] >> 6) & 0x01;
  const douzeBits = (av1C[2] >> 5) & 0x01;
  const bits = douzeBits ? 12 : hautePrecision ? 10 : 8;
  return `av01.${profil}.${String(niveau).padStart(2, "0")}${tier ? "H" : "M"}.${String(bits).padStart(2, "0")}`;
}

/** Boîte commune à toutes les entrées vidéo (`VisualSampleEntry`). */
function entreeVideo(type: string, largeur: number, hauteur: number, config: Uint8Array): Uint8Array {
  return boite(
    type,
    u32(0), // reserved
    u16(0), // reserved
    u16(1), // data_reference_index
    u16(0), // pre_defined
    u16(0), // reserved
    u32(0),
    u32(0),
    u32(0), // pre_defined[3]
    u16(largeur),
    u16(hauteur),
    u32(0x00480000), // horizresolution 72 dpi
    u32(0x00480000), // vertresolution
    u32(0), // reserved
    u16(1), // frame_count
    new Uint8Array(32), // compressorname
    u16(0x0018), // depth
    u16(0xffff), // pre_defined = -1
    config,
  );
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

/** Type d'objet AAC lu dans l'AudioSpecificConfig (5 bits, 31 = étendu). */
function typeObjetAac(asc: Uint8Array): number {
  if (asc.length < 1) return 2;
  const type = asc[0] >> 3;
  if (type !== 31) return type;
  if (asc.length < 2) return 2;
  return 32 + (((asc[0] & 0x07) << 3) | (asc[1] >> 5));
}

/** `esds` : la poupée russe de descripteurs qui enveloppe l'AudioSpecificConfig. */
function esds(asc: Uint8Array): Uint8Array {
  const decSpecific = descripteur(0x05, asc); // DecoderSpecificInfo
  const decConfig = descripteur(
    0x04, // DecoderConfigDescriptor
    u8(0x40), // objectTypeIndication = MPEG-4 Audio
    u8(0x15), // streamType = audio (5) << 2 | upStream(0) << 1 | reserved(1)
    [0, 0, 0], // bufferSizeDB
    u32(0), // maxBitrate — 0 = inconnu, accepté
    u32(0), // avgBitrate
    decSpecific,
  );
  const slConfig = descripteur(0x06, u8(0x02)); // SLConfigDescriptor : prédéfini MP4
  const es = descripteur(0x03, u16(1), u8(0), decConfig, slConfig); // ES_Descriptor
  return boite("esds", pleine(0, 0), es);
}

/** Boîte commune aux entrées audio (`AudioSampleEntry`). */
function entreeAudio(
  type: string,
  canaux: number,
  frequence: number,
  bits: number,
  ...config: Uint8Array[]
): Uint8Array {
  // Le champ sample_rate est en 16.16 : au-delà de 65535 Hz il déborde. La spec
  // impose alors d'y écrire 0 et de se fier au timescale de la piste.
  const freq16_16 = frequence < 65536 ? Math.round(frequence) << 16 : 0;
  return boite(
    type,
    u32(0),
    u16(0), // reserved
    u16(1), // data_reference_index
    u32(0),
    u32(0), // reserved
    u16(canaux),
    u16(bits),
    u16(0), // pre_defined
    u16(0), // reserved
    u32(freq16_16),
    ...config,
  );
}

/**
 * `dOps` — l'OpusSpecificBox de MP4, qui n'est PAS l'OpusHead d'Ogg.
 *
 * Deux différences qu'on ne voit pas en lisant les deux specs côte à côte :
 *   - la version vaut **0** dans MP4, **1** dans Ogg (ffmpeg rejette : « unsupported
 *     OpusSpecificBox version ») ;
 *   - les entiers d'Ogg sont **petit-boutistes**, ceux de MP4 **gros-boutistes**.
 * Recopier l'OpusHead en retirant sa signature produit donc un flux illisible.
 *
 * Référence : opus-codec.org/docs/opus_in_isobmff.html §4.3.2
 */
function dOps(opusHead: Uint8Array, canauxParDefaut: number): Uint8Array {
  const aSignature =
    opusHead.length >= 8 && String.fromCharCode(...opusHead.subarray(0, 8)) === "OpusHead";
  const t = aSignature ? opusHead.subarray(8) : opusHead;
  if (t.length < 11) throw new CodecNonSupporte("A_OPUS", "OpusHead tronqué");

  const lire16LE = (i: number) => t[i] | (t[i + 1] << 8);
  const lire32LE = (i: number) => t[i] | (t[i + 1] << 8) | (t[i + 2] << 16) | (t[i + 3] << 24);

  // t[0] = version (1 côté Ogg), ignorée : MP4 impose 0.
  const canaux = t[1] || canauxParDefaut;
  const preSkip = lire16LE(2);
  const frequenceEntree = lire32LE(4) >>> 0;
  const gain = lire16LE(8);
  const familleMapping = t[10];

  const contenu: number[] = [
    0, // version
    canaux,
    ...u16(preSkip),
    ...u32(frequenceEntree),
    ...u16(gain),
    familleMapping,
  ];

  // Famille ≠ 0 : la table de mapping suit, elle se recopie telle quelle
  // (StreamCount, CoupledCount puis un octet par canal).
  if (familleMapping !== 0 && t.length > 11) {
    for (let i = 11; i < t.length; i++) contenu.push(t[i]);
  }

  return boite("dOps", contenu);
}

/** En-tête de trame AC-3 : ce que `dac3` doit contenir, et que rien d'autre ne dit. */
export type EnteteAc3 = {
  frequence: number;
  canaux: number;
  fscod: number;
  bsid: number;
  bsmod: number;
  acmod: number;
  lfeon: number;
  bitRateCode: number;
};

const FREQ_AC3 = [48000, 44100, 32000];
/** Nombre de canaux par acmod, hors LFE. */
const CANAUX_ACMOD = [2, 1, 2, 3, 3, 4, 4, 5];

/**
 * Analyse la première trame AC-3 d'un échantillon.
 *
 * L'AC-3 n'a pas de CodecPrivate en Matroska : la fréquence et le nombre de
 * canaux ne sont lisibles QUE dans le flux. Sans ça, impossible d'écrire `dac3`.
 */
export function analyserAc3(trame: Uint8Array): EnteteAc3 | null {
  if (trame.length < 6) return null;
  if (trame[0] !== 0x0b || trame[1] !== 0x77) return null; // syncword

  const fscod = (trame[4] >> 6) & 0x03;
  if (fscod === 3) return null; // réservé
  const frmsizecod = trame[4] & 0x3f;
  const bsid = (trame[5] >> 3) & 0x1f;
  const bsmod = trame[5] & 0x07;

  // acmod suit immédiatement bsmod, sur 3 bits au début de l'octet 6.
  if (trame.length < 7) return null;
  const acmod = (trame[6] >> 5) & 0x07;

  // Position de lfeon : elle dépend des champs de mixage présents, eux-mêmes
  // fonction d'acmod. On compte les bits plutôt que de deviner.
  let bitsConsommes = 3; // acmod
  if ((acmod & 0x01) !== 0 && acmod !== 0x01) bitsConsommes += 2; // cmixlev
  if ((acmod & 0x04) !== 0) bitsConsommes += 2; // surmixlev
  if (acmod === 0x02) bitsConsommes += 2; // dsurmod
  const bitPosition = 6 * 8 + bitsConsommes;
  const octet = trame[bitPosition >> 3];
  const lfeon = octet === undefined ? 0 : (octet >> (7 - (bitPosition & 7))) & 1;

  return {
    frequence: FREQ_AC3[fscod],
    canaux: CANAUX_ACMOD[acmod] + lfeon,
    fscod,
    bsid,
    bsmod,
    acmod,
    lfeon,
    bitRateCode: frmsizecod >> 1,
  };
}

/** `dac3` — 3 octets de champs collés bit à bit. */
function dac3(h: EnteteAc3): Uint8Array {
  // fscod(2) bsid(5) bsmod(3) acmod(3) lfeon(1) bit_rate_code(5) reserved(5)
  const bits =
    (h.fscod << 22) |
    (h.bsid << 17) |
    (h.bsmod << 14) |
    (h.acmod << 11) |
    (h.lfeon << 10) |
    (h.bitRateCode << 5);
  return boite("dac3", u8((bits >> 16) & 0xff), u8((bits >> 8) & 0xff), u8(bits & 0xff));
}

// ---------------------------------------------------------------------------
// Aiguillage
// ---------------------------------------------------------------------------

/**
 * Construit la description MP4 d'une piste Matroska.
 *
 * @param premiereTrame première trame de la piste — indispensable pour l'AC-3,
 *        dont la configuration ne vit que dans le flux.
 */
export function decrire(piste: Piste, premiereTrame?: Uint8Array): Description {
  const priv = piste.codecPrivate;

  switch (piste.codecId) {
    // ---- Vidéo ----
    case "V_MPEG4/ISO/AVC": {
      if (!priv) throw new CodecNonSupporte(piste.codecId, "avcC absent");
      const v = piste.video!;
      return {
        entree: entreeVideo("avc1", v.largeur, v.hauteur, boite("avcC", priv)),
        codec: codecAvc(priv),
        type: "video",
        // 90 kHz : l'horloge historique de MPEG, divisible par 24, 25 et 30.
        timescale: 90000,
      };
    }

    case "V_MPEGH/ISO/HEVC": {
      if (!priv) throw new CodecNonSupporte(piste.codecId, "hvcC absent");
      const v = piste.video!;
      return {
        entree: entreeVideo("hvc1", v.largeur, v.hauteur, boite("hvcC", priv)),
        codec: codecHevc(priv),
        type: "video",
        timescale: 90000,
      };
    }

    case "V_AV1": {
      if (!priv) throw new CodecNonSupporte(piste.codecId, "av1C absent");
      const v = piste.video!;
      return {
        entree: entreeVideo("av01", v.largeur, v.hauteur, boite("av1C", priv)),
        codec: codecAv1(priv),
        type: "video",
        timescale: 90000,
      };
    }

    // ---- Audio ----
    case "A_AAC": {
      if (!priv) throw new CodecNonSupporte(piste.codecId, "AudioSpecificConfig absent");
      const a = piste.audio!;
      return {
        entree: entreeAudio("mp4a", a.canaux, a.frequence, 16, esds(priv)),
        codec: `mp4a.40.${typeObjetAac(priv)}`,
        type: "audio",
        // L'horloge audio EST la fréquence d'échantillonnage : aucun arrondi possible.
        timescale: Math.round(a.frequence),
      };
    }

    case "A_OPUS": {
      if (!priv) throw new CodecNonSupporte(piste.codecId, "OpusHead absent");
      const a = piste.audio!;
      return {
        entree: entreeAudio("Opus", a.canaux, 48000, 16, dOps(priv, a.canaux)),
        codec: "opus",
        type: "audio",
        // Opus travaille toujours en 48 kHz, quelle que soit la fréquence d'origine.
        timescale: 48000,
      };
    }

    case "A_FLAC": {
      if (!priv) throw new CodecNonSupporte(piste.codecId, "métadonnées FLAC absentes");
      const a = piste.audio!;
      // `dfLa` = version/flags puis les blocs de métadonnées FLAC bruts.
      return {
        entree: entreeAudio("fLaC", a.canaux, a.frequence, a.bits ?? 16, boite("dfLa", pleine(0, 0), priv)),
        codec: "flac",
        type: "audio",
        timescale: Math.round(a.frequence),
      };
    }

    case "A_MPEG/L3": {
      const a = piste.audio!;
      // MP3 dans du MP4 : objectTypeIndication 0x6B, sans DecoderSpecificInfo.
      return {
        entree: entreeAudio("mp4a", a.canaux, a.frequence, 16, esds(new Uint8Array(0))),
        codec: "mp4a.40.34",
        type: "audio",
        timescale: Math.round(a.frequence),
      };
    }

    case "A_AC3": {
      const h = premiereTrame ? analyserAc3(premiereTrame) : null;
      if (!h) throw new CodecNonSupporte(piste.codecId, "en-tête AC-3 illisible");
      return {
        entree: entreeAudio("ac-3", h.canaux, h.frequence, 16, dac3(h)),
        codec: "ac-3",
        type: "audio",
        timescale: h.frequence,
      };
    }

    default:
      throw new CodecNonSupporte(
        piste.codecId,
        "aucune correspondance MP4 — remux impossible sans transcodage",
      );
  }
}

/** Le navigateur sait-il lire ce type MIME complet ? */
export function navigateurSupporte(mime: string): boolean {
  if (typeof MediaSource === "undefined") return false;
  return MediaSource.isTypeSupported(mime);
}

/** Type MIME MSE d'une ou deux descriptions. */
export function mimeDe(...descriptions: Description[]): string {
  const conteneur = descriptions.some((d) => d.type === "video") ? "video/mp4" : "audio/mp4";
  return `${conteneur}; codecs="${descriptions.map((d) => d.codec).join(",")}"`;
}
