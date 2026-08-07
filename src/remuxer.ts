import { MatroskaDemuxer, type Sample, type Track } from "./matroska/demuxer.js";
import { TrackType } from "./ebml/ids.js";
import { UnsupportedCodec, describe, mimeFor, type Description } from "./codecs/index.js";
import {
  reconstructDts,
  segmentInit,
  mediaSegment,
  type MuxSample,
  type TrackFragment,
  type MuxTrack,
} from "./mp4/muxer.js";

/**
 * Matroska → fMP4 remux.
 *
 * Takes in MKV bytes, produces an init segment then media segments ready
 * for `SourceBuffer.appendBuffer`. No sample is ever re-encoded: the
 * bitstream bytes pass through as-is.
 */

export type ChosenTrack = {
  track: Track;
  description: Description;
  /** Can the current browser decode this codec? */
  supported: boolean;
};

export type Diagnostic = {
  video: ChosenTrack | null;
  audio: ChosenTrack | null;
  /** Discarded tracks, with the reason — the user deserves an explanation. */
  discarded: { track: Track; reason: string }[];
  /** MIME type of the tracks ACTUALLY muxed. */
  mime: string;
  /**
   * True when the file has an audio track that no browser decoder handles:
   * the picture will play, but silently. It's up to the caller to offer
   * another version rather than leaving the user in front of a mute movie.
   */
  mutedAudio: boolean;
  durationMs: number | null;
};

export type RemuxerOptions = {
  onInit?: (segment: Uint8Array, diag: Diagnostic) => void;
  onSegment?: (segment: Uint8Array) => void;
  onError?: (e: Error) => void;
  /**
   * Target duration of a fragment. Too short, and `appendBuffer` calls pile
   * up; too long, and startup drags. 500 ms is a good measured compromise.
   */
  fragmentDurationMs?: number;
  /** Preferred language for the audio track ("fr", "fre", "fr-FR"). */
  preferredLanguage?: string;
  /** Overridable in tests, where `MediaSource` doesn't exist. */
  isSupported?: (mime: string) => boolean;
  /**
   * Frame of the CHOSEN audio track that couldn't be muxed (a codec the
   * browser doesn't decode natively — typically AC-3). Normally silently
   * dropped in `store()`; with this callback, the caller (`player.ts`)
   * decodes it itself via `codecs/ac3/` and plays the sound through a path
   * other than MediaSource — the Web Audio API, synced to
   * `<video>.currentTime`.
   */
  onUnmuxedSample?: (s: Sample, track: Track, timestampScaleNs: number) => void;
};

/** Audio preference order at equal quality: what the browser handles best. */
const AUDIO_RANK: Record<string, number> = {
  A_AAC: 0,
  A_OPUS: 1,
  A_FLAC: 2,
  "A_MPEG/L3": 3,
  A_AC3: 4,
  A_EAC3: 5,
  A_DTS: 6,
};

function defaultSupport(mime: string): boolean {
  if (typeof MediaSource === "undefined") return false;
  return MediaSource.isTypeSupported(mime);
}

/** Do two language codes name the same language? (`fre`, `fra`, `fr`, `fr-FR`) */
function sameLanguage(a: string, b: string): boolean {
  const n = (s: string) => {
    const base = s.toLowerCase().split(/[-_]/)[0];
    return base === "fra" || base === "fre" ? "fr" : base;
  };
  return n(a) === n(b);
}

export class Remuxer {
  private readonly demuxer: MatroskaDemuxer;
  private readonly isSupported: (mime: string) => boolean;
  private readonly fragmentDurationTicks: number;

  private video: ChosenTrack | null = null;
  private audio: ChosenTrack | null = null;
  private muxVideo: MuxTrack | null = null;
  private muxAudio: MuxTrack | null = null;

  private state: "tracks" | "priming" | "active" | "stopped" = "tracks";
  private pending: Sample[] = [];
  private buffers = new Map<number, Sample[]>();
  private sequence = 1;
  private diag: Diagnostic | null = null;

  constructor(private readonly opt: RemuxerOptions = {}) {
    this.isSupported = opt.isSupported ?? defaultSupport;
    // Converted to Track Ticks on first use (timestampScale known by then).
    this.fragmentDurationTicks = opt.fragmentDurationMs ?? 500;

    this.demuxer = new MatroskaDemuxer({
      onTracks: (tracks) => this.chooseTracks(tracks),
      onSample: (s) => this.receive(s),
    });
  }

