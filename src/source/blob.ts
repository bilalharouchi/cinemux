import type { Source } from "./index";

/**
 * Source locale (`File` d'un `<input type=file>`, ou `Blob`).
 *
 * Sert au développement et au cas « glisse ton MKV dans la page » : aucun serveur,
 * et le seek est immédiat puisque tout est déjà sur le disque.
 */
export class SourceBlob implements Source {
  constructor(
    private readonly blob: Blob,
    /** Taille des morceaux lus. 1 Mo : assez gros pour ne pas hacher, assez
     *  petit pour ne pas bloquer le fil principal sur un gros `arrayBuffer`. */
    private readonly tailleMorceau = 1024 * 1024,
  ) {}

  async taille(): Promise<number> {
    return this.blob.size;
  }

  async supportePlages(): Promise<boolean> {
    return true; // un Blob se découpe librement
  }

  async lire(debut: number, fin: number): Promise<Uint8Array> {
    // `fin` est inclusive côté HTTP : on s'aligne pour que les deux sources
    // s'utilisent exactement pareil.
    const morceau = this.blob.slice(debut, Math.min(fin + 1, this.blob.size));
    return new Uint8Array(await morceau.arrayBuffer());
  }

  async *flux(debut: number, signal?: AbortSignal): AsyncIterableIterator<Uint8Array> {
    let pos = debut;
    while (pos < this.blob.size) {
      if (signal?.aborted) return;
      const fin = Math.min(pos + this.tailleMorceau, this.blob.size);
      const morceau = this.blob.slice(pos, fin);
      yield new Uint8Array(await morceau.arrayBuffer());
      pos = fin;
    }
  }
}
