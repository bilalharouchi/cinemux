/**
 * Dedicated Worker that decodes AC-3 audio frames off the main thread.
 *
 * WHY THIS EXISTS — measured on a real movie, every "main thread blocked"
 * event during playback was 95-98% AC-3 decode time (100-350ms per network
 * chunk, RECURRING throughout, not just at startup — see `audio-ac3.ts`).
 * A browser tab is single-threaded: that time was stolen from video
 * rendering AND from the network read loop that feeds MediaSource. Over an
 * hour of playback, repeated theft was enough to drain the buffer to zero
 * and cause real stalls, not just visual jank. Moving the decode here
 * removes AC-3 entirely from the main thread's critical path — only cheap
 * PCM scheduling (AudioBuffer + AudioBufferSourceNode) stays there.
 *
 * Protocol: the main thread posts raw Matroska sample bytes (each may hold
 * one or more concatenated AC-3 frames); this worker scans for sync words,
 * decodes every frame it finds, and posts back one `pcm` message per frame
 * — fully synthesized audio, ready to schedule as-is.
 */

import { decodeFrame as decodeAc3Frame, readHeader } from "./codecs/ac3/trame.js";
import { BitReader } from "./codecs/ac3/bits.js";
import { ChannelSynthesis } from "./codecs/ac3/synthese.js";
import { downmixToStereo } from "./codecs/ac3/downmix.js";

export type ToWorkerMessage = { type: "sample"; data: Uint8Array; timestampS: number } | { type: "seek" };

export type FromWorkerMessage = {
  type: "pcm";
  // `<ArrayBuffer>`, not the default `<ArrayBufferLike>`: these are always
  // plain `new Float32Array(n)` allocations, never `SharedArrayBuffer` —
  // `AudioBuffer.copyToChannel` (audio-ac3.ts) is typed to require exactly that.
  //
  // Always exactly 2 entries (downmixed — see downmixToStereo below),
  // whatever the source's acmod was: audio-ac3.ts never has to reason about
  // channel count or order.
  channels: Float32Array<ArrayBuffer>[];
  timestampS: number;
  sampleRate: number;
};

/**
 * `self` is typed as `Window` by the shared "DOM" lib this package compiles
 * with (also used by `audio-ac3.ts`, which genuinely needs it) — TypeScript
 * won't let a single project mix "DOM" and "webworker" libs (their globals
 * conflict). Casting locally, once, avoids touching the shared tsconfig.
 */
type WorkerScope = {
  postMessage(message: FromWorkerMessage, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorkerMessage>) => void) | null;
};
const worker = self as unknown as WorkerScope;

let channels: ChannelSynthesis[] = [];
let channelCount = 0;
let sampleRate = 0;

let framesOk = 0;
let framesRejected = 0;
let sawAnyFrame = false;
let lastRejectWarningMs = 0;

/**
 * Decode-load tracking (sliding 2s window) — now purely informational: it
 * measures THIS worker's own CPU usage, not main-thread impact, since
 * removing that impact is the entire point of this file existing.
 */
let decodeMs = 0;
let audioSecondsDecoded = 0;

function resetSynthesis() {
  if (channelCount > 0) channels = Array.from({ length: channelCount }, () => new ChannelSynthesis());
}

function handleFrame(frame: Uint8Array, timestampS: number) {
  const start = performance.now();
  const result = decodeAc3Frame(frame);
  if (!result) {
    framesRejected++;
    const now = performance.now();
    if (now - lastRejectWarningMs > 2000) {
      lastRejectWarningMs = now;
      console.warn(
        `[ac3-worker] unreadable AC-3 frame (likely bsid > 8 = E-AC-3, or a corrupt header) — ` +
          `${framesOk} ok / ${framesRejected} rejected so far`,
      );
    }
    return;
  }
  framesOk++;

  if (channelCount !== result.header.channels || sampleRate !== result.header.frequency) {
    // First frame, or a (rare) mid-stream configuration change: overlap-add
    // state must never be shared across channels or survive a channel-count
    // change, so every channel gets a fresh `ChannelSynthesis`.
    channelCount = result.header.channels;
    sampleRate = result.header.frequency;
    resetSynthesis();
  }

  // The 6 blocks of a frame (256 samples each, 1536 total) are decoded block
  // by block (overlap-add requires it) but assembled into ONE buffer per
  // channel before posting: one message per frame (~29/s) instead of one
  // per 5.8ms block (~170/s) leaves far fewer seams exposed to rounding.
  const perChannel: Float32Array<ArrayBuffer>[] = Array.from({ length: channelCount }, () => new Float32Array(1536));
  result.coefficientsPerBlock.forEach((blockChannels, i) => {
    for (let ch = 0; ch < channelCount; ch++) {
      const out = channels[ch].next(blockChannels[ch]);
      perChannel[ch].set(out, i * 256);
    }
  });

  decodeMs += performance.now() - start;
  audioSecondsDecoded += 1536 / sampleRate;
  if (audioSecondsDecoded > 2) {
    const load = decodeMs / (audioSecondsDecoded * 1000);
    console.log(
      `[ac3-worker] decode load (2s window): ${(load * 100).toFixed(1)}% of real time ` +
        `(${decodeMs.toFixed(0)} ms for ${audioSecondsDecoded.toFixed(1)} s of audio)`,
    );
    decodeMs = 0;
    audioSecondsDecoded = 0;
  }

  // Always exactly 2 channels out, whatever acmod came in — the browser has
  // no defined up/down-mix rule outside 1/2/4/6 channels (see downmix.ts).
  const stereo = downmixToStereo(result.header.acmod, perChannel) as Float32Array<ArrayBuffer>[];
  const message: FromWorkerMessage = { type: "pcm", channels: stereo, timestampS, sampleRate };
  worker.postMessage(
    message,
    stereo.map((c) => c.buffer),
  );
}

function handleSample(data: Uint8Array, timestampS: number) {
  let offset = 0;
  let foundOne = false;
  while (offset + 6 < data.length) {
    if (!(data[offset] === 0x0b && data[offset + 1] === 0x77)) {
      offset++;
      continue;
    }
    const header = readHeader(new BitReader(data.subarray(offset)));
    if (!header || header.sizeBytes === 0 || offset + header.sizeBytes > data.length) break;
    handleFrame(data.subarray(offset, offset + header.sizeBytes), timestampS);
    offset += header.sizeBytes;
    foundOne = true;
  }
  if (foundOne) sawAnyFrame = true;
  else if (!sawAnyFrame && framesOk === 0) {
    // Tagged "A_AC3" by Matroska, but no 0x0B77 sync word recognized: bsid > 8
    // (E-AC-3 sometimes shares the same CodecID on the muxer side) or
    // corrupt data — `readHeader` rejects it, we don't guess.
    console.warn(
      "[ac3-worker] track tagged A_AC3 but no recognizable frame (missing sync word or invalid " +
        "header) — often E-AC-3 sharing the same Matroska CodecID.",
    );
  }
}

worker.onmessage = (event: MessageEvent<ToWorkerMessage>) => {
  const msg = event.data;
  if (msg.type === "sample") {
    handleSample(msg.data, msg.timestampS);
  } else {
    // "seek": a jump landed somewhere unrelated in the file — the
    // overlap-add `delay` each `ChannelSynthesis` is holding belongs to
    // whatever came before the jump. Combining it with the next block would
    // splice two unrelated instants together: a real click on the very
    // first block after every seek, not a harmless approximation.
    resetSynthesis();
  }
};
