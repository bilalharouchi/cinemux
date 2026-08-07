/**
 * cinemux — playing MKV files in a browser.
 *
 * Principle: an MKV and an MP4 often wrap the SAME elementary streams
 * (H.264, HEVC, AV1, AAC, Opus…). The browser doesn't know how to open the
 * Matroska box, but it knows how to decode what's inside it. So the samples
 * are re-wrapped into fragmented MP4 on the fly, and handed to MediaSource.
 *
 * No bitstream byte is ever re-encoded: this isn't transcoding, it's
 * repackaging. No WASM, no COOP/COEP headers — and negligible CPU cost, with
 * ONE exception: when the audio track is AC-3 (which no browser decodes
 * natively), it's decoded in pure JS, in a dedicated Worker
 * (`ac3-worker.ts`, orchestrated by `audio-ac3.ts`) so it never blocks the
 * main thread — see that file for why (measured: 95-98% of every main
 * thread stall, before).
 *
 * ```ts
 * import { Cinemux, HttpSource } from "cinemux";
 *
 * const player = await Cinemux.attach(
 *   document.querySelector("video")!,
 *   new HttpSource("/movie.mkv"),
 *   { preferredLanguage: "fr" },
 * );
 * console.log(player.diagnostic);
 * ```
 */

export { Cinemux, type PlaybackOptions } from "./player.js";
export { Remuxer, type Diagnostic, type ChosenTrack, type RemuxerOptions } from "./remuxer.js";
export { HttpSource } from "./source/http.js";
export { BlobSource } from "./source/blob.js";
export type { Source } from "./source/index.js";

export { MatroskaDemuxer } from "./matroska/demuxer.js";
export type { Track, Sample, CuePoint } from "./matroska/demuxer.js";
export { TrackType } from "./ebml/ids.js";

export { describe, parseAc3Header, mimeFor, UnsupportedCodec, type Description } from "./codecs/index.js";
export { segmentInit, mediaSegment, reconstructDts } from "./mp4/muxer.js";

/**
 * Can this browser play MKV via cinemux?
 *
 * Returns false without MediaSource (old browsers, and especially Safari on
 * iPhone, where MSE doesn't exist outside "Managed Media Source" mode).
 */
export function browserCompatible(): boolean {
  return typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function";
}

/**
 * Codecs actually decodable here, to inform the caller before even opening
 * a file. Useful for choosing a source server-side instead of failing in
 * front of the user.
 */
export function availableCodecs(): Record<string, boolean> {
  if (typeof MediaSource === "undefined") return {};
  const test = (mime: string) => MediaSource.isTypeSupported(mime);
  return {
    "h264": test('video/mp4; codecs="avc1.640028"'),
    "hevc": test('video/mp4; codecs="hvc1.1.6.L93.B0"'),
    "av1": test('video/mp4; codecs="av01.0.08M.08"'),
    "aac": test('audio/mp4; codecs="mp4a.40.2"'),
    "opus": test('audio/mp4; codecs="opus"'),
    "flac": test('audio/mp4; codecs="flac"'),
    "ac3": test('audio/mp4; codecs="ac-3"'),
    "eac3": test('audio/mp4; codecs="ec-3"'),
  };
}
