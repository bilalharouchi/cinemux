import { MatroskaDemuxer, type Echantillon, type Piste } from "./matroska/demuxer";
import { TrackType } from "./ebml/ids";
import { CodecNonSupporte, decrire, mimeDe, type Description } from "./codecs";
import {
  reconstruireDts,
  segmentInit,
  segmentMedia,
  type EchantillonMux,
  type FragmentPiste,
  type PisteMux,
} from "./mp4/muxer";

/**
 * Remux Matroska → fMP4.
 *
 * Reçoit des octets de MKV, produit un segment d'initialisation puis des segments
 * média prêts pour `SourceBuffer.appendBuffer`. Aucun échantillon n'est réencodé :
 * les octets du bitstream traversent tels quels.
 */

export type PisteChoisie = {
  piste: Piste;
  description: Description;
  /** Le navigateur courant sait-il décoder ce codec ? */
  supportee: boolean;
};

export type Diagnostic = {
  video: PisteChoisie | null;
  audio: PisteChoisie | null;
  /** Pistes écartées, avec la raison — l'utilisateur a droit à une explication. */
  ecartees: { piste: Piste; raison: string }[];
  /** Type MIME complet passé à MediaSource. */
  mime: string;
  dureeMs: number | null;
};

export type OptionsRemuxer = {
  onInit?: (segment: Uint8Array, diag: Diagnostic) => void;
  onSegment?: (segment: Uint8Array) => void;
  onErreur?: (e: Error) => void;
  /**
   * Durée cible d'un fragment. Trop court, on multiplie les `appendBuffer` ;
   * trop long, le démarrage traîne. 500 ms est un bon compromis mesuré.
   */
  dureeFragmentMs?: number;
  /** Langue préférée pour la piste audio (« fr », « fre », « fr-FR »). */
  languePreferee?: string;
  /** Remplaçable en test, où `MediaSource` n'existe pas. */
  supporte?: (mime: string) => boolean;
};

/** Ordre de préférence audio à qualité égale : ce que le navigateur lit le mieux. */
const RANG_AUDIO: Record<string, number> = {
  A_AAC: 0,
  A_OPUS: 1,
  A_FLAC: 2,
  "A_MPEG/L3": 3,
  A_AC3: 4,
  A_EAC3: 5,
  A_DTS: 6,
};

function supportParDefaut(mime: string): boolean {
  if (typeof MediaSource === "undefined") return false;
  return MediaSource.isTypeSupported(mime);
}

/** Deux codes langue désignent-ils la même langue ? (`fre`, `fra`, `fr`, `fr-FR`) */
function memeLangue(a: string, b: string): boolean {
  const n = (s: string) => {
    const base = s.toLowerCase().split(/[-_]/)[0];
    return base === "fra" || base === "fre" ? "fr" : base;
  };
  return n(a) === n(b);
}

export class Remuxer {
  private readonly demuxer: MatroskaDemuxer;
  private readonly supporte: (mime: string) => boolean;
  private readonly dureeFragmentTicks: number;

  private video: PisteChoisie | null = null;
  private audio: PisteChoisie | null = null;
  private muxVideo: PisteMux | null = null;
  private muxAudio: PisteMux | null = null;

  private etat: "pistes" | "amorce" | "actif" | "arrete" = "pistes";
  private enAttente: Echantillon[] = [];
  private tampons = new Map<number, Echantillon[]>();
  private sequence = 1;
  private diag: Diagnostic | null = null;

  constructor(private readonly opt: OptionsRemuxer = {}) {
    this.supporte = opt.supporte ?? supportParDefaut;
    // Converti en Track Ticks à la première utilisation (timestampScale connu).
    this.dureeFragmentTicks = opt.dureeFragmentMs ?? 500;

    this.demuxer = new MatroskaDemuxer({
      onPistes: (pistes) => this.choisirPistes(pistes),
      onEchantillon: (e) => this.recevoir(e),
    });
  }

  get cues() {
    return this.demuxer.cues;
  }

  get dureeMs() {
    return this.demuxer.dureeMs;
  }

  get diagnostic() {
    return this.diag;
  }

