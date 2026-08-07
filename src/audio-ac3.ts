import type { Sample, Track } from "./matroska/demuxer.js";
import type { FromWorkerMessage, ToWorkerMessage } from "./ac3-worker.js";

/**
 * AC-3 playback via the Web Audio API — the path used when `<video>`/MediaSource
 * can't play the audio itself (no browser decodes AC-3 natively) but we can
 * decode it ourselves (see `codecs/ac3/`, verified at 0.9999999990 correlation
 * against ffmpeg — see `trame.ts`).
 *
 * The picture still goes through MediaSource as usual (silent — AC-3 is
 * excluded from muxing); this module plays the sound SEPARATELY, locked to
 * `<video>`'s clock via `AudioContext.currentTime`. No alternative:
 * MediaSource can only append AAC/Opus, never raw PCM.
 *
 * DECODING RUNS IN A WORKER (`ac3-worker.ts`), not here — see that file for
 * why. This class only does the cheap part: turn PCM the worker already
 * produced into an `AudioBuffer` and schedule it.
 *
 * KNOWN LIMITATIONS, accepted for now (not bugs — see `trame.ts`):
 *  - the LFE ("`.1`") channel is not decoded at all;
 *  - channel order follows the bitstream order (acmod), not necessarily the
 *    standard WAV/Web Audio order for 5.1 (L,C,R,Ls,Rs vs L,R,C,LFE,...).
 * Mono and stereo (the most common cases for a French dub) have NEITHER
 * limitation: no channel-order ambiguity with 1-2 full-bandwidth channels.
 */

export type Ac3AudioOptions = {
  /** Video whose clock we follow — never started or paused by this class itself. */
  video: HTMLVideoElement;
  onError?: (e: Error) => void;
};

/**
 * Beyond this drift between the scheduling pointer and the expected instant
 * (video anchor), it's no longer normal jitter but a REAL discontinuity
 * (rebuffering, accumulated drift) — resync from the anchor instead of
 * gluing a buffer to a moment that no longer makes sense. 150ms: past that,
 * an audio/video offset becomes perceptible anyway — no point staying
 * "faithful" to a pointer that has drifted.
 */
const RESYNC_THRESHOLD_S = 0.15;

export class Ac3AudioPlayer {
  private worker: Worker | null = null;
  private context: AudioContext | null = null;
  private channelCount = 0;
  private sampleRate = 0;
  private scheduledSources = new Set<AudioBufferSourceNode>();
  private videoAnchorS = 0;
  private audioAnchorS = 0;
  private anchored = false;
  /**
   * Scheduling pointer — the `AudioContext` instant where the NEXT buffer
   * must start. Advanced by its exact duration on every call, never
   * recomputed from the anchor for a buffer that immediately follows the
   * previous one — that's what guarantees EXACT abutment between two
   * buffers. Recomputed from the anchor only on a REAL discontinuity (first
   * buffer, seek, or detected drift) — see [RESYNC_THRESHOLD_S].
   */
  private nextWhen: number | null = null;
  private detached = false;
  /** Debug only — avoids saying "codec seen" or "unsupported codec" on every call. */
  private codecAnnounced = false;
  private unsupportedCodecAnnounced = false;

  constructor(private readonly opt: Ac3AudioOptions) {
    opt.video.addEventListener("playing", this.reanchor);
    opt.video.addEventListener("seeking", this.onSeek);
    opt.video.addEventListener("pause", this.onPause);
  }

  detach() {
    this.detached = true;
    this.opt.video.removeEventListener("playing", this.reanchor);
    this.opt.video.removeEventListener("seeking", this.onSeek);
    this.opt.video.removeEventListener("pause", this.onPause);
    this.worker?.terminate();
    this.worker = null;
    for (const src of this.scheduledSources) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    this.scheduledSources.clear();
    void this.context?.close();
    this.context = null;
  }

  /**
   * Drops sources scheduled but not yet played — the same gesture as a
   * video seek — and tells the worker to reset each channel's overlap-add
   * state (see `ac3-worker.ts`'s "seek" handling for why that matters).
   */
  private onSeek = () => {
    for (const src of this.scheduledSources) {
      try {
        src.stop();
      } catch {
        // already stopped or already played
      }
    }
    this.scheduledSources.clear();
    this.worker?.postMessage({ type: "seek" } satisfies ToWorkerMessage);
    this.anchored = false;
    this.nextWhen = null; // force a resync from the anchor on the next buffer
  };

  /**
   * LIVED REGRESSION: without `suspend()`, a video pause only marked
   * `anchored=false` — already-scheduled `AudioBufferSourceNode`s (sometimes
   * several seconds ahead, since the worker keeps decoding while paused —
   * see `waitIfFull` in `player.ts`) kept playing on the
   * `AudioContext` clock, which never stops on its own. Symptom: pause the
   * video → picture freezes, sound keeps going by itself. `suspend()`
   * freezes `currentTime` WITHOUT dropping already-scheduled sources — on
   * `resume()`, everything picks up exactly where it was, no need to
   * re-anchor or resync (unlike a real seek).
   */
  private onPause = () => {
    this.anchored = false;
    void this.context?.suspend();
  };

