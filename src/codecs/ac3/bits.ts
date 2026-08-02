/**
 * Lecteur de bits gros-boutiste.
 *
 * L'AC-3 est un format à champs non alignés : `fscod` fait 2 bits, `frmsizecod`
 * 6, `dialnorm` 5… Impossible de le lire octet par octet. Et comme le nombre de
 * bits de chaque mantisse dépend de l'allocation calculée juste avant, la
 * position doit être exacte au bit près : une erreur d'un seul bit décale tout
 * le reste de la trame.
 */
export class LecteurBits {
  private octet = 0;
  private bit = 0;

  constructor(private readonly data: Uint8Array) {}

  /** Position courante, en bits depuis le début. */
  get position(): number {
    return this.octet * 8 + this.bit;
  }

  set position(p: number) {
    this.octet = p >> 3;
    this.bit = p & 7;
  }

  get bitsRestants(): number {
    return this.data.length * 8 - this.position;
  }

  /** Lit `n` bits (0 ≤ n ≤ 32) sans consommer au-delà du tampon. */
  lire(n: number): number {
    let valeur = 0;
    for (let i = 0; i < n; i++) {
      const o = this.data[this.octet];
      // Au-delà du tampon on renvoie des zéros : un flux tronqué ne doit pas
      // lever, le décodeur s'en apercevra en contrôlant la taille de trame.
      const b = o === undefined ? 0 : (o >> (7 - this.bit)) & 1;
      valeur = valeur * 2 + b;
      if (++this.bit === 8) {
        this.bit = 0;
        this.octet++;
      }
    }
    return valeur;
  }

  /** Lit 1 bit comme booléen — la forme la plus fréquente dans l'AC-3. */
  drapeau(): boolean {
    return this.lire(1) === 1;
  }

  sauter(n: number): void {
    this.position = this.position + n;
  }
}