  alimenter(morceau: Uint8Array) {
    if (this.etat === "arrete") return;
    try {
      this.demuxer.alimenter(morceau);
    } catch (e) {
      this.etat = "arrete";
      this.opt.onErreur?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** Après un seek : vide les tampons et repart à l'offset donné. */
  repositionner(offsetFichier: number) {
    this.demuxer.repositionner(offsetFichier);
    this.tampons.clear();
    this.enAttente = [];
  }

  /** Pousse le dernier fragment partiel — à appeler en fin de flux. */
  terminer() {
    this.vider(true);
  }

  // -------------------------------------------------------------------------

  private choisirPistes(pistes: Piste[]) {
    const ecartees: { piste: Piste; raison: string }[] = [];

    /** Décrit une piste et teste son support, en récoltant les refus. */
    const evaluer = (piste: Piste, premiereTrame?: Uint8Array): PisteChoisie | null => {
      try {
        const description = decrire(piste, premiereTrame);
        const mime = mimeDe(description);
        return { piste, description, supportee: this.supporte(mime) };
      } catch (e) {
        ecartees.push({
          piste,
          raison: e instanceof CodecNonSupporte ? e.raison : String(e),
        });
        return null;
      }
    };

    // --- Vidéo : la piste par défaut, sinon la première décrivable ---
    for (const piste of this.demuxer.pistesParType(TrackType.VIDEO)) {
      const choix = evaluer(piste);
      if (choix?.supportee) {
        this.video = choix;
        break;
      }
      if (choix && !this.video) {
        this.video = choix; // gardée en dernier recours, marquée non supportée
        ecartees.push({ piste, raison: `${description(choix)} non décodable ici` });
      }
    }

    // --- Audio : d'abord ce que le navigateur sait lire, puis la langue ---
    const candidats = this.demuxer
      .pistesParType(TrackType.AUDIO)
      .map((piste) => ({ piste, choix: evaluer(piste) }))
      .filter((c): c is { piste: Piste; choix: PisteChoisie } => c.choix !== null);

    candidats.sort((a, b) => {
      // 1. Décodable ici — un AC-3 en français est inutile si rien ne le joue.
      if (a.choix.supportee !== b.choix.supportee) return a.choix.supportee ? -1 : 1;
      // 2. Langue demandée.
      if (this.opt.languePreferee) {
        const la = memeLangue(a.piste.langue, this.opt.languePreferee);
        const lb = memeLangue(b.piste.langue, this.opt.languePreferee);
        if (la !== lb) return la ? -1 : 1;
      }
      // 3. Codec le mieux traité par les navigateurs.
      const ra = RANG_AUDIO[a.piste.codecId] ?? 9;
      const rb = RANG_AUDIO[b.piste.codecId] ?? 9;
      if (ra !== rb) return ra - rb;
      // 4. Piste marquée par défaut.
      return Number(b.piste.pardefaut) - Number(a.piste.pardefaut);
    });

    const retenu = candidats[0];
    if (retenu) {
      this.audio = retenu.choix;
      for (const c of candidats.slice(1)) {
        ecartees.push({ piste: c.piste, raison: "autre piste préférée" });
      }
    }

    // L'AC-3 n'a pas de CodecPrivate : sa configuration n'est lisible que dans la
    // première trame. On attend donc de l'avoir avant d'émettre l'initialisation.
    const besoinTrame = this.audio === null && this.demuxer.pistesParType(TrackType.AUDIO).length > 0;
    this.etat = besoinTrame ? "amorce" : "actif";

    if (this.etat === "actif") this.emettreInit(ecartees);
    else this.ecarteesEnAttente = ecartees;
  }

  private ecarteesEnAttente: { piste: Piste; raison: string }[] = [];

  private emettreInit(ecartees: { piste: Piste; raison: string }[]) {
    const pistes: PisteMux[] = [];
    let id = 1;
    if (this.video) {
      this.muxVideo = { id: id++, description: this.video.description };
      pistes.push(this.muxVideo);
    }
    if (this.audio) {
      this.muxAudio = { id: id++, description: this.audio.description };
      pistes.push(this.muxAudio);
    }

    if (pistes.length === 0) {
      this.etat = "arrete";
      this.opt.onErreur?.(new Error("aucune piste exploitable dans ce fichier"));
      return;
    }

    const descriptions = pistes.map((p) => p.description);
    this.diag = {
      video: this.video,
      audio: this.audio,
      ecartees,
      mime: mimeDe(...descriptions),
      dureeMs: this.demuxer.dureeMs,
    };

    this.etat = "actif";
    this.opt.onInit?.(segmentInit(pistes, this.demuxer.dureeMs ?? 0), this.diag);

    // Les échantillons arrivés pendant l'attente ne sont pas perdus.
    const enAttente = this.enAttente;
    this.enAttente = [];
    for (const e of enAttente) this.ranger(e);
    this.vider(false);
  }

  private recevoir(e: Echantillon) {
    if (this.etat === "arrete") return;

    if (this.etat === "amorce") {
      this.enAttente.push(e);
      // On ne retente la description que sur une trame audio.
      const piste = this.demuxer.pistes.find((p) => p.numero === e.piste);
      if (piste?.type === TrackType.AUDIO) {
        try {
          const description = decrire(piste, e.donnees);
          this.audio = { piste, description, supportee: this.supporte(mimeDe(description)) };
        } catch {
          // Toujours pas descriptible : on abandonne l'audio et on joue la vidéo.
          this.ecarteesEnAttente.push({ piste, raison: "configuration audio illisible" });
        }
        this.emettreInit(this.ecarteesEnAttente);
      }
      return;
    }

    if (this.etat !== "actif") return;
    this.ranger(e);
    this.vider(false);
  }

  private ranger(e: Echantillon) {
    const cible = this.cibleDe(e.piste);
    if (!cible) return; // piste non retenue : on jette, ça n'ira nulle part
    let file = this.tampons.get(e.piste);
    if (!file) this.tampons.set(e.piste, (file = []));
    file.push(e);
  }

  private cibleDe(numeroPiste: number): PisteMux | null {
    if (this.video && this.muxVideo && numeroPiste === this.video.piste.numero) return this.muxVideo;
    if (this.audio && this.muxAudio && numeroPiste === this.audio.piste.numero) return this.muxAudio;
    return null;
  }

  /** Ticks Matroska → ticks de la piste MP4. */
  private convertir(ticks: number, timescale: number): number {
    const secondes = (ticks * this.demuxer.timestampScale) / 1e9;
    return Math.round(secondes * timescale);
  }

  /**
   * Décalage de présentation global, en secondes.
   *
   * POURQUOI — avec des images B, le premier DTS est antérieur au premier PTS.
   * Comme `tfdt` est non signé, on ne peut pas écrire un DTS négatif : la seule
   * issue est d'avancer TOUTE la présentation du délai de réordonnancement.
   *
   * Ce décalage doit s'appliquer à l'audio AUSSI. Ne le mettre que sur la vidéo,
   * c'est décaler le son de 80 ms — un défaut de synchronisation labial audible,
   * et le vrai bug que ce champ corrige.
   */
  private decalageSecondes: number | null = null;

  /** Calcule le délai de réordonnancement d'un lot vidéo, en secondes. */
  private delaiReordre(pts: number[], dts: number[], timescale: number): number {
    let max = 0;
    for (let i = 0; i < pts.length; i++) max = Math.max(max, dts[i] - pts[i]);
    return max / timescale;
  }

  /**
   * Émet un fragment quand assez de données sont accumulées.
   *
   * On coupe sur une image CLÉ : un fragment qui commencerait au milieu d'un
   * groupe d'images serait indécodable seul, et casserait le seek.
   */
  private vider(forcer: boolean) {
    const pisteRef = this.video ?? this.audio;
    if (!pisteRef) return;
    const fileRef = this.tampons.get(pisteRef.piste.numero);
    if (!fileRef || fileRef.length === 0) return;

    let coupe = fileRef.length;
    if (!forcer) {
      // Dernière image clé qui laisse assez de matière derrière elle.
      coupe = -1;
      for (let i = fileRef.length - 1; i > 0; i--) {
        const estCle = this.video ? fileRef[i].keyframe : true;
        if (!estCle) continue;
        if (fileRef[i].timestamp - fileRef[0].timestamp >= this.dureeFragmentTicks) {
          coupe = i;
          break;
        }
      }
      if (coupe <= 0) return; // pas encore assez, ou aucune image clé
    }

    const finTicks = coupe < fileRef.length ? fileRef[coupe].timestamp : Infinity;

    // On prélève d'abord, on prépare ensuite : le décalage de présentation se
    // calcule sur la vidéo et doit s'appliquer à l'audio du MÊME fragment.
    const lots: { mux: PisteMux; pris: Echantillon[]; suivant?: Echantillon }[] = [];
    for (const [numero, file] of this.tampons) {
      const mux = this.cibleDe(numero);
      if (!mux) continue;

      // On ne prend que ce qui précède la coupe : l'audio d'après part au fragment
      // suivant, sinon les pistes se désynchronisent d'un fragment.
      const pris: Echantillon[] = [];
      while (file.length > 0 && (forcer || file[0].timestamp < finTicks)) {
        pris.push(file.shift()!);
      }
      if (pris.length > 0) lots.push({ mux, pris, suivant: file[0] });
    }
    if (lots.length === 0) return;

    // Le décalage est fixé UNE fois, sur le premier lot vidéo, et vaut ensuite
    // pour tout le fichier : le recalculer par fragment ferait sauter l'horloge.
    if (this.decalageSecondes === null) {
      const lotVideo = lots.find((l) => l.mux.description.type === "video");
      if (lotVideo) {
        const ts = lotVideo.mux.description.timescale;
        const pts = lotVideo.pris.map((e) => this.convertir(e.timestamp, ts));
        this.decalageSecondes = this.delaiReordre(pts, reconstruireDts(pts), ts);
      } else {
        this.decalageSecondes = 0; // audio seul : rien à réordonner
      }
    }

    const fragments: FragmentPiste[] = lots.map((l) => ({
      piste: l.mux,
      echantillons: this.preparer(l.pris, l.mux, l.suivant),
    }));

    const segment = segmentMedia(this.sequence++, fragments);
    if (segment.length > 0) this.opt.onSegment?.(segment);
  }

  /** Convertit les timestamps, reconstruit les DTS et calcule les durées. */
  private preparer(
    echantillons: Echantillon[],
    mux: PisteMux,
    suivant: Echantillon | undefined,
  ): EchantillonMux[] {
    const ts = mux.description.timescale;
    const pts = echantillons.map((e) => this.convertir(e.timestamp, ts));
    const dts = reconstruireDts(pts);

    // Décalage commun aux deux pistes, converti dans l'horloge de celle-ci.
    const decalage = Math.round((this.decalageSecondes ?? 0) * ts);
    for (let i = 0; i < pts.length; i++) pts[i] += decalage;
    // L'audio n'a pas d'images B : son DTS suit son PTS, décalage compris. La
    // vidéo garde un DTS qui démarre à zéro — c'est tout l'objet du décalage.
    if (mux.description.type === "audio") {
      for (let i = 0; i < dts.length; i++) dts[i] += decalage;
    }

    return echantillons.map((e, i) => {
      // Durée = écart jusqu'au DTS suivant. Pour le dernier échantillon du
      // fragment on regarde la trame d'après, restée en tampon ; à défaut on
      // reprend l'écart précédent, faute de mieux.
      let duree: number;
      if (i + 1 < dts.length) {
        duree = dts[i + 1] - dts[i];
      } else if (suivant) {
        duree = Math.max(1, this.convertir(suivant.timestamp, ts) - dts[i]);
      } else if (e.duree) {
        duree = this.convertir(e.duree, ts);
      } else if (dts.length >= 2) {
        duree = dts[dts.length - 1] - dts[dts.length - 2];
      } else {
        duree = Math.round(ts / 25); // dernier recours : 25 i/s
      }

      return {
        pts: pts[i],
        dts: dts[i],
        duree: Math.max(0, duree),
        keyframe: mux.description.type === "audio" ? true : e.keyframe,
        donnees: e.donnees,
      };
    });
  }
}

function description(choix: PisteChoisie): string {
  return choix.description.codec;
}
