import type { Source } from "./index";

/**
 * Source HTTP avec requêtes partielles (`Range`).
 *
 * Le seek en dépend entièrement : sans `Accept-Ranges: bytes` côté serveur, on ne
 * peut que lire le fichier du début, et sauter à 1 h 30 de film voudrait dire
 * télécharger 1 h 30 de vidéo. La classe le vérifie et le dit franchement.
 */
export class SourceHttp implements Source {
  private tailleConnue: number | null | undefined;
  private plagesOk: boolean | undefined;

  constructor(
    readonly url: string,
    private readonly entetes: Record<string, string> = {},
  ) {}

  /**
   * Sonde la source. On tente un HEAD, puis on se rabat sur un GET de 1 octet :
   * beaucoup de serveurs (et les URL signées de CDN) refusent HEAD tout en
   * gérant parfaitement les Range.
   */
  private async sonder(): Promise<void> {
    if (this.tailleConnue !== undefined) return;

    const lireEntetes = (res: Response) => {
      const longueur = res.headers.get("content-length");
      const plage = res.headers.get("content-range");
      this.plagesOk =
        res.status === 206 || (res.headers.get("accept-ranges") ?? "").includes("bytes");
      if (plage) {
        // Content-Range: bytes 0-0/123456 → la taille est après la barre.
        const total = plage.split("/")[1];
        this.tailleConnue = total && total !== "*" ? Number(total) : null;
      } else {
        this.tailleConnue = longueur ? Number(longueur) : null;
      }
    };

    try {
      const head = await fetch(this.url, { method: "HEAD", headers: this.entetes });
      if (head.ok) {
        lireEntetes(head);
        if (this.tailleConnue) return;
      }
    } catch {
      // HEAD refusé : on continue en GET partiel.
    }

    const res = await fetch(this.url, {
      headers: { ...this.entetes, Range: "bytes=0-0" },
    });
    lireEntetes(res);
    // Le corps de 1 octet doit être consommé, sinon la connexion reste ouverte.
    await res.arrayBuffer().catch(() => undefined);
  }

  async taille(): Promise<number | null> {
    await this.sonder();
    return this.tailleConnue ?? null;
  }

  async supportePlages(): Promise<boolean> {
    await this.sonder();
    return this.plagesOk ?? false;
  }

  async lire(debut: number, fin: number, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await fetch(this.url, {
      headers: { ...this.entetes, Range: `bytes=${debut}-${fin}` },
      signal,
    });
    if (!res.ok) throw new Error(`plage ${debut}-${fin} refusée : HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async *flux(debut: number, signal?: AbortSignal): AsyncIterableIterator<Uint8Array> {
    const entetes = { ...this.entetes };
    // `bytes=N-` : à partir de N jusqu'à la fin. Omis quand on part de zéro, pour
    // ne pas exiger le support des plages inutilement.
    if (debut > 0) entetes.Range = `bytes=${debut}-`;

    const res = await fetch(this.url, { headers: entetes, signal });
    if (!res.ok) throw new Error(`lecture refusée : HTTP ${res.status}`);
    if (!res.body) throw new Error("réponse sans corps");

    const lecteur = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await lecteur.read();
        if (done) return;
        if (value) yield value;
      }
    } finally {
      // Abandonner l'itérateur (seek, fermeture) doit couper le téléchargement,
      // sinon on continue à consommer la bande passante pour rien.
      await lecteur.cancel().catch(() => undefined);
    }
  }
}
