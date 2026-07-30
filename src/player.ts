import { Remuxer, type Diagnostic } from "./remuxer.js";
import { MatroskaDemuxer, type PointCue } from "./matroska/demuxer.js";
import { ID } from "./ebml/ids.js";
import type { Source } from "./source/index.js";

/**
 * Branche un MKV sur un `<video>` via MediaSource.
 *
 * L'intérêt de passer par un vrai élément `<video>` plutôt qu'un canvas : on
 * hérite gratuitement des contrôles natifs, du plein écran, de l'image dans
 * l'image, de la piste de sous-titres, du casting et des raccourcis clavier. Un
 * lecteur maison devrait tout réimplémenter, et moins bien.
 */

export type OptionsLecture = {
  /** Langue audio préférée quand le fichier en propose plusieurs. */
  languePreferee?: string;
  /**
   * Avance de tampon visée, en secondes. Au-delà, on arrête de télécharger :
   * inutile de tirer 3 Go quand l'utilisateur va peut-être arrêter dans 10 s.
   */
  avanceCibleS?: number;
  /** Mémoire conservée derrière la tête de lecture, en secondes. */
  retenueS?: number;
  onDiagnostic?: (d: Diagnostic) => void;
  onErreur?: (e: Error) => void;
};

/** Octets lus au démarrage pour trouver les pistes et le SeekHead. */
const TAILLE_ENTETE = 256 * 1024;

export class Cinemux {
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private remuxer: Remuxer | null = null;
  private urlObjet: string | null = null;

  private cues: PointCue[] = [];
  private echelleCues = 1_000_000;
  private fileSegments: Uint8Array[] = [];
  private enAjout = false;
  private pompeEnCours: AbortController | null = null;
  private detache = false;
  private diag: Diagnostic | null = null;
  private finFlux = false;

  private constructor(
    private readonly video: HTMLVideoElement,
    private readonly source: Source,
    private readonly opt: OptionsLecture,
  ) {}

  static async attacher(
    video: HTMLVideoElement,
    source: Source,
    options: OptionsLecture = {},
  ): Promise<Cinemux> {
    const instance = new Cinemux(video, source, options);
    await instance.demarrer();
    return instance;
  }

  get diagnostic(): Diagnostic | null {
    return this.diag;
  }

  /** Le seek est-il possible ? Faux si le serveur ignore les Range ou s'il n'y a pas d'index. */
  get seekPossible(): boolean {
    return this.cues.length > 0;
  }

  detacher() {
    this.detache = true;
    this.pompeEnCours?.abort();
    this.video.removeEventListener("seeking", this.surSeek);
    this.video.removeEventListener("timeupdate", this.surTemps);
    if (this.urlObjet) URL.revokeObjectURL(this.urlObjet);
    try {
      if (this.mediaSource?.readyState === "open") this.mediaSource.endOfStream();
    } catch {
      // MediaSource déjà fermé : rien à faire.
    }
    this.video.removeAttribute("src");
    this.video.load();
  }

  // -------------------------------------------------------------------------

  private async demarrer() {
    if (typeof MediaSource === "undefined") {
      throw new Error("MediaSource indisponible dans ce navigateur");
    }

    // L'index de seek AVANT la lecture : il vit à la fin du fichier, et le
    // récupérer une fois la lecture lancée volerait de la bande passante à
    // l'image. Un échec n'est pas bloquant — on jouera sans pouvoir sauter.
    await this.chargerIndex().catch(() => undefined);

    this.mediaSource = new MediaSource();
    this.urlObjet = URL.createObjectURL(this.mediaSource);

    const ouvert = new Promise<void>((resolve) => {
      this.mediaSource!.addEventListener("sourceopen", () => resolve(), { once: true });
    });
    this.video.src = this.urlObjet;
    await ouvert;

    this.video.addEventListener("seeking", this.surSeek);
    this.video.addEventListener("timeupdate", this.surTemps);

    this.demarrerPompe(0);
  }

