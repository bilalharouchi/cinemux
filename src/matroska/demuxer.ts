import { EbmlReader, UNKNOWN_SIZE } from "../ebml/reader.js";
import { ID, MASTER_ELEMENTS, TrackType } from "../ebml/ids.js";
import { decodeBlock } from "./blocks.js";

/**
 * **Streaming** Matroska demuxer.
 *
 * It's fed in chunks (`feed`) and never requires the whole file: this is
 * what lets playback start after a few hundred KB, instead of waiting for
 * 3 GB. An element cut off mid-chunk is simply deferred to later — hence the
 * internal buffer and the reader's `null` returns.
 */

export type VideoTrack = {
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
};

export type AudioTrack = {
  frequency: number;
  channels: number;
  bits: number | null;
};

export type Track = {
  number: number;
  type: number;
  codecId: string;
  codecPrivate: Uint8Array | null;
  /** Nanoseconds per frame, when the muxer wrote it. */
  defaultDuration: number | null;
  language: string;
  name: string | null;
  default: boolean;
  forced: boolean;
  video: VideoTrack | null;
  audio: AudioTrack | null;
  /** Opus: delay to strip at the start of the track (ns). */
  codecDelay: number | null;
};

export type Sample = {
  track: number;
  /** In Track Ticks (× timestampScale to get nanoseconds). */
  timestamp: number;
  /** Track Ticks, or null if the muxer didn't write it. */
  duration: number | null;
  keyframe: boolean;
  data: Uint8Array;
};

export type CuePoint = {
  /** Track Ticks. */
  time: number;
  /** Absolute position of the Cluster in the file, relative to the start of the Segment. */
  clusterPosition: number;
  track: number;
};

/**
 * Track currently being read, every field optional.
 *
 * An intersected `Partial<Track>` doesn't work: `video` is already
 * `VideoTrack | null` there, and the intersection produces a type nothing
 * can satisfy.
 */
type TrackInProgress = {
  number?: number;
  type?: number;
  codecId?: string;
  codecPrivate?: Uint8Array | null;
  defaultDuration?: number | null;
  language?: string;
  name?: string | null;
  default?: boolean;
  forced?: boolean;
  codecDelay?: number | null;
  video?: Partial<VideoTrack>;
  audio?: Partial<AudioTrack>;
};

type OpenElement = {
  id: number;
  /** Absolute end position, or Infinity for an unknown size. */
  end: number;
  /** EBML depth, to know when a level-1 element closes a Cluster. */
  level: number;
};

/** Level-1 elements: their appearance closes any Cluster of unknown size. */
const LEVEL_1: ReadonlySet<number> = new Set<number>([
  ID.SeekHead,
  ID.Info,
  ID.Tracks,
  ID.Cluster,
  ID.Cues,
  ID.Attachments,
  ID.Chapters,
  ID.Tags,
]);

export type DemuxerOptions = {
  onHeader?: (info: { timestampScale: number; durationMs: number | null }) => void;
  onTracks?: (tracks: Track[]) => void;
  onSample?: (s: Sample) => void;
  onCues?: (points: CuePoint[]) => void;
  /** Called when the first Cluster starts: nothing new is coming on the header side. */
  onReady?: () => void;
};

export class MatroskaDemuxer {
  /** Time scale: nanoseconds per Track Tick. 1 ms by default (spec). */
  timestampScale = 1_000_000;
  durationMs: number | null = null;
  tracks: Track[] = [];
  cues: CuePoint[] = [];

  /** Absolute position of the Segment's content — Cues are relative to it. */
  segmentPosition = 0;

