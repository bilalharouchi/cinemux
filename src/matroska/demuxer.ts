import { EbmlReader, UNKNOWN_SIZE } from "../ebml/reader";
import { ID, MASTER_ELEMENTS, TrackType } from "../ebml/ids";
import { decoderBloc } from "./blocks";

/**
 * Démultiplexeur Matroska **en flux**.
 *
 * Il est alimenté par morceaux (`alimenter`) et n'exige jamais le fichier entier :
 * c'est ce qui permet de commencer à jouer après quelques centaines de Ko, au lieu
 * d'attendre 3 Go. Un élément coupé au milieu d'un morceau est simplement remis à
 * plus tard — d'où le tampon interne et les `null` du lecteur.
 */

export type PisteVideo = {
  largeur: number;
  hauteur: number;
  largeurAffichee: number;
  hauteurAffichee: number;
};

export type PisteAudio = {
  frequence: number;
  canaux: number;
  bits: number | null;
};

export type Piste = {
  numero: number;
  type: number;
  codecId: string;
  codecPrivate: Uint8Array | null;
  /** Nanosecondes par trame, quand le muxer l'a écrit. */
  dureeParDefaut: number | null;
  langue: string;
  nom: string | null;
  pardefaut: boolean;
  forcee: boolean;
  video: PisteVideo | null;
  audio: PisteAudio | null;
  /** Opus : décalage à retirer en début de piste (ns). */
  codecDelay: number | null;
};

export type Echantillon = {
  piste: number;
  /** En Track Ticks (× timestampScale pour obtenir des nanosecondes). */
  timestamp: number;
  /** Track Ticks, ou null si le muxer ne l'a pas écrit. */
  duree: number | null;
  keyframe: boolean;
  donnees: Uint8Array;
};

export type PointCue = {
  /** Track Ticks. */
  temps: number;
  /** Position absolue du Cluster dans le fichier, relative au début du Segment. */
  positionCluster: number;
  piste: number;
};

/**
 * Piste en cours de lecture, tous champs optionnels.
 *
 * Un `Partial<Piste>` intersecté ne marche pas : `video` y est déjà
 * `PisteVideo | null`, et l'intersection produit un type que rien ne satisfait.
 */
type PisteEnConstruction = {
  numero?: number;
  type?: number;
  codecId?: string;
  codecPrivate?: Uint8Array | null;
  dureeParDefaut?: number | null;
  langue?: string;
  nom?: string | null;
  pardefaut?: boolean;
  forcee?: boolean;
  codecDelay?: number | null;
  video?: Partial<PisteVideo>;
  audio?: Partial<PisteAudio>;
};

type Cadre = {
  id: number;
  /** Position absolue de fin, ou Infinity pour une taille inconnue. */
  fin: number;
  /** Profondeur EBML, pour savoir quand un élément de niveau 1 ferme un Cluster. */
  niveau: number;
};

/** Éléments de niveau 1 : leur apparition ferme tout Cluster de taille inconnue. */
const NIVEAU_1: ReadonlySet<number> = new Set<number>([
  ID.SeekHead,
  ID.Info,
  ID.Tracks,
  ID.Cluster,
  ID.Cues,
  ID.Attachments,
  ID.Chapters,
  ID.Tags,
]);

export type OptionsDemuxer = {
  onEntete?: (info: { timestampScale: number; dureeMs: number | null }) => void;
  onPistes?: (pistes: Piste[]) => void;
  onEchantillon?: (e: Echantillon) => void;
  onCues?: (points: PointCue[]) => void;
  /** Appelé quand le premier Cluster commence : plus rien de nouveau côté en-tête. */
  onPret?: () => void;
};

export class MatroskaDemuxer {
  /** Échelle de temps : nanosecondes par Track Tick. 1 ms par défaut (spec). */
  timestampScale = 1_000_000;
  dureeMs: number | null = null;
  pistes: Piste[] = [];
  cues: PointCue[] = [];

  /** Position absolue du contenu du Segment — les Cues y sont relatives. */
  positionSegment = 0;

  /**
   * Table des matières du fichier : ID d'élément → position absolue.
   *
   * C'est ce qui rend le seek possible sans télécharger le film : les Cues sont
   * presque toujours écrites À LA FIN (le muxer ne connaît les positions qu'une
   * fois tout écrit), mais le SeekHead, lui, est au début et dit où les trouver.
   * Une requête Range suffit alors pour récupérer l'index.
   */
  seekHead = new Map<number, number>();
  private seekIdEnCours: number | null = null;