  get cues() {
    return this.demuxer.cues;
  }

  get durationMs() {
    return this.demuxer.durationMs;
  }

  get diagnostic() {
    return this.diag;
  }

  feed(chunk: Uint8Array) {
    if (this.state === "stopped") return;
    try {
      this.demuxer.feed(chunk);
    } catch (e) {
      this.state = "stopped";
      this.opt.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** After a seek: clears the buffers and restarts at the given offset. */
  seekTo(fileOffset: number) {
    this.demuxer.seekTo(fileOffset);
    this.buffers.clear();
    this.pending = [];
  }

  /** Pushes the last partial fragment — call at the end of the stream. */
  finish() {
    this.flush(true);
  }

  // -------------------------------------------------------------------------

  private chooseTracks(tracks: Track[]) {
    const discarded: { track: Track; reason: string }[] = [];

    /** Describes a track and tests its support, collecting rejections. */
    const evaluate = (track: Track, firstFrame?: Uint8Array): ChosenTrack | null => {
      try {
        const description = describe(track, firstFrame);
        const mime = mimeFor(description);
        return { track, description, supported: this.isSupported(mime) };
      } catch (e) {
        discarded.push({
          track,
          reason: e instanceof UnsupportedCodec ? e.reason : String(e),
        });
        return null;
      }
    };

    // --- Video: the default track, otherwise the first describable one ---
    for (const track of this.demuxer.tracksByType(TrackType.VIDEO)) {
      const choice = evaluate(track);
      if (choice?.supported) {
        this.video = choice;
        break;
      }
      if (choice && !this.video) {
        this.video = choice; // kept as a last resort, marked unsupported
        discarded.push({ track, reason: `${codecLabel(choice)} not decodable here` });
      }
    }

    // --- Audio: first what the browser can play, then language ---
    const candidates = this.demuxer
      .tracksByType(TrackType.AUDIO)
      .map((track) => ({ track, choice: evaluate(track) }))
      .filter((c): c is { track: Track; choice: ChosenTrack } => c.choice !== null);

    candidates.sort((a, b) => {
      // 1. Decodable here — a French AC-3 track is useless if nothing plays it.
      if (a.choice.supported !== b.choice.supported) return a.choice.supported ? -1 : 1;
      // 2. Requested language.
      if (this.opt.preferredLanguage) {
        const la = sameLanguage(a.track.language, this.opt.preferredLanguage);
        const lb = sameLanguage(b.track.language, this.opt.preferredLanguage);
        if (la !== lb) return la ? -1 : 1;
      }
      // 3. Codec best handled by browsers.
      const ra = AUDIO_RANK[a.track.codecId] ?? 9;
      const rb = AUDIO_RANK[b.track.codecId] ?? 9;
      if (ra !== rb) return ra - rb;
      // 4. Track flagged as default.
      return Number(b.track.default) - Number(a.track.default);
    });

    const chosen = candidates[0];
    if (chosen) {
      this.audio = chosen.choice;
      for (const c of candidates.slice(1)) {
        discarded.push({ track: c.track, reason: "another track preferred" });
      }
    }

    // AC-3 has no CodecPrivate: its configuration is only readable in the
    // first frame. So we wait until we have it before emitting init.
    const needsFrame = this.audio === null && this.demuxer.tracksByType(TrackType.AUDIO).length > 0;
    this.state = needsFrame ? "priming" : "active";

    if (this.state === "active") this.emitInit(discarded);
    else this.pendingDiscarded = discarded;
  }

  private pendingDiscarded: { track: Track; reason: string }[] = [];

  private emitInit(discarded: { track: Track; reason: string }[]) {
    const tracks: MuxTrack[] = [];
    let id = 1;
    if (this.video) {
      this.muxVideo = { id: id++, description: this.video.description };
      tracks.push(this.muxVideo);
    }

    /**
     * An audio track the browser can't decode is EXCLUDED from muxing.
     *
     * WHY — `MediaSource.isTypeSupported` judges the WHOLE codec string: a
     * `hvc1.2.4.H150.B0,ac-3` is rejected outright, even though the video
     * alone would pass. Keeping it would condemn the whole file over its
     * audio.
     *
     * It stays in the diagnostic with `supported: false`: the caller knows
     * there's audio it can't play, and can offer something else.
     */
    const playableAudio = this.audio?.supported ? this.audio : null;
    if (this.audio && !playableAudio) {
      discarded.push({
        track: this.audio.track,
        reason: `${this.audio.track.codecId} not decodable by this browser — picture kept, audio muted`,
      });
    }
    if (playableAudio) {
      this.muxAudio = { id: id++, description: playableAudio.description };
      tracks.push(this.muxAudio);
    }

    if (tracks.length === 0) {
      this.state = "stopped";
      this.opt.onError?.(new Error("no usable track in this file"));
      return;
    }

    const descriptions = tracks.map((t) => t.description);
    this.diag = {
      video: this.video,
      audio: this.audio,
      discarded,
      // Only describes what's actually muxed: including an excluded track
      // would make `isTypeSupported` fail on a stream that would otherwise pass.
      mime: mimeFor(...descriptions),
      /** The file has audio, but this browser can't decode it. */
      mutedAudio: this.audio != null && !this.audio.supported,
      durationMs: this.demuxer.durationMs,
    };

    this.state = "active";
    this.opt.onInit?.(segmentInit(tracks, this.demuxer.durationMs ?? 0), this.diag);

    // Samples that arrived while waiting aren't lost.
    const pending = this.pending;
    this.pending = [];
    for (const s of pending) this.store(s);
    this.flush(false);
  }

  private receive(s: Sample) {
    if (this.state === "stopped") return;

    if (this.state === "priming") {
      this.pending.push(s);
      // Description is only retried on an audio frame.
      const track = this.demuxer.tracks.find((t) => t.number === s.track);
      if (track?.type === TrackType.AUDIO) {
        try {
          const description = describe(track, s.data);
          this.audio = { track, description, supported: this.isSupported(mimeFor(description)) };
        } catch {
          // Still not describable: audio is given up on, video plays on its own.
          this.pendingDiscarded.push({ track, reason: "unreadable audio configuration" });
        }
        this.emitInit(this.pendingDiscarded);
      }
      return;
    }

    if (this.state !== "active") return;
    this.store(s);
    this.flush(false);
  }

  private store(s: Sample) {
    const target = this.targetFor(s.track);
    if (!target) {
      // Chosen track (`this.audio`) but not muxed: not just "not chosen",
      // this is the AC-3 case — offer the raw frame before dropping it for good.
      if (this.audio && s.track === this.audio.track.number) {
        this.opt.onUnmuxedSample?.(s, this.audio.track, this.demuxer.timestampScale);
      }
      return;
    }
    let queue = this.buffers.get(s.track);
    if (!queue) this.buffers.set(s.track, (queue = []));
    queue.push(s);
  }

  private targetFor(trackNumber: number): MuxTrack | null {
    if (this.video && this.muxVideo && trackNumber === this.video.track.number) return this.muxVideo;
    if (this.audio && this.muxAudio && trackNumber === this.audio.track.number) return this.muxAudio;
    return null;
  }

  /** Matroska ticks → MP4 track ticks. */
  private convert(ticks: number, timescale: number): number {
    const seconds = (ticks * this.demuxer.timestampScale) / 1e9;
    return Math.round(seconds * timescale);
  }

  /**
   * Global presentation offset, in seconds.
   *
   * WHY — with B-frames, the first DTS comes before the first PTS. Since
   * `tfdt` is unsigned, a negative DTS can't be written: the only way out
   * is to advance the ENTIRE presentation by the reordering delay.
   *
   * This offset must apply to audio TOO. Applying it only to video shifts
   * the sound by 80 ms — an audible lip-sync bug, and the actual bug this
   * field fixes.
   */
  private presentationOffsetSeconds: number | null = null;

  /** Computes a video batch's reordering delay, in seconds. */
  private reorderDelay(pts: number[], dts: number[], timescale: number): number {
    let max = 0;
    for (let i = 0; i < pts.length; i++) max = Math.max(max, dts[i] - pts[i]);
    return max / timescale;
  }

  /**
   * Emits a fragment once enough data has accumulated.
   *
   * The cut happens on a KEY frame: a fragment starting mid-group-of-pictures
   * would be undecodable on its own, and would break seeking.
   */
  private flush(force: boolean) {
    const refTrack = this.video ?? this.audio;
    if (!refTrack) return;
    const refQueue = this.buffers.get(refTrack.track.number);
    if (!refQueue || refQueue.length === 0) return;

    let cut = refQueue.length;
    if (!force) {
      // Last key frame that leaves enough material behind it.
      cut = -1;
      for (let i = refQueue.length - 1; i > 0; i--) {
        const isKey = this.video ? refQueue[i].keyframe : true;
        if (!isKey) continue;
        if (refQueue[i].timestamp - refQueue[0].timestamp >= this.fragmentDurationTicks) {
          cut = i;
          break;
        }
      }
      if (cut <= 0) return; // not enough yet, or no key frame
    }

    const endTicks = cut < refQueue.length ? refQueue[cut].timestamp : Infinity;

    // Samples are taken first, prepared afterward: the presentation offset
    // is computed from the video and must apply to the audio of the SAME fragment.
    const batches: { mux: MuxTrack; taken: Sample[]; next?: Sample }[] = [];
    for (const [trackNumber, queue] of this.buffers) {
      const mux = this.targetFor(trackNumber);
      if (!mux) continue;

      // Only what precedes the cut is taken: audio after it goes to the
      // next fragment, otherwise the tracks drift out of sync by one fragment.
      const taken: Sample[] = [];
      while (queue.length > 0 && (force || queue[0].timestamp < endTicks)) {
        taken.push(queue.shift()!);
      }
      if (taken.length > 0) batches.push({ mux, taken, next: queue[0] });
    }
    if (batches.length === 0) return;

    // The offset is fixed ONCE, from the first video batch, and then holds
    // for the whole file: recomputing it per fragment would make the clock jump.
    if (this.presentationOffsetSeconds === null) {
      const videoBatch = batches.find((b) => b.mux.description.type === "video");
      if (videoBatch) {
        const ts = videoBatch.mux.description.timescale;
        const pts = videoBatch.taken.map((s) => this.convert(s.timestamp, ts));
        this.presentationOffsetSeconds = this.reorderDelay(pts, reconstructDts(pts), ts);
      } else {
        this.presentationOffsetSeconds = 0; // audio only: nothing to reorder
      }
    }

    const fragments: TrackFragment[] = batches.map((b) => ({
      track: b.mux,
      samples: this.prepare(b.taken, b.mux, b.next),
    }));

    const segment = mediaSegment(this.sequence++, fragments);
    if (segment.length > 0) this.opt.onSegment?.(segment);
  }

  /** Converts timestamps, reconstructs DTS, and computes durations. */
  private prepare(
    samples: Sample[],
    mux: MuxTrack,
    next: Sample | undefined,
  ): MuxSample[] {
    const ts = mux.description.timescale;
    const pts = samples.map((s) => this.convert(s.timestamp, ts));
    const dts = reconstructDts(pts);

    // Offset shared by both tracks, converted into this track's clock.
    const offset = Math.round((this.presentationOffsetSeconds ?? 0) * ts);
    for (let i = 0; i < pts.length; i++) pts[i] += offset;
    // Audio has no B-frames: its DTS follows its PTS, offset included. Video
    // keeps a DTS that starts at zero — that's the whole point of the offset.
    if (mux.description.type === "audio") {
      for (let i = 0; i < dts.length; i++) dts[i] += offset;
    }

    return samples.map((s, i) => {
      // Duration = gap to the next DTS. For the fragment's last sample, the
      // next frame (still buffered) is used; failing that, the previous gap
      // is reused for lack of anything better.
      let duration: number;
      if (i + 1 < dts.length) {
        duration = dts[i + 1] - dts[i];
      } else if (next) {
        duration = Math.max(1, this.convert(next.timestamp, ts) - dts[i]);
      } else if (s.duration) {
        duration = this.convert(s.duration, ts);
      } else if (dts.length >= 2) {
        duration = dts[dts.length - 1] - dts[dts.length - 2];
      } else {
        duration = Math.round(ts / 25); // last resort: 25 fps
      }

      return {
        pts: pts[i],
        dts: dts[i],
        duration: Math.max(0, duration),
        keyframe: mux.description.type === "audio" ? true : s.keyframe,
        data: s.data,
      };
    });
  }
}

function codecLabel(choice: ChosenTrack): string {
  return choice.description.codec;
}
