/**
 * Source d'octets.
 *
 * Abstraite pour deux raisons : lire un fichier local pendant le développement
 * sans serveur, et surtout pouvoir sauter dans le fichier (`lire(debut, fin)`)
 * plutôt que de le télécharger en entier — c'est ce qui rend le seek possible
 * sur un film de 3 Go.
 */
export interface Source {
  /** Taille totale en octets, ou null si le serveur ne la donne pas. */
  taille(): Promise<number | null>;

  /** Le serveur accepte-t-il les requêtes partielles ? Sans ça, pas de seek. */
  supportePlages(): Promise<boolean>;

  /**
   * Flux d'octets à partir de `debut`.
   * L'itérateur doit s'arrêter proprement si on l'abandonne (`return`).
   */
  flux(debut: number, signal?: AbortSignal): AsyncIterableIterator<Uint8Array>;

  /** Lecture d'une plage précise — sert à récupérer l'index Cues. */
  lire(debut: number, fin: number, signal?: AbortSignal): Promise<Uint8Array>;
}

export { SourceHttp } from "./http";
export { SourceBlob } from "./blob";