  private tampon: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  /** Décalage dans le fichier du premier octet de `tampon`. */
  private decalage = 0;
  private pile: Cadre[] = [];
  private clusterTimestamp = 0;
  private pistesEmises = false;
  private pretEmis = false;

  /** Piste en cours de construction (TrackEntry ouvert). */
  private pisteEnCours: PisteEnConstruction | null = null;
  private cueEnCours: Partial<PointCue> | null = null;

  constructor(private readonly opt: OptionsDemuxer = {}) {}

  /**
   * Repositionne le démultiplexeur à un offset absolu du fichier (après un seek).
   * Les pistes et l'échelle de temps sont conservées : elles ne changent pas.
   */
  repositionner(offsetFichier: number) {
    this.tampon = new Uint8Array(0);
    this.decalage = offsetFichier;
    // On ne garde que le Segment : les cadres internes sont invalidés par le saut.
    this.pile = this.pile.filter((c) => c.id === ID.Segment);
    this.clusterTimestamp = 0;
  }

  /** Ajoute des octets et consomme tout ce qui est complet. */
  alimenter(morceau: Uint8Array<ArrayBufferLike>) {
    if (this.tampon.length === 0) {
      this.tampon = morceau;
    } else {
      const fusion = new Uint8Array(this.tampon.length + morceau.length);
      fusion.set(this.tampon, 0);
      fusion.set(morceau, this.tampon.length);
      this.tampon = fusion;
    }
    this.analyser();
  }

  private analyser() {
    const r = new EbmlReader(this.tampon, this.decalage);

    for (;;) {
      // Ferme les cadres terminés avant de lire l'élément suivant.
      while (this.pile.length > 0) {
        const haut = this.pile[this.pile.length - 1];
        if (haut.fin !== Infinity && r.positionAbsolue >= haut.fin) this.fermerCadre();
        else break;
      }

      const debut = r.pos;
      const id = r.lireId();
      if (id === null) {
        r.pos = debut;
        break;
      }
      const taille = r.lireTaille();
      if (taille === null) {
        r.pos = debut;
        break;
      }

      // Un élément de niveau 1 clôt un Cluster de taille inconnue.
      if (NIVEAU_1.has(id)) {
        while (this.pile.length > 0 && this.pile[this.pile.length - 1].niveau >= 1) {
          this.fermerCadre();
        }
      }

      if (MASTER_ELEMENTS.has(id)) {
        this.ouvrirCadre(id, taille === UNKNOWN_SIZE ? Infinity : r.positionAbsolue + taille, r);
        continue;
      }

      // Feuille : il faut tout le contenu pour la lire.
      if (taille === UNKNOWN_SIZE || r.reste < taille) {
        r.pos = debut;
        break;
      }

      const finFeuille = r.pos + taille;
      this.lireFeuille(id, taille, r);
      r.pos = finFeuille; // garde-fou : une feuille mal lue ne décale pas le flux
    }

    // Conserve la queue non consommée.
    if (r.pos > 0) {
      this.tampon = this.tampon.slice(r.pos);
      this.decalage += r.pos;
    }
  }

  private ouvrirCadre(id: number, fin: number, r: EbmlReader) {
    const niveau =
      id === ID.Segment || id === ID.EBML ? 0 : NIVEAU_1.has(id) ? 1 : this.pile.length;
    this.pile.push({ id, fin, niveau });

    if (id === ID.Segment) this.positionSegment = r.positionAbsolue;
    if (id === ID.TrackEntry) this.pisteEnCours = {};
    // L'accumulateur naît avec le CuePoint, PAS avec CueTrackPositions : CueTime
    // arrive avant, et le remettre à zéro ici perdrait le temps du point de seek.
    if (id === ID.CuePoint) this.cueEnCours = {};

    if (id === ID.Cluster) {
      // Les pistes sont complètes dès qu'un Cluster commence.
      if (!this.pistesEmises && this.pistes.length > 0) {
        this.pistesEmises = true;
        this.opt.onPistes?.(this.pistes);
      }
      if (!this.pretEmis) {
        this.pretEmis = true;
        this.opt.onPret?.();
      }
    }
  }