  /**
   * Récupère l'index Cues sans télécharger le film.
   *
   * Deux requêtes : l'en-tête (où vit le SeekHead, qui dit OÙ sont les Cues), puis
   * la plage des Cues elles-mêmes. Sur un fichier de 3 Go, ça coûte quelques
   * centaines de Ko au lieu de tout.
   */
  private async chargerIndex() {
    if (!(await this.source.supportePlages())) return;
    const taille = await this.source.taille();
    if (!taille) return;

    const entete = await this.source.lire(0, Math.min(TAILLE_ENTETE, taille) - 1);
    const sondeur = new MatroskaDemuxer();
    sondeur.alimenter(entete);
    this.echelleCues = sondeur.timestampScale;

    const positionCues = sondeur.seekHead.get(ID.Cues);
    if (positionCues == null || positionCues >= taille) return;

    // Les Cues s'étendent jusqu'à un autre élément ou la fin : on prend large et
    // le démultiplexeur s'arrêtera de lui-même sur ce qu'il comprend.
    const finCues = Math.min(positionCues + 8 * 1024 * 1024, taille) - 1;
    const octets = await this.source.lire(positionCues, finCues);

    const lecteurCues = new MatroskaDemuxer();
    // Le démultiplexeur attend des positions absolues : on lui dit où il se trouve
    // et on lui redonne l'origine du Segment lue dans l'en-tête.
    lecteurCues.repositionner(positionCues);
    lecteurCues.positionSegment = sondeur.positionSegment;
    lecteurCues.timestampScale = sondeur.timestampScale;
    lecteurCues.alimenter(octets);

    if (lecteurCues.cues.length > 0) this.cues = lecteurCues.cues;
  }

  private nouveauRemuxer(): Remuxer {
    return new Remuxer({
      languePreferee: this.opt.languePreferee,
      onInit: (segment, diag) => {
        this.diag = diag;
        this.opt.onDiagnostic?.(diag);

        if (!this.sourceBuffer && this.mediaSource?.readyState === "open") {
          if (!MediaSource.isTypeSupported(diag.mime)) {
            // `diag.mime` ne décrit déjà plus que les pistes muxées : si ça échoue
            // encore, c'est la VIDÉO que ce navigateur ne prend pas.
            const v = diag.video;
            this.opt.onErreur?.(
              new Error(
                v
                  ? `Ce navigateur ne décode pas cette vidéo (${v.piste.codecId} → ${v.description.codec}). ` +
                    "Sur un autre appareil ou une autre version, elle passerait."
                  : `Aucun codec exploitable : ${diag.mime}`,
              ),
            );
            return;
          }
          this.sourceBuffer = this.mediaSource.addSourceBuffer(diag.mime);
          this.sourceBuffer.mode = "segments";
          this.sourceBuffer.addEventListener("updateend", () => {
            this.enAjout = false;
            this.pousserSuivant();
          });
          if (diag.dureeMs) {
            try {
              this.mediaSource.duration = diag.dureeMs / 1000;
            } catch {
              // Durée refusée (MediaSource occupé) : le navigateur la déduira.
            }
          }
        }
        this.fileSegments.push(segment);
        this.pousserSuivant();
      },
      onSegment: (segment) => {
        this.fileSegments.push(segment);
        this.pousserSuivant();
      },
      onErreur: (e) => this.opt.onErreur?.(e),
    });
  }

  /** Empile les segments un par un : `appendBuffer` refuse d'être concurrent. */
  private pousserSuivant() {
    if (this.detache || this.enAjout) return;
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || this.mediaSource?.readyState !== "open") return;

    const segment = this.fileSegments.shift();
    if (!segment) {
      if (this.finFlux) this.terminerFlux();
      return;
    }

