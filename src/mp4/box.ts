/**
 * Écriture de boîtes ISO BMFF (« atomes » MP4).
 *
 * Une boîte, c'est : taille sur 4 octets, type sur 4 octets ASCII, puis le
 * contenu — éventuellement d'autres boîtes. Tout est gros-boutiste.
 */

export type Contenu = Uint8Array | number[];

const encodeur = new TextEncoder();

/** Concatène des morceaux en un seul tampon. */
export function joindre(...morceaux: Contenu[]): Uint8Array {
  let total = 0;
  for (const m of morceaux) total += m.length;
  const sortie = new Uint8Array(total);
  let pos = 0;
  for (const m of morceaux) {
    sortie.set(m instanceof Uint8Array ? m : new Uint8Array(m), pos);
    pos += m.length;
  }
  return sortie;
}

/** Fabrique une boîte : `[taille][type][contenu…]`. */
export function boite(type: string, ...contenu: Contenu[]): Uint8Array {
  let taille = 8;
  for (const c of contenu) taille += c.length;

  const sortie = new Uint8Array(taille);
  sortie[0] = (taille >>> 24) & 0xff;
  sortie[1] = (taille >>> 16) & 0xff;
  sortie[2] = (taille >>> 8) & 0xff;
  sortie[3] = taille & 0xff;
  sortie.set(encodeur.encode(type), 4);

  let pos = 8;
  for (const c of contenu) {
    sortie.set(c instanceof Uint8Array ? c : new Uint8Array(c), pos);
    pos += c.length;
  }
  return sortie;
}

/** Entier non signé 32 bits, gros-boutiste. */
export function u32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

export function u16(v: number): number[] {
  return [(v >>> 8) & 0xff, v & 0xff];
}

export function u8(v: number): number[] {
  return [v & 0xff];
}

/**
 * Entier 64 bits.
 *
 * Écrit en deux moitiés de 32 bits plutôt que via BigInt : les `tfdt` d'un film
 * de 3 h dépassent 2^32 en ticks de 90 kHz, mais restent très loin de 2^53, où
 * `Number` perd son exactitude.
 */
export function u64(v: number): number[] {
  const haut = Math.floor(v / 0x100000000);
  const bas = v % 0x100000000;
  return [...u32(haut), ...u32(bas >>> 0)];
}

/** Entête d'une « full box » : version sur 1 octet + flags sur 3. */
export function pleine(version: number, flags: number): number[] {
  return [version & 0xff, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff];
}

/** Chaîne ASCII de 4 caractères (types de boîte, marques de compatibilité). */
export function fourcc(s: string): Uint8Array {
  return encodeur.encode(s.padEnd(4, " ").slice(0, 4));
}

/**
 * Longueur au format « descripteur MPEG-4 » : 7 bits utiles par octet, le bit de
 * poids fort indiquant qu'un octet suit. Sert aux `esds` de l'AAC.
 */
export function longueurDescripteur(taille: number): number[] {
  const octets: number[] = [];
  let reste = taille;
  do {
    octets.unshift(reste & 0x7f);
    reste >>>= 7;
  } while (reste > 0);
  for (let i = 0; i < octets.length - 1; i++) octets[i] |= 0x80;
  return octets;
}

/** Descripteur MPEG-4 : `[tag][longueur][contenu]`. */
export function descripteur(tag: number, ...contenu: Contenu[]): Uint8Array {
  let taille = 0;
  for (const c of contenu) taille += c.length;
  return joindre([tag], longueurDescripteur(taille), ...contenu);
}
