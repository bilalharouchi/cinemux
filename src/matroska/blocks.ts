import { EbmlReader } from "../ebml/reader.js";

/**
 * Décodage d'un SimpleBlock / Block Matroska.
 *
 * Un bloc peut contenir PLUSIEURS trames grâce au « lacing » — trois encodages
 * différents, tous utilisés en pratique (Xiph par les vieux muxers, EBML par
 * mkvmerge, fixe par l'audio à débit constant). Ignorer le lacing, c'est produire
 * une piste audio hachée qui « marche presque » : le pire des bugs.
 */

export type BlocDecode = {
  trackNumber: number;
  /** Décalage en Track Ticks par rapport au timestamp du Cluster. Peut être négatif. */
  timestampRelatif: number;
  keyframe: boolean;
  invisible: boolean;
  /** Une entrée par trame — le lacing peut en produire plusieurs. */
  trames: Uint8Array[];
};

const LACING_AUCUN = 0;
const LACING_XIPH = 1;
const LACING_FIXE = 2;
const LACING_EBML = 3;

/**
 * @param donnees contenu du SimpleBlock/Block, sans son en-tête d'élément
 * @param simple `true` pour un SimpleBlock (les flags portent le keyframe),
 *               `false` pour un Block dans un BlockGroup (keyframe déduit ailleurs)
 */
export function decoderBloc(donnees: Uint8Array, simple: boolean): BlocDecode | null {
  const r = new EbmlReader(donnees);

  const trackNumber = r.lireTaille(); // le numéro de piste est un vint
  if (trackNumber === null) return null;
  if (r.reste < 3) return null;

  const timestampRelatif = r.lireInt(2);
  const flags = r.data[r.pos++];

  const keyframe = simple ? (flags & 0x80) !== 0 : false;
  const invisible = (flags & 0x08) !== 0;
  const lacing = (flags >> 1) & 0x03;

  if (lacing === LACING_AUCUN) {
    return {
      trackNumber,
      timestampRelatif,
      keyframe,
      invisible,
      trames: [r.lireOctets(r.reste)],
    };
  }

  if (r.reste < 1) return null;
  // « nombre de trames - 1 » : un bloc lacé en contient toujours au moins deux.
  const nbTrames = r.data[r.pos++] + 1;
  const tailles: number[] = [];

  if (lacing === LACING_XIPH) {
    // Xiph : chaque taille est une suite d'octets 255 terminée par < 255.
    for (let i = 0; i < nbTrames - 1; i++) {
      let taille = 0;
      let octet = 255;
      while (octet === 255) {
        if (r.reste < 1) return null;
        octet = r.data[r.pos++];
        taille += octet;
      }
      tailles.push(taille);
    }
  } else if (lacing === LACING_EBML) {
    // EBML : première taille en vint absolu, les suivantes en écart SIGNÉ.
    const premiere = r.lireTaille();
    if (premiere === null) return null;
    tailles.push(premiere);
    for (let i = 1; i < nbTrames - 1; i++) {
      const ecart = r.lireVintSigne();
      if (ecart === null) return null;
      tailles.push(tailles[i - 1] + ecart);
    }
  } else {
    // Fixe : toutes les trames font la même taille, aucune n'est stockée.
    const taille = Math.floor(r.reste / nbTrames);
    for (let i = 0; i < nbTrames - 1; i++) tailles.push(taille);
  }

  const trames: Uint8Array[] = [];
  for (const taille of tailles) {
    if (taille < 0 || taille > r.reste) return null; // fichier corrompu
    trames.push(r.lireOctets(taille));
  }
  // La dernière trame prend tout le reste : sa taille n'est jamais stockée.
  trames.push(r.lireOctets(r.reste));

  return { trackNumber, timestampRelatif, keyframe, invisible, trames };
}