    this.enAjout = true;
    try {
      sb.appendBuffer(segment as unknown as BufferSource);
    } catch (e) {
      this.enAjout = false;
      if (e instanceof DOMException && e.name === "QuotaExceededError") {
        // Tampon plein : on libère derrière la tête de lecture et on réessaiera.
        this.fileSegments.unshift(segment);
        this.libererMemoire(true);
        return;
      }
      this.opt.onErreur?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private terminerFlux() {
    if (this.mediaSource?.readyState !== "open") return;
    if (this.sourceBuffer?.updating) return;
    try {
      this.mediaSource.endOfStream();
    } catch {
      // Déjà terminé.
    }
  }

  /**
   * Boucle de téléchargement : lit la source, remuxe, et s'interrompt dès que le
   * tampon est assez garni. C'est ce qui évite de tirer tout le film.
   */
  private async demarrerPompe(offsetDepart: number) {
    this.pompeEnCours?.abort();
    const controleur = new AbortController();
    this.pompeEnCours = controleur;

    this.remuxer = this.nouveauRemuxer();
    this.finFlux = false;
    // Un seek repart d'un Cluster : le remuxeur doit oublier ses tampons, sinon
    // il collerait des échantillons d'avant le saut à ceux d'après.
    if (offsetDepart > 0) this.remuxer.repositionner(offsetDepart);

    try {
      for await (const morceau of this.source.flux(offsetDepart, controleur.signal)) {
        if (controleur.signal.aborted || this.detache) return;
        this.remuxer.alimenter(morceau);
        await this.attendreSiRassasie(controleur.signal);
      }
      if (!controleur.signal.aborted) {
        this.remuxer.terminer();
        this.finFlux = true;
        this.pousserSuivant();
      }
    } catch (e) {
      if (controleur.signal.aborted || this.detache) return;
      this.opt.onErreur?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** Suspend la lecture de la source tant qu'on a assez d'avance. */
  private async attendreSiRassasie(signal: AbortSignal) {
    const cible = this.opt.avanceCibleS ?? 30;
    while (!signal.aborted && this.avance() > cible) {
      this.libererMemoire(false);
      await new Promise<void>((resolve) => {
        const fini = () => resolve();
        // Réveil sur avancement de la lecture ou sur seek.
        this.video.addEventListener("timeupdate", fini, { once: true });
        this.video.addEventListener("seeking", fini, { once: true });
        setTimeout(fini, 500); // filet : vidéo en pause, aucun événement
      });
    }
  }

  /** Secondes déjà tamponnées devant la tête de lecture. */
  private avance(): number {
    const sb = this.sourceBuffer;
    if (!sb) return 0;
    const t = this.video.currentTime;
    for (let i = 0; i < sb.buffered.length; i++) {
      if (t >= sb.buffered.start(i) - 0.5 && t <= sb.buffered.end(i)) {
        return sb.buffered.end(i) - t;
      }
    }
    return 0;
  }

  /** Rend la mémoire des plages loin derrière la tête de lecture. */
  private libererMemoire(agressif: boolean) {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating) return;
    const retenue = agressif ? 5 : (this.opt.retenueS ?? 60);
    const limite = this.video.currentTime - retenue;
    if (limite <= 0) return;

    for (let i = 0; i < sb.buffered.length; i++) {
      const debut = sb.buffered.start(i);
      const fin = Math.min(sb.buffered.end(i), limite);
      if (fin > debut) {
        try {
          sb.remove(debut, fin);
        } catch {
          // `remove` refusé pendant une mise à jour : au prochain tour.
        }
        return; // une seule suppression à la fois (`remove` est asynchrone)
      }
    }
  }

  // -------------------------------------------------------------------------

  private surTemps = () => {
    this.pousserSuivant();
  };

  /**
   * Seek. On ne relance un téléchargement que si la cible n'est PAS déjà
   * tamponnée : sauter de 10 s dans ce qu'on a déjà ne doit rien coûter.
   */
  private surSeek = () => {
    const cible = this.video.currentTime;
    if (this.dansLeTampon(cible)) return;
    if (this.cues.length === 0) return; // pas d'index : le navigateur se débrouille

    const point = this.cuePour(cible);
    if (!point) return;

    this.fileSegments = [];
    // `abort()` annule l'ajout en cours ; sans ça, `appendBuffer` lèverait.
    try {
      if (this.sourceBuffer && this.mediaSource?.readyState === "open") {
        this.sourceBuffer.abort();
      }
    } catch {
      // Rien en cours : très bien.
    }
    this.enAjout = false;
    void this.demarrerPompe(point.positionCluster);
  };

  private dansLeTampon(t: number): boolean {
    const sb = this.sourceBuffer;
    if (!sb) return false;
    for (let i = 0; i < sb.buffered.length; i++) {
      // Marge d'une demi-seconde : le tampon peut manquer de quelques images.
      if (t >= sb.buffered.start(i) && t <= sb.buffered.end(i) - 0.5) return true;
    }
    return false;
  }

  /** Dernier point de seek situé AVANT l'instant visé. */
  private cuePour(secondes: number): PointCue | null {
    const ticks = (secondes * 1e9) / this.echelleCues;
    let choix: PointCue | null = null;
    // Recherche binaire : un film de 3 h a des milliers de points.
    let bas = 0;
    let haut = this.cues.length - 1;
    while (bas <= haut) {
      const milieu = (bas + haut) >> 1;
      if (this.cues[milieu].temps <= ticks) {
        choix = this.cues[milieu];
        bas = milieu + 1;
      } else {
        haut = milieu - 1;
      }
    }
    return choix ?? this.cues[0] ?? null;
  }
}