  /**
   * File table of contents: element ID → absolute position.
   *
   * This is what makes seeking possible without downloading the whole movie:
   * Cues are almost always written AT THE END (the muxer only knows the
   * positions once everything is written), but the SeekHead is at the start
   * and says where to find them. A single Range request is then enough to
   * fetch the index.
   */
  seekHead = new Map<number, number>();
  private pendingSeekId: number | null = null;

  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  /** Offset in the file of `buffer`'s first byte. */
  private offset = 0;
  private stack: OpenElement[] = [];
  private clusterTimestamp = 0;
  private tracksEmitted = false;
  private readyEmitted = false;

  /** Track currently being read (TrackEntry open). */
  private currentTrack: TrackInProgress | null = null;
  private currentCue: Partial<CuePoint> | null = null;

  constructor(private readonly opt: DemuxerOptions = {}) {}

  /**
   * Repositions the demuxer at an absolute file offset (after a seek).
   * Tracks and the time scale are kept: they don't change.
   */
  seekTo(fileOffset: number) {
    this.buffer = new Uint8Array(0);
    this.offset = fileOffset;
    // Only the Segment frame survives: inner frames are invalidated by the jump.
    this.stack = this.stack.filter((f) => f.id === ID.Segment);
    this.clusterTimestamp = 0;
  }

