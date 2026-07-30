import { boite, joindre, pleine, u16, u32, u64, u8, fourcc } from "./box.js";
import type { Description } from "../codecs/index.js";

/**
 * Écriture de fMP4 (MP4 fragmenté) pour MediaSource.
 *
 * Un flux MSE se compose de deux choses :
 *   - un **segment d'initialisation** : `ftyp` + `moov`, décrit les pistes ;
 *   - des **segments média** : `moof` + `mdat`, portent les échantillons.
 * Le `moov` doit contenir un `mvex`/`trex`, sans quoi le navigateur lit le film
 * comme un MP4 classique et attend une table d'échantillons qui n'existe pas.
 */

export type PisteMux = {
  /** Identifiant MP4 (1-based, indépendant du numéro Matroska). */
  id: number;
  description: Description;
};

export type EchantillonMux = {
  /** Présentation, dans le timescale de la piste. */
  pts: number;
  /** Décodage, dans le timescale de la piste. */
  dts: number;
  duree: number;
  keyframe: boolean;
  donnees: Uint8Array;
};

/** Timescale du film : 1 ms, lisible et suffisant pour l'entête. */
const TIMESCALE_FILM = 1000;

const MATRICE_IDENTITE = [
  ...u32(0x00010000), ...u32(0), ...u32(0),
  ...u32(0), ...u32(0x00010000), ...u32(0),
  ...u32(0), ...u32(0), ...u32(0x40000000),
];

function mvhd(dureeMs: number): Uint8Array {
  return boite(
    "mvhd",
    pleine(0, 0),
    u32(0), // creation_time
    u32(0), // modification_time
    u32(TIMESCALE_FILM),
    u32(Math.max(0, Math.round(dureeMs))),
    u32(0x00010000), // rate 1.0
    u16(0x0100), // volume 1.0
    u16(0), // reserved
    u32(0),
    u32(0), // reserved
    MATRICE_IDENTITE,
    u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), // pre_defined
    // next_track_ID : 0xffffffff dit « je ne sais pas », ce qui est vrai en fragmenté.
    u32(0xffffffff),
  );
}

function tkhd(piste: PisteMux, dureeMs: number): Uint8Array {
  const estVideo = piste.description.type === "video";
  // Dimensions en 16.16, relues dans l'entrée d'échantillon (offsets fixes).
  const largeur = estVideo ? lireU16(piste.description.entree, 32) : 0;
  const hauteur = estVideo ? lireU16(piste.description.entree, 34) : 0;

  return boite(
    "tkhd",
    pleine(0, 0x000007), // enabled | in_movie | in_preview
    u32(0),
    u32(0),
    u32(piste.id),
    u32(0), // reserved
    u32(Math.max(0, Math.round(dureeMs))),
    u32(0),
    u32(0), // reserved
    u16(0), // layer
    u16(0), // alternate_group
    u16(estVideo ? 0 : 0x0100), // volume : 1.0 pour l'audio, 0 pour la vidéo
    u16(0), // reserved
    MATRICE_IDENTITE,
    u32(largeur << 16),
    u32(hauteur << 16),
  );
}

function lireU16(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 8) | buf[offset + 1];
}

function mdhd(timescale: number, dureeMs: number): Uint8Array {
  return boite(
    "mdhd",
    pleine(0, 0),
    u32(0),
    u32(0),
    u32(timescale),
    u32(Math.max(0, Math.round((dureeMs / 1000) * timescale))),
    // Langue « und » en code 5 bits par lettre : (u-0x60)<<10 | (n-0x60)<<5 | (d-0x60)
    u16(0x55c4),
    u16(0), // pre_defined
  );
}

function hdlr(type: "video" | "audio"): Uint8Array {
  return boite(
    "hdlr",
    pleine(0, 0),
    u32(0), // pre_defined
    fourcc(type === "video" ? "vide" : "soun"),
    u32(0), u32(0), u32(0), // reserved
    // Nom lisible, terminé par un zéro.
    new TextEncoder().encode(type === "video" ? "CinemuxVideo\0" : "CinemuxAudio\0"),
  );
}

function dinf(): Uint8Array {
  // `dref` avec une `url ` auto-référente : les données sont dans ce fichier.
  const url = boite("url ", pleine(0, 0x000001));
  return boite("dinf", boite("dref", pleine(0, 0), u32(1), url));
}

function stbl(entree: Uint8Array): Uint8Array {
  return boite(
    "stbl",
    boite("stsd", pleine(0, 0), u32(1), entree),
    // Tables vides : en fragmenté, tout est décrit dans les `trun`.
    boite("stts", pleine(0, 0), u32(0)),
    boite("stsc", pleine(0, 0), u32(0)),
    boite("stsz", pleine(0, 0), u32(0), u32(0)),
    boite("stco", pleine(0, 0), u32(0)),
  );
}

function trak(piste: PisteMux, dureeMs: number): Uint8Array {
  const d = piste.description;
  const entete = d.type === "video"
    ? boite("vmhd", pleine(0, 1), u16(0), u16(0), u16(0), u16(0))
    : boite("smhd", pleine(0, 0), u16(0), u16(0));

  return boite(
    "trak",
    tkhd(piste, dureeMs),
    boite(
      "mdia",
      mdhd(d.timescale, dureeMs),
      hdlr(d.type),
      boite("minf", entete, dinf(), stbl(d.entree)),
    ),
  );
}

function mvex(pistes: PisteMux[]): Uint8Array {
  const trexs = pistes.map((p) =>
    boite(
      "trex",
      pleine(0, 0),
      u32(p.id),
      u32(1), // default_sample_description_index
      u32(0), // default_sample_duration
      u32(0), // default_sample_size
      u32(0), // default_sample_flags
    ),
  );
  return boite("mvex", ...trexs);
}