  private fermerCadre() {
    const cadre = this.pile.pop();
    if (!cadre) return;

    if (cadre.id === ID.TrackEntry && this.pisteEnCours) {
      const p = this.pisteEnCours;
      if (p.numero != null && p.codecId) {
        this.pistes.push({
          numero: p.numero,
          type: p.type ?? 0,
          codecId: p.codecId,
          codecPrivate: p.codecPrivate ?? null,
          dureeParDefaut: p.dureeParDefaut ?? null,
          langue: p.langue ?? "und",
          nom: p.nom ?? null,
          pardefaut: p.pardefaut ?? true,
          forcee: p.forcee ?? false,
          video: p.video
            ? {
                largeur: p.video.largeur ?? 0,
                hauteur: p.video.hauteur ?? 0,
                // Sans DisplayWidth, l'affichage suit les pixels codés.
                largeurAffichee: p.video.largeurAffichee ?? p.video.largeur ?? 0,
                hauteurAffichee: p.video.hauteurAffichee ?? p.video.hauteur ?? 0,
              }
            : null,
          audio: p.audio
            ? {
                frequence: p.audio.frequence ?? 8000,
                canaux: p.audio.canaux ?? 1,
                bits: p.audio.bits ?? null,
              }
            : null,
          codecDelay: p.codecDelay ?? null,
        });
      }
      this.pisteEnCours = null;
    }

    if (cadre.id === ID.Tracks && !this.pistesEmises && this.pistes.length > 0) {
      this.pistesEmises = true;
      this.opt.onPistes?.(this.pistes);
    }

    if (cadre.id === ID.CuePoint) this.cueEnCours = null;

    if (cadre.id === ID.Cues) {
      // Les Cues d'un fichier bien formé sont déjà triées, mais rien ne l'impose :
      // la recherche binaire du seek, elle, l'exige.
      this.cues.sort((a, b) => a.temps - b.temps);
      this.opt.onCues?.(this.cues);
    }
  }