  /** Appends bytes and consumes everything that's complete. */
  feed(chunk: Uint8Array<ArrayBufferLike>) {
    if (this.buffer.length === 0) {
      this.buffer = chunk;
    } else {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer, 0);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
    }
    this.parse();
  }

  private parse() {
    const r = new EbmlReader(this.buffer, this.offset);

    for (;;) {
      // Close finished elements before reading the next one.
      while (this.stack.length > 0) {
        const top = this.stack[this.stack.length - 1];
        if (top.end !== Infinity && r.absolutePosition >= top.end) this.closeElement();
        else break;
      }

      const start = r.pos;
      const id = r.readId();
      if (id === null) {
        r.pos = start;
        break;
      }
      const size = r.readSize();
      if (size === null) {
        r.pos = start;
        break;
      }

      // A level-1 element closes an unknown-size Cluster.
      if (LEVEL_1.has(id)) {
        while (this.stack.length > 0 && this.stack[this.stack.length - 1].level >= 1) {
          this.closeElement();
        }
      }

      if (MASTER_ELEMENTS.has(id)) {
        this.openElement(id, size === UNKNOWN_SIZE ? Infinity : r.absolutePosition + size, r);
        continue;
      }

      // Leaf: reading it requires the whole content.
      if (size === UNKNOWN_SIZE || r.remaining < size) {
        r.pos = start;
        break;
      }

      const leafEnd = r.pos + size;
      this.readLeaf(id, size, r);
      r.pos = leafEnd; // safety net: a mis-read leaf doesn't desync the stream
    }

    // Keep the unconsumed tail.
    if (r.pos > 0) {
      this.buffer = this.buffer.slice(r.pos);
      this.offset += r.pos;
    }
  }

  private openElement(id: number, end: number, r: EbmlReader) {
    const level = id === ID.Segment || id === ID.EBML ? 0 : LEVEL_1.has(id) ? 1 : this.stack.length;
    this.stack.push({ id, end, level });

    if (id === ID.Segment) this.segmentPosition = r.absolutePosition;
    if (id === ID.TrackEntry) this.currentTrack = {};
    // The accumulator is born with CuePoint, NOT with CueTrackPositions: CueTime
    // arrives first, and resetting it here would lose the seek point's time.
    if (id === ID.CuePoint) this.currentCue = {};

    if (id === ID.Cluster) {
      // Tracks are complete as soon as a Cluster starts.
      if (!this.tracksEmitted && this.tracks.length > 0) {
        this.tracksEmitted = true;
        this.opt.onTracks?.(this.tracks);
      }
      if (!this.readyEmitted) {
        this.readyEmitted = true;
        this.opt.onReady?.();
      }
    }
  }

  private closeElement() {
    const frame = this.stack.pop();
    if (!frame) return;

    if (frame.id === ID.TrackEntry && this.currentTrack) {
      const t = this.currentTrack;
      if (t.number != null && t.codecId) {
        this.tracks.push({
          number: t.number,
          type: t.type ?? 0,
          codecId: t.codecId,
          codecPrivate: t.codecPrivate ?? null,
          defaultDuration: t.defaultDuration ?? null,
          language: t.language ?? "und",
          name: t.name ?? null,
          default: t.default ?? true,
          forced: t.forced ?? false,
          video: t.video
            ? {
                width: t.video.width ?? 0,
                height: t.video.height ?? 0,
                // Without DisplayWidth, display follows the coded pixels.
                displayWidth: t.video.displayWidth ?? t.video.width ?? 0,
                displayHeight: t.video.displayHeight ?? t.video.height ?? 0,
              }
            : null,
          audio: t.audio
            ? {
                frequency: t.audio.frequency ?? 8000,
                channels: t.audio.channels ?? 1,
                bits: t.audio.bits ?? null,
              }
            : null,
          codecDelay: t.codecDelay ?? null,
        });
      }
      this.currentTrack = null;
    }

    if (frame.id === ID.Tracks && !this.tracksEmitted && this.tracks.length > 0) {
      this.tracksEmitted = true;
      this.opt.onTracks?.(this.tracks);
    }

    if (frame.id === ID.CuePoint) this.currentCue = null;

    if (frame.id === ID.Cues) {
      // Cues in a well-formed file are already sorted, but nothing enforces
      // it — the seek binary search, on the other hand, requires it.
      this.cues.sort((a, b) => a.time - b.time);
      this.opt.onCues?.(this.cues);
    }
  }

  private readLeaf(id: number, size: number, r: EbmlReader) {
    const t = this.currentTrack;
    const inAudio = this.stack.some((f) => f.id === ID.Audio);
    const inVideo = this.stack.some((f) => f.id === ID.Video);

    switch (id) {
      // --- Info ---
      case ID.TimestampScale:
        this.timestampScale = r.readUint(size);
        break;
      case ID.Duration: {
        const ticks = r.readFloat(size);
        this.durationMs = (ticks * this.timestampScale) / 1e6;
        this.opt.onHeader?.({ timestampScale: this.timestampScale, durationMs: this.durationMs });
        break;
      }

      // --- TrackEntry ---
      case ID.TrackNumber:
        if (t) t.number = r.readUint(size);
        break;
      case ID.TrackType:
        if (t) t.type = r.readUint(size);
        break;
      case ID.CodecID:
        if (t) t.codecId = r.readString(size);
        break;
      case ID.CodecPrivate:
        if (t) t.codecPrivate = r.readBytes(size);
        break;
      case ID.DefaultDuration:
        if (t) t.defaultDuration = r.readUint(size);
        break;
      case ID.Language:
        if (t && !t.language) t.language = r.readString(size);
        break;
      case ID.LanguageBCP47:
        // BCP47 is more precise ("fr-FR") than Language ("fre") and wins over it.
        if (t) t.language = r.readString(size);
        break;
      case ID.Name:
        if (t) t.name = r.readString(size);
        break;
      case ID.FlagDefault:
        if (t) t.default = r.readUint(size) !== 0;
        break;
      case ID.FlagForced:
        if (t) t.forced = r.readUint(size) !== 0;
        break;
      case ID.CodecDelay:
        if (t) t.codecDelay = r.readUint(size);
        break;

      // --- Video ---
      case ID.PixelWidth:
        if (t && inVideo) (t.video ??= {}).width = r.readUint(size);
        break;
      case ID.PixelHeight:
        if (t && inVideo) (t.video ??= {}).height = r.readUint(size);
        break;
      case ID.DisplayWidth:
        if (t && inVideo) (t.video ??= {}).displayWidth = r.readUint(size);
        break;
      case ID.DisplayHeight:
        if (t && inVideo) (t.video ??= {}).displayHeight = r.readUint(size);
        break;

      // --- Audio ---
      case ID.SamplingFrequency:
        if (t && inAudio) (t.audio ??= {}).frequency = r.readFloat(size);
        break;
      case ID.OutputSamplingFrequency:
        // Output frequency (AAC HE doubles the frequency): this is the one that counts.
        if (t && inAudio) (t.audio ??= {}).frequency = r.readFloat(size);
        break;
      case ID.Channels:
        if (t && inAudio) (t.audio ??= {}).channels = r.readUint(size);
        break;
      case ID.BitDepth:
        if (t && inAudio) (t.audio ??= {}).bits = r.readUint(size);
        break;

      // --- Cluster ---
      case ID.Timestamp:
        this.clusterTimestamp = r.readUint(size);
        break;
      case ID.SimpleBlock:
        this.emitBlock(r.readBytes(size), true, null);
        break;
      case ID.Block:
        // Inside a BlockGroup: the keyframe is inferred from the absence of a
        // ReferenceBlock, which hasn't been read yet. It's settled when the
        // group closes — in practice, a BlockGroup with no ReferenceBlock is
        // rare and usually non-key, so it's marked non-key here and left for
        // the player to sort out.
        this.emitBlock(r.readBytes(size), false, null);
        break;

      // --- SeekHead: the file's table of contents ---
      case ID.SeekID: {
        const bytes = r.readBytes(size);
        let value = 0;
        for (const b of bytes) value = value * 256 + b;
        this.pendingSeekId = value;
        break;
      }
      case ID.SeekPosition: {
        const position = r.readUint(size);
        if (this.pendingSeekId !== null) {
          // Relative to the Segment, like Cues.
          this.seekHead.set(this.pendingSeekId, this.segmentPosition + position);
          this.pendingSeekId = null;
        }
        break;
      }

      // --- Cues ---
      case ID.CueTime:
        if (this.currentCue === null) this.currentCue = {};
        this.currentCue.time = r.readUint(size);
        break;
      case ID.CueTrack:
        if (this.currentCue) this.currentCue.track = r.readUint(size);
        break;
      case ID.CueClusterPosition: {
        const position = r.readUint(size);
        if (this.currentCue?.time != null) {
          this.cues.push({
            time: this.currentCue.time,
            // Cue positions are relative to the start of the Segment.
            clusterPosition: this.segmentPosition + position,
            track: this.currentCue.track ?? 1,
          });
        }
        break;
      }

      default:
        break; // unused element: `r.pos` is realigned by the caller
    }
  }

  private emitBlock(data: Uint8Array, simple: boolean, duration: number | null) {
    const block = decodeBlock(data, simple);
    if (!block) return;

    const base = this.clusterTimestamp + block.relativeTimestamp;
    // Laced frames share the block's timestamp. Without DefaultDuration they
    // can't be spread apart — muxers that lace always write it.
    const step =
      block.frames.length > 1 && this.tracks.length > 0 ? this.durationTicks(block.trackNumber) : 0;

    block.frames.forEach((frame, i) => {
      this.opt.onSample?.({
        track: block.trackNumber,
        timestamp: base + (step ? step * i : 0),
        duration: duration ?? (step || null),
        keyframe: block.keyframe,
        data: frame,
      });
    });
  }

  /** A track's DefaultDuration, converted from nanoseconds to Track Ticks. */
  private durationTicks(trackNumber: number): number {
    const track = this.tracks.find((t) => t.number === trackNumber);
    if (!track?.defaultDuration) return 0;
    return track.defaultDuration / this.timestampScale;
  }

  /** Usable tracks sorted: video then audio, the "default" track first. */
  tracksByType(type: number): Track[] {
    return this.tracks.filter((t) => t.type === type).sort((a, b) => Number(b.default) - Number(a.default));
  }

  get videoTrack(): Track | null {
    return this.tracksByType(TrackType.VIDEO)[0] ?? null;
  }
}