/**
 * Segment d'initialisation : `ftyp` + `moov`.
 * `iso6` dans les marques de compatibilité : c'est ce que réclament les
 * implémentations MSE pour accepter du fragmenté.
 */
export function segmentInit(pistes: PisteMux[], dureeMs = 0): Uint8Array {
  const ftyp = boite("ftyp", fourcc("isom"), u32(0x200), fourcc("isom"), fourcc("iso2"), fourcc("iso6"), fourcc("mp41"));
  const moov = boite("moov", mvhd(dureeMs), ...pistes.map((p) => trak(p, dureeMs)), mvex(pistes));
  return joindre(ftyp, moov);
}

// ---------------------------------------------------------------------------
// Segments média
// ---------------------------------------------------------------------------

/** Drapeaux `trun` : offset de données, puis durée/taille/flags/décalage CTS par échantillon. */
const TRUN_FLAGS = 0x000001 | 0x000100 | 0x000200 | 0x000400 | 0x000800;

/** Un échantillon non-clé dépend d'autres images : le dire évite un décodage à contresens. */
const FLAGS_ECHANTILLON_CLE = 0x02000000;
const FLAGS_ECHANTILLON_NON_CLE = 0x01010000;

export type FragmentPiste = {
  piste: PisteMux;
  echantillons: EchantillonMux[];
};

/**
 * Segment média : un `moof` puis un `mdat` unique.
 *
 * Toutes les pistes du fragment partagent le `mdat` : c'est ce qu'attendent les
 * implémentations MSE, et ça évite un segment par piste (donc deux SourceBuffer
 * à synchroniser à la main).
 */
export function segmentMedia(numeroSequence: number, fragments: FragmentPiste[]): Uint8Array {
  const utiles = fragments.filter((f) => f.echantillons.length > 0);
  if (utiles.length === 0) return new Uint8Array(0);

  const mfhd = boite("mfhd", pleine(0, 0), u32(numeroSequence));

  // Le `data_offset` d'un `trun` se compte depuis le début du `moof`. Or il faut
  // connaître la taille du `moof` pour l'écrire… qui dépend des `trun`. On écrit
  // donc une première fois avec 0, on mesure, puis on réécrit.
  const construire = (offsetsData: number[]): Uint8Array => {
    const trafs = utiles.map((f, i) => traf(f, offsetsData[i]));
    return boite("moof", mfhd, ...trafs);
  };

  const provisoire = construire(utiles.map(() => 0));
  const tailleMoof = provisoire.length;

  // Chaque piste commence là où finit la précédente dans le `mdat`.
  const offsets: number[] = [];
  let curseur = tailleMoof + 8; // + en-tête du mdat
  for (const f of utiles) {
    offsets.push(curseur);
    for (const e of f.echantillons) curseur += e.donnees.length;
  }

  const moof = construire(offsets);
  // Garde-fou : si la taille a bougé, les offsets sont faux et l'image se corromprait
  // silencieusement. Mieux vaut échouer bruyamment.
  if (moof.length !== tailleMoof) {
    throw new Error("taille du moof instable — offsets de données invalides");
  }

  const donnees: Uint8Array[] = [];
  for (const f of utiles) for (const e of f.echantillons) donnees.push(e.donnees);
  return joindre(moof, boite("mdat", ...donnees));
}

function traf(f: FragmentPiste, offsetData: number): Uint8Array {
  const premier = f.echantillons[0];

  const tfhd = boite(
    "tfhd",
    // 0x020000 = default-base-is-moof : les offsets partent du `moof`, pas du
    // fichier. Indispensable, on ne connaît pas notre position absolue.
    pleine(0, 0x020000),
    u32(f.piste.id),
  );

  // Version 1 : baseMediaDecodeTime sur 64 bits. Un film de 3 h en 90 kHz fait
  // 972 millions de ticks — ça tient sur 32 bits, mais pas un concert de 6 h en
  // 48 kHz cumulé. Le 64 bits coûte 4 octets par fragment, on ne discute pas.
  const tfdt = boite("tfdt", pleine(1, 0), u64(Math.max(0, premier.dts)));

  const entrees: number[] = [];
  for (const e of f.echantillons) {
    entrees.push(
      ...u32(e.duree),
      ...u32(e.donnees.length),
      ...u32(e.keyframe ? FLAGS_ECHANTILLON_CLE : FLAGS_ECHANTILLON_NON_CLE),
      // Décalage CTS signé (version 1) : PTS - DTS. Nul sans images B.
      ...u32(e.pts - e.dts),
    );
  }

  const trun = boite(
    "trun",
    pleine(1, TRUN_FLAGS),
    u32(f.echantillons.length),
    u32(offsetData),
    entrees,
  );

  return boite("traf", tfhd, tfdt, trun);
}

/**
 * Reconstruit les DTS à partir des seuls PTS.
 *
 * POURQUOI — Matroska ne stocke QUE des timestamps de présentation, alors que
 * MP4 exige des timestamps de décodage plus un décalage. Avec des images B, les
 * deux diffèrent : poser DTS = PTS ferait afficher les images dans l'ordre de
 * décodage, soit une saccade permanente sur tout encodage moderne.
 *
 * L'astuce : sur un groupe d'images fermé, l'ENSEMBLE des PTS égale l'ensemble
 * des DTS — seul l'ordre change. Les PTS triés, réattribués dans l'ordre de
 * décodage, donnent donc des DTS croissants et exacts.
 */
export function reconstruireDts(ptsOrdreDecodage: number[]): number[] {
  const tries = [...ptsOrdreDecodage].sort((a, b) => a - b);
  return tries;
}