  private lireFeuille(id: number, taille: number, r: EbmlReader) {
    const p = this.pisteEnCours;
    const dansAudio = this.pile.some((c) => c.id === ID.Audio);
    const dansVideo = this.pile.some((c) => c.id === ID.Video);

    switch (id) {
      // --- Info ---
      case ID.TimestampScale:
        this.timestampScale = r.lireUint(taille);
        break;
      case ID.Duration: {
        const ticks = r.lireFloat(taille);
        this.dureeMs = (ticks * this.timestampScale) / 1e6;
        this.opt.onEntete?.({ timestampScale: this.timestampScale, dureeMs: this.dureeMs });
        break;
      }

      // --- TrackEntry ---
      case ID.TrackNumber:
        if (p) p.numero = r.lireUint(taille);
        break;
      case ID.TrackType:
        if (p) p.type = r.lireUint(taille);
        break;
      case ID.CodecID:
        if (p) p.codecId = r.lireChaine(taille);
        break;
      case ID.CodecPrivate:
        if (p) p.codecPrivate = r.lireOctets(taille);
        break;
      case ID.DefaultDuration:
        if (p) p.dureeParDefaut = r.lireUint(taille);
        break;
      case ID.Language:
        if (p && !p.langue) p.langue = r.lireChaine(taille);
        break;
      case ID.LanguageBCP47:
        // BCP47 est plus précis (« fr-FR ») : il gagne sur Language (« fre »).
        if (p) p.langue = r.lireChaine(taille);
        break;
      case ID.Name:
        if (p) p.nom = r.lireChaine(taille);
        break;
      case ID.FlagDefault:
        if (p) p.pardefaut = r.lireUint(taille) !== 0;
        break;
      case ID.FlagForced:
        if (p) p.forcee = r.lireUint(taille) !== 0;
        break;
      case ID.CodecDelay:
        if (p) p.codecDelay = r.lireUint(taille);
        break;

      // --- Video ---
      case ID.PixelWidth:
        if (p && dansVideo) (p.video ??= {}).largeur = r.lireUint(taille);
        break;
      case ID.PixelHeight:
        if (p && dansVideo) (p.video ??= {}).hauteur = r.lireUint(taille);
        break;
      case ID.DisplayWidth:
        if (p && dansVideo) (p.video ??= {}).largeurAffichee = r.lireUint(taille);
        break;
      case ID.DisplayHeight:
        if (p && dansVideo) (p.video ??= {}).hauteurAffichee = r.lireUint(taille);
        break;

      // --- Audio ---
      case ID.SamplingFrequency:
        if (p && dansAudio) (p.audio ??= {}).frequence = r.lireFloat(taille);
        break;
      case ID.OutputSamplingFrequency:
        // Fréquence de sortie (AAC HE double la fréquence) : c'est elle qui compte.
        if (p && dansAudio) (p.audio ??= {}).frequence = r.lireFloat(taille);
        break;
      case ID.Channels:
        if (p && dansAudio) (p.audio ??= {}).canaux = r.lireUint(taille);
        break;
      case ID.BitDepth:
        if (p && dansAudio) (p.audio ??= {}).bits = r.lireUint(taille);
        break;

      // --- Cluster ---
      case ID.Timestamp:
        this.clusterTimestamp = r.lireUint(taille);
        break;
      case ID.SimpleBlock:
        this.emettreBloc(r.lireOctets(taille), true, null);
        break;
      case ID.Block:
        // Dans un BlockGroup : le keyframe se déduit de l'absence de ReferenceBlock,
        // mais on ne l'a pas encore lu. On tranche à la fermeture du groupe — en
        // pratique, un BlockGroup sans ReferenceBlock est rare et non-clé le plus
        // souvent, donc on le marque non-clé et on laisse le lecteur s'en remettre.
        this.emettreBloc(r.lireOctets(taille), false, null);
        break;

      // --- SeekHead : la table des matières du fichier ---
      case ID.SeekID: {
        const octets = r.lireOctets(taille);
        let id2 = 0;
        for (const o of octets) id2 = id2 * 256 + o;
        this.seekIdEnCours = id2;
        break;
      }
      case ID.SeekPosition: {
        const position = r.lireUint(taille);
        if (this.seekIdEnCours !== null) {
          // Relative au Segment, comme les Cues.
          this.seekHead.set(this.seekIdEnCours, this.positionSegment + position);
          this.seekIdEnCours = null;
        }
        break;
      }

      // --- Cues ---
      case ID.CueTime:
        if (this.cueEnCours === null) this.cueEnCours = {};
        this.cueEnCours.temps = r.lireUint(taille);
        break;
      case ID.CueTrack:
        if (this.cueEnCours) this.cueEnCours.piste = r.lireUint(taille);
        break;
      case ID.CueClusterPosition: {
        const position = r.lireUint(taille);
        if (this.cueEnCours?.temps != null) {
          this.cues.push({
            temps: this.cueEnCours.temps,
            // Les positions des Cues sont relatives au début du Segment.
            positionCluster: this.positionSegment + position,
            piste: this.cueEnCours.piste ?? 1,
          });
        }
        break;
      }

      default:
        break; // élément non utilisé : `r.pos` est recalé par l'appelant
    }
  }

  private emettreBloc(donnees: Uint8Array, simple: boolean, duree: number | null) {
    const bloc = decoderBloc(donnees, simple);
    if (!bloc) return;

    const base = this.clusterTimestamp + bloc.timestampRelatif;
    // Trames lacées : elles partagent le timestamp du bloc. Sans DefaultDuration on
    // ne peut pas les répartir — les muxers qui lacent l'écrivent toujours.
    const pas =
      bloc.trames.length > 1 && this.pistes.length > 0
        ? this.dureeTicks(bloc.trackNumber)
        : 0;

    bloc.trames.forEach((trame, i) => {
      this.opt.onEchantillon?.({
        piste: bloc.trackNumber,
        timestamp: base + (pas ? pas * i : 0),
        duree: duree ?? (pas || null),
        keyframe: bloc.keyframe,
        donnees: trame,
      });
    });
  }

  /** DefaultDuration d'une piste, converti de nanosecondes en Track Ticks. */
  private dureeTicks(numeroPiste: number): number {
    const piste = this.pistes.find((p) => p.numero === numeroPiste);
    if (!piste?.dureeParDefaut) return 0;
    return piste.dureeParDefaut / this.timestampScale;
  }

  /** Pistes utilisables triées : vidéo puis audio, la piste « par défaut » en tête. */
  pistesParType(type: number): Piste[] {
    return this.pistes
      .filter((p) => p.type === type)
      .sort((a, b) => Number(b.pardefaut) - Number(a.pardefaut));
  }

  get pisteVideo(): Piste | null {
    return this.pistesParType(TrackType.VIDEO)[0] ?? null;
  }
}