  private reanchor = () => {
    if (!this.context) return;
    // LIVED REGRESSION: unconditionally resuming here reopened the exact bug
    // `onPause` fixes. Decoding keeps running while paused (see `onPause`'s
    // comment), so a seek made WHILE paused still produces new `pcm`
    // messages — `schedule()` sees `anchored=false` (set by `onSeek`) and
    // calls `reanchor()` regardless of play state, which used to resume the
    // context unconditionally: pausing, then seeking, made the sound start
    // again on its own even though the video stayed frozen. Only resume when
    // the video is ACTUALLY playing; the "playing" listener re-anchors for
    // real once it genuinely does.
    if (this.context.state === "suspended" && !this.opt.video.paused) void this.context.resume();
    this.videoAnchorS = this.opt.video.currentTime;
    this.audioAnchorS = this.context.currentTime;
    this.anchored = true;
  };

  /**
   * Receives ONE Matroska sample (potentially several concatenated AC-3
   * frames — rare but possible) and hands its raw bytes to the worker for
   * decoding. `pcm` messages come back asynchronously and get scheduled as
   * they arrive.
   *
   * @param timestampScaleNs nanoseconds per Matroska tick (`demuxer.timestampScale`).
   */
  receive(s: Sample, track: Track, timestampScaleNs: number) {
    if (this.detached) return;
    if (!this.codecAnnounced) {
      this.codecAnnounced = true;
      console.log(`[audio-ac3] audio track detected by the demuxer: ${track.codecId}`);
    }
    if (track.codecId !== "A_AC3") {
      // E-AC-3, DTS, TrueHD… not our decoder, no sound will come out of here.
      // Say it once instead of leaving a silent mute with no explanation.
      if (!this.unsupportedCodecAnnounced) {
        this.unsupportedCodecAnnounced = true;
        console.warn(
          `[audio-ac3] ${track.codecId} is not plain AC-3: this decoder doesn't handle it, ` +
            "no sound will come out of this path (E-AC-3/DTS/TrueHD not covered).",
        );
      }
      return;
    }

    if (!this.worker) {
      this.worker = new Worker(new URL("./ac3-worker.js", import.meta.url), { type: "module" });
      this.worker.onmessage = (event: MessageEvent<FromWorkerMessage>) => this.onWorkerMessage(event.data);
      this.worker.onerror = (event) =>
        this.opt.onError?.(new Error(`[audio-ac3] worker error: ${event.message}`));
    }

    const timestampS = (s.timestamp * timestampScaleNs) / 1e9;
    // Copy, not transfer: `s.data` may be a view into a buffer the
    // demuxer still needs elsewhere — transferring it would silently detach
    // that shared buffer out from under it. A single AC-3 frame is a few
    // hundred bytes to a couple KB; copying it is negligible next to the
    // 100-350ms blocks this whole file exists to eliminate.
    const data = s.data.slice();
    this.worker.postMessage({ type: "sample", data, timestampS } satisfies ToWorkerMessage, [data.buffer]);
  }

  private onWorkerMessage(msg: FromWorkerMessage) {
    if (this.detached) return;
    if (msg.type === "pcm") this.schedule(msg.channels, msg.timestampS, msg.sampleRate);
  }

  private schedule(channels: Float32Array<ArrayBuffer>[], timestampS: number, sampleRate: number) {
    if (this.detached) return;
    if (!this.context || this.channelCount !== channels.length || this.sampleRate !== sampleRate) {
      // First packet, or a (rare) mid-stream configuration change.
      this.channelCount = channels.length;
      this.sampleRate = sampleRate;
      this.context?.close().catch(() => {});
      this.context = new AudioContext({ sampleRate: this.sampleRate });
      // A fresh context defaults to "running" — if decoded audio happens to
      // arrive while the video is already paused (e.g. paused right after
      // hitting play, before the first frame came back), match that state
      // immediately instead of audibly starting for a moment.
      if (this.opt.video.paused) void this.context.suspend();
      this.anchored = false;
    }
    const ctx = this.context;
    if (!this.anchored) this.reanchor();

    const buffer = ctx.createBuffer(this.channelCount, channels[0].length, this.sampleRate);
    for (let ch = 0; ch < this.channelCount; ch++) buffer.copyToChannel(channels[ch], ch);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    // The "expected" instant from the video anchor — used to DETECT a
    // discontinuity, not to schedule directly (otherwise we're back to the
    // original bug: a single anchor too imprecise to glue buffers end to
    // end without a micro-gap or overlap).
    const expected = this.audioAnchorS + (timestampS - this.videoAnchorS);
    const alreadyLate = this.nextWhen === null || this.nextWhen < ctx.currentTime;
    const drifted = this.nextWhen !== null && Math.abs(expected - this.nextWhen) > RESYNC_THRESHOLD_S;

    let when: number;
    if (alreadyLate || drifted) {
      // First scheduling, or a real discontinuity: start over from the anchor.
      when = Math.max(expected, ctx.currentTime + 0.01);
      if (this.nextWhen !== null) {
        // NOT the very first scheduling: a real hiccup mid-playback — an
        // audible gap (or jump), not just an expected anchor adjustment.
        const lateBySeconds = ctx.currentTime - this.nextWhen;
        console.warn(
          `[audio-ac3] scheduling hiccup: ${alreadyLate ? `${lateBySeconds.toFixed(3)}s late` : "drifted"} ` +
            `(expected=${expected.toFixed(3)} nextWhen=${this.nextWhen.toFixed(3)} currentTime=${ctx.currentTime.toFixed(3)})`,
        );
      }
    } else {
      // Normal case, by far the most frequent: glued EXACTLY to the end of
      // the previous buffer, without going back through the anchor (and its
      // imprecision).
      when = this.nextWhen!;
    }

    source.start(when);
    this.nextWhen = when + buffer.duration;
    this.scheduledSources.add(source);
    source.onended = () => this.scheduledSources.delete(source);
  }
}
