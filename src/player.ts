import { Remuxer, type Diagnostic } from "./remuxer.js";
import { MatroskaDemuxer, type CuePoint } from "./matroska/demuxer.js";
import { ID } from "./ebml/ids.js";
import type { Source } from "./source/index.js";
import { Ac3AudioPlayer } from "./audio-ac3.js";

/**
 * Wires an MKV up to a `<video>` via MediaSource.
 *
 * The point of going through a real `<video>` element instead of a canvas:
 * native controls, fullscreen, picture-in-picture, the subtitle track,
 * casting, and keyboard shortcuts all come for free. A homemade player
 * would have to reimplement all of it, and worse.
 */

export type PlaybackOptions = {
  /** Preferred audio language when the file offers several. */
  preferredLanguage?: string;
  /**
   * Target buffer-ahead distance, in seconds. Past it, downloading stops:
   * no point pulling 3 GB when the user might stop in 10s.
   */
  targetBufferAheadS?: number;
  /** Memory kept behind the playhead, in seconds. */
  keepBehindS?: number;
  onDiagnostic?: (d: Diagnostic) => void;
  onError?: (e: Error) => void;
};

/** Bytes read at startup to find the tracks and the SeekHead. */
const HEADER_SIZE = 256 * 1024;

export class Cinemux {
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private remuxer: Remuxer | null = null;
  private objectUrl: string | null = null;
  /** AC-3 sound played alongside MediaSource (which can only carry the picture) — see `audio-ac3.ts`. */
  private audioAc3: Ac3AudioPlayer | null = null;

  private cues: CuePoint[] = [];
  private cuesScale = 1_000_000;
  private segmentQueue: Uint8Array[] = [];
  private appending = false;
  private pumpController: AbortController | null = null;
  private detached = false;
  private diag: Diagnostic | null = null;
  private streamEnded = false;

  private constructor(
    private readonly video: HTMLVideoElement,
    private readonly source: Source,
    private readonly opt: PlaybackOptions,
  ) {}

  static async attach(
    video: HTMLVideoElement,
    source: Source,
    options: PlaybackOptions = {},
  ): Promise<Cinemux> {
    const instance = new Cinemux(video, source, options);
    await instance.start();
    return instance;
  }

  get diagnostic(): Diagnostic | null {
    return this.diag;
  }

  /** Is seeking possible? False if the server ignores Range or there's no index. */
  get seekable(): boolean {
    return this.cues.length > 0;
  }

  detach() {
    this.detached = true;
    this.pumpController?.abort();
    this.video.removeEventListener("seeking", this.onSeek);
    this.video.removeEventListener("timeupdate", this.onTimeUpdate);
    this.audioAc3?.detach();
    this.audioAc3 = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    try {
      if (this.mediaSource?.readyState === "open") this.mediaSource.endOfStream();
    } catch {
      // MediaSource already closed: nothing to do.
    }
    this.video.removeAttribute("src");
    this.video.load();
  }

  // -------------------------------------------------------------------------

  private async start() {
    if (typeof MediaSource === "undefined") {
      throw new Error("MediaSource unavailable in this browser");
    }

    // The seek index BEFORE playback: it lives at the end of the file, and
    // fetching it once playback has started would steal bandwidth from the
    // picture. A failure isn't fatal — playback just won't be seekable.
    await this.loadIndex().catch(() => undefined);

    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);

    const opened = new Promise<void>((resolve) => {
      this.mediaSource!.addEventListener("sourceopen", () => resolve(), { once: true });
    });
    this.video.src = this.objectUrl;
    await opened;

    this.video.addEventListener("seeking", this.onSeek);
    this.video.addEventListener("timeupdate", this.onTimeUpdate);

    // DEBUG — `waiting` is the DIRECT signal of a dry MSE buffer (picture
    // frozen/black from lack of data): more reliable than inferring it from
    // a visual symptom. `bufferAhead()` at the same instant says whether it's a
    // download shortfall (bufferAhead ≈ 0) or something else (buffer normal despite it).
    let waitStartedAt = 0;
    this.video.addEventListener("waiting", () => {
      waitStartedAt = performance.now();
      console.warn(
        `[player] video waiting for data (t=${this.video.currentTime.toFixed(1)}s, ` +
          `buffer ahead=${this.bufferAhead().toFixed(1)}s) — picture likely frozen/black`,
      );
    });
    this.video.addEventListener("playing", () => {
      if (waitStartedAt) {
        console.log(`[player] resumed after ${(performance.now() - waitStartedAt).toFixed(0)}ms of waiting`);
        waitStartedAt = 0;
      }
    });

