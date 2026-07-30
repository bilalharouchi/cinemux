/**
 * Lecture des primitives EBML.
 *
 * EBML encode les longueurs en « vint » : le nombre de zéros de tête du premier
 * octet donne le nombre total d'octets, le premier bit à 1 étant un marqueur.
 * Deux règles distinctes, souvent confondues :
 *   - pour un **ID**, on garde le marqueur (l'ID inclut son en-tête) ;
 *   - pour une **taille**, on le retire (c'est un nombre).
 *
 * Toutes les lectures peuvent manquer de données : elles renvoient `null` plutôt
 * que de lever, parce que le démultiplexeur travaille sur un flux incomplet et
 * doit pouvoir attendre la suite.
 */

/** Taille inconnue (tous les bits de données à 1) — les Segment et Cluster en direct l'utilisent. */
export const UNKNOWN_SIZE = -1;

export class EbmlReader {
  /** Position de lecture, en octets depuis le début de `data`. */
  pos = 0;

  constructor(
    public data: Uint8Array,
    /** Décalage de `data[0]` dans le fichier complet — sert aux positions absolues (Cues). */
    readonly baseOffset = 0,
  ) {}

  get reste(): number {
    return this.data.length - this.pos;
  }

  /** Position absolue dans le fichier. */
  get positionAbsolue(): number {
    return this.baseOffset + this.pos;
  }

  /** Nombre d'octets d'un vint d'après son premier octet. 0 = octet invalide. */
  private static longueurVint(premier: number): number {
    if (premier === 0) return 0; // 8+ octets : hors spec pratique
    return 8 - Math.floor(Math.log2(premier));
  }

  /**
   * Lit un ID d'élément — marqueur conservé.
   * `null` si les octets manquent (on réessaiera avec plus de données).
   */
  lireId(): number | null {
    if (this.reste < 1) return null;
    const premier = this.data[this.pos];
    const longueur = EbmlReader.longueurVint(premier);
    if (longueur === 0 || longueur > 4) return null; // EBMLMaxIDLength = 4
    if (this.reste < longueur) return null;

    let valeur = 0;
    for (let i = 0; i < longueur; i++) valeur = valeur * 256 + this.data[this.pos + i];
    this.pos += longueur;
    return valeur;
  }

  /**
   * Lit une taille d'élément — marqueur retiré.
   * Renvoie [UNKNOWN_SIZE] quand tous les bits de données valent 1.
   */
  lireTaille(): number | null {
    if (this.reste < 1) return null;
    const premier = this.data[this.pos];
    const longueur = EbmlReader.longueurVint(premier);
    if (longueur === 0 || longueur > 8) return null;
    if (this.reste < longueur) return null;

    // Retire le bit marqueur du premier octet.
    let valeur = premier & ((1 << (8 - longueur)) - 1);
    let tousUns = valeur === (1 << (8 - longueur)) - 1;

    for (let i = 1; i < longueur; i++) {
      const octet = this.data[this.pos + i];
      // Number reste exact jusqu'à 2^53 : suffisant pour des tailles de fichier.
      valeur = valeur * 256 + octet;
      if (octet !== 0xff) tousUns = false;
    }
    this.pos += longueur;
    return tousUns ? UNKNOWN_SIZE : valeur;
  }

  /** Entier non signé gros-boutiste sur `n` octets. */
  lireUint(n: number): number {
    let valeur = 0;
    for (let i = 0; i < n; i++) valeur = valeur * 256 + this.data[this.pos + i];
    this.pos += n;
    return valeur;
  }

  /** Entier signé gros-boutiste (complément à deux) sur `n` octets. */
  lireInt(n: number): number {
    if (n === 0) return 0;
    let valeur = this.data[this.pos];
    if (valeur & 0x80) valeur -= 0x100; // signe porté par le premier octet
    for (let i = 1; i < n; i++) valeur = valeur * 256 + this.data[this.pos + i];
    this.pos += n;
    return valeur;
  }

  /** Flottant EBML : 4 ou 8 octets. Toute autre taille vaut 0 (spec : 0 octet = 0). */
  lireFloat(n: number): number {
    const vue = new DataView(this.data.buffer, this.data.byteOffset + this.pos, n);
    this.pos += n;
    if (n === 4) return vue.getFloat32(0, false);
    if (n === 8) return vue.getFloat64(0, false);
    return 0;
  }

  lireChaine(n: number): string {
    const octets = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    // Les chaînes Matroska peuvent être complétées par des zéros.
    let fin = octets.length;
    while (fin > 0 && octets[fin - 1] === 0) fin--;
    return new TextDecoder().decode(octets.subarray(0, fin));
  }

  lireOctets(n: number): Uint8Array {
    // `slice` et non `subarray` : la donnée survit au tampon de flux qui sera recyclé.
    const octets = this.data.slice(this.pos, this.pos + n);
    this.pos += n;
    return octets;
  }

  /** Vint « signé » d'un lacing EBML : décalé de la moitié de sa plage. */
  lireVintSigne(): number | null {
    const avant = this.pos;
    const brut = this.lireTaille();
    if (brut === null) return null;
    const longueur = this.pos - avant;
    // Décalage spec : 2^(7n-1) - 1
    return brut - (Math.pow(2, 7 * longueur - 1) - 1);
  }
}

/** Écrit un vint de taille EBML — utilisé par les tests pour fabriquer des fichiers. */
export function ecrireTaille(valeur: number, longueurForcee?: number): Uint8Array {
  let longueur = longueurForcee ?? 1;
  if (!longueurForcee) {
    while (valeur >= Math.pow(2, 7 * longueur) - 1) longueur++;
  }
  const sortie = new Uint8Array(longueur);
  let reste = valeur;
  for (let i = longueur - 1; i >= 0; i--) {
    sortie[i] = reste % 256;
    reste = Math.floor(reste / 256);
  }
  sortie[0] |= 1 << (8 - longueur); // marqueur
  return sortie;
}