    this.startPump(0);
  }

  /**
   * Fetches the Cues index without downloading the whole movie.
   *
   * Two requests: the header (where the SeekHead lives, which says WHERE the
   * Cues are), then the Cues' own range. On a 3 GB file, that costs a few
   * hundred KB instead of everything.
   */
  private async loadIndex() {
    if (!(await this.source.supportsRanges())) return;
    const size = await this.source.size();
    if (!size) return;

    const header = await this.source.read(0, Math.min(HEADER_SIZE, size) - 1);
    const probe = new MatroskaDemuxer();
    probe.feed(header);
    this.cuesScale = probe.timestampScale;

    const cuesPosition = probe.seekHead.get(ID.Cues);
    if (cuesPosition == null || cuesPosition >= size) return;

    // Cues extend up to another element or the end: a wide range is taken
    // and the demuxer will stop on its own at what it understands.
    const cuesEnd = Math.min(cuesPosition + 8 * 1024 * 1024, size) - 1;
    const bytes = await this.source.read(cuesPosition, cuesEnd);

    const cuesReader = new MatroskaDemuxer();
    // The demuxer expects absolute positions: it's told where it is and
    // given back the Segment origin read from the header.
    cuesReader.seekTo(cuesPosition);
    cuesReader.segmentPosition = probe.segmentPosition;
    cuesReader.timestampScale = probe.timestampScale;
    cuesReader.feed(bytes);

    if (cuesReader.cues.length > 0) this.cues = cuesReader.cues;
  }

  private createRemuxer(): Remuxer {
    return new Remuxer({
      preferredLanguage: this.opt.preferredLanguage,
      onInit: (segment, diag) => {
        // `Remuxer` doesn't know `Ac3AudioPlayer` exists: it only knows what
        // MediaSource can take. `mutedAudio` is corrected HERE, not in
        // `Remuxer`, to avoid coupling a low-level module (fMP4) to a
        // high-level decision (how to PLAY the sound on the browser side).
        if (diag.audio?.track.codecId === "A_AC3" && diag.mutedAudio) {
          diag = { ...diag, mutedAudio: false };
        }
        console.log(
          `[player] audio track chosen: ${diag.audio?.track.codecId ?? "none"} · ` +
            `natively supported=${diag.audio?.supported ?? "n/a"} · mutedAudio=${diag.mutedAudio}`,
        );
        this.diag = diag;
        this.opt.onDiagnostic?.(diag);

        if (!this.sourceBuffer && this.mediaSource?.readyState === "open") {
          if (!MediaSource.isTypeSupported(diag.mime)) {
            // `diag.mime` already only describes the muxed tracks: if it
            // still fails, it's the VIDEO this browser can't take.
            const v = diag.video;
            this.opt.onError?.(
              new Error(
                v
                  ? `This browser can't decode this video (${v.track.codecId} → ${v.description.codec}). ` +
                    "On another device or version, it would play."
                  : `No usable codec: ${diag.mime}`,
              ),
            );
            return;
          }
          this.sourceBuffer = this.mediaSource.addSourceBuffer(diag.mime);
          this.sourceBuffer.mode = "segments";
          this.sourceBuffer.addEventListener("updateend", () => {
            this.appending = false;
            this.pushNext();
          });
          if (diag.durationMs) {
            try {
              this.mediaSource.duration = diag.durationMs / 1000;
            } catch {
              // Duration rejected (MediaSource busy): the browser will infer it.
            }
          }
        }
        this.segmentQueue.push(segment);
        this.pushNext();
      },
      onSegment: (segment) => {
        this.segmentQueue.push(segment);
        this.pushNext();
      },
      onError: (e) => this.opt.onError?.(e),
      // AC-3 that no browser decodes natively: it's played ourselves, via
      // Web Audio, alongside MediaSource's silent picture. Created on the
      // first packet only — no AudioContext for a file that doesn't need
      // one (browser autoplay policy, resources).
      onUnmuxedSample: (s, track, timestampScaleNs) => {
        if (track.codecId !== "A_AC3") return;
        if (!this.audioAc3) this.audioAc3 = new Ac3AudioPlayer({ video: this.video });
        this.audioAc3.receive(s, track, timestampScaleNs);
      },
    });
  }

  /** Stacks segments one at a time: `appendBuffer` refuses to run concurrently. */
  private pushNext() {
    if (this.detached || this.appending) return;
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || this.mediaSource?.readyState !== "open") return;

    const segment = this.segmentQueue.shift();
    if (!segment) {
      if (this.streamEnded) this.endStream();
      return;
    }

    this.appending = true;
    try {
      sb.appendBuffer(segment as unknown as BufferSource);
    } catch (e) {
      this.appending = false;
      if (e instanceof DOMException && e.name === "QuotaExceededError") {
        // Buffer full: freeing memory behind the playhead and retrying.
        this.segmentQueue.unshift(segment);
        this.freeMemory(true);
        return;
      }
      this.opt.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private endStream() {
    if (this.mediaSource?.readyState !== "open") return;
    if (this.sourceBuffer?.updating) return;
    try {
      this.mediaSource.endOfStream();
    } catch {
      // Already ended.
    }
  }

  /**
   * Download loop: reads the source, remuxes, and pauses as soon as the
   * buffer is full enough. This is what avoids pulling the whole movie.
   */
  private async startPump(startOffset: number) {
    this.pumpController?.abort();
    const controller = new AbortController();
    this.pumpController = controller;

    this.streamEnded = false;

    /**
     * On a SEEK, the remuxer is REUSED instead of creating a new one.
     *
     * WHY — a fresh remuxer waits for the `Tracks` element to learn the
     * tracks and emit its init segment. But after a jump, playback resumes
     * from a Cluster, mid-file: that `Tracks` element will never arrive
     * again. The remuxer would then sit waiting forever, never producing a
     * single segment — the buffer would freeze and playback would never
     * resume. Reusing it keeps the already-described tracks; `seekTo` only
     * clears the buffers, so samples from before the jump don't get glued
     * to samples from after.
     */
    if (startOffset > 0 && this.remuxer && this.remuxer.diagnostic) {
      this.remuxer.seekTo(startOffset);
    } else {
      this.remuxer = this.createRemuxer();
    }

    try {
      for await (const chunk of this.source.stream(startOffset, controller.signal)) {
        if (controller.signal.aborted || this.detached) return;
        // DEBUG — `feed` runs ENTIRELY synchronously (Matroska demux +
        // fMP4 remux of the video): nothing else advances on the main thread
        // while it's running. MEASURED AND FIXED REGRESSION: AC-3 decoding
        // (parsing + IMDCT) used to run right HERE, synchronously inside
        // `onUnmuxedSample` — 95 to 98% of every blocking event
        // measured on a real movie (100-350ms per network chunk, and NOT
        // just at startup: it kept recurring throughout, also stealing time
        // from THIS `for await`, which eventually drained the buffer dry
        // twice in one hour). Decoding moved to a Worker (`ac3-worker.ts`,
        // `audio-ac3.ts`) — what's left here should now be the video path only.
        const start = performance.now();
        this.remuxer.feed(chunk);
        const durationMs = performance.now() - start;
        if (durationMs > 100) {
          console.warn(
            `[player] feed() blocked the main thread for ${durationMs.toFixed(0)}ms ` +
              `(chunk of ${chunk.length} bytes) — past ~50ms is already a visible stutter`,
          );
        }
        await this.waitIfFull(controller.signal);
      }
      if (!controller.signal.aborted) {
        this.remuxer.finish();
        this.streamEnded = true;
        this.pushNext();
      }
    } catch (e) {
      if (controller.signal.aborted || this.detached) return;
      this.opt.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** Suspends reading the source as long as there's enough buffer ahead. */
  private async waitIfFull(signal: AbortSignal) {
    const target = this.opt.targetBufferAheadS ?? 30;
    while (!signal.aborted && this.bufferAhead() > target) {
      this.freeMemory(false);
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        // Wakes up on playback progress or a seek.
        this.video.addEventListener("timeupdate", done, { once: true });
        this.video.addEventListener("seeking", done, { once: true });
        setTimeout(done, 500); // safety net: video paused, no event
      });
    }
  }

  /** Seconds already buffered ahead of the playhead. */
  private bufferAhead(): number {
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

  /** Frees memory from ranges far behind the playhead. */
  private freeMemory(aggressive: boolean) {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating) return;
    const kept = aggressive ? 5 : (this.opt.keepBehindS ?? 60);
    const limit = this.video.currentTime - kept;
    if (limit <= 0) return;

    for (let i = 0; i < sb.buffered.length; i++) {
      const start = sb.buffered.start(i);
      const end = Math.min(sb.buffered.end(i), limit);
      if (end > start) {
        try {
          sb.remove(start, end);
        } catch {
          // `remove` refused during an update: next round.
        }
        return; // one removal at a time (`remove` is asynchronous)
      }
    }
  }

  // -------------------------------------------------------------------------

  private onTimeUpdate = () => {
    this.pushNext();
  };

  /**
   * Seek. A new download is only started if the target is NOT already
   * buffered: jumping 10s within what's already there should cost nothing.
   */
  private onSeek = () => {
    const target = this.video.currentTime;
    if (this.isBuffered(target)) return;
    if (this.cues.length === 0) return; // no index: the browser handles it on its own

    const point = this.cueFor(target);
    if (!point) return;

    this.segmentQueue = [];
    // `abort()` cancels the append in progress; without it, `appendBuffer` would throw.
    try {
      if (this.sourceBuffer && this.mediaSource?.readyState === "open") {
        this.sourceBuffer.abort();
      }
    } catch {
      // Nothing in progress: fine.
    }
    this.appending = false;
    void this.startPump(point.clusterPosition);
  };

  private isBuffered(t: number): boolean {
    const sb = this.sourceBuffer;
    if (!sb) return false;
    for (let i = 0; i < sb.buffered.length; i++) {
      // Half-second margin: the buffer might be missing a few frames.
      if (t >= sb.buffered.start(i) && t <= sb.buffered.end(i) - 0.5) return true;
    }
    return false;
  }

  /** Last seek point located BEFORE the target instant. */
  private cueFor(seconds: number): CuePoint | null {
    const ticks = (seconds * 1e9) / this.cuesScale;
    let choice: CuePoint | null = null;
    // Binary search: a 3-hour movie has thousands of points.
    let low = 0;
    let high = this.cues.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.cues[mid].time <= ticks) {
        choice = this.cues[mid];
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return choice ?? this.cues[0] ?? null;
  }
}
