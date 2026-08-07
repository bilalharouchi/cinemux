import { readFileSync } from "node:fs";
import { decodeFrame, readHeader } from "../src/codecs/ac3/trame.js";
import { BitReader } from "../src/codecs/ac3/bits.js";
import { ChannelSynthesis } from "../src/codecs/ac3/synthese.js";

/**
 * Decodes a raw stereo (2-channel) AC-3 stream and compares each channel,
 * bin by bin, against a reference interleaved stereo f32le PCM (ffmpeg).
 *
 * Usage: npx tsx scripts/correlate-stereo.mts <file.ac3> <reference.f32>
 */
function decode(stream: Uint8Array): [Float64Array, Float64Array] {
  const leftSynth = new ChannelSynthesis();
  const rightSynth = new ChannelSynthesis();
  const pcmL: number[] = [];
  const pcmR: number[] = [];
  let offset = 0;
  while (offset + 6 < stream.length) {
    if (!(stream[offset] === 0x0b && stream[offset + 1] === 0x77)) {
      offset++;
      continue;
    }
    const header = readHeader(new BitReader(stream.subarray(offset)));
    if (!header || header.sizeBytes === 0 || offset + header.sizeBytes > stream.length) {
      offset++;
      continue;
    }
    const res = decodeFrame(stream.subarray(offset, offset + header.sizeBytes));
    if (res) {
      for (const block of res.coefficientsPerBlock) {
        pcmL.push(...leftSynth.next(block[0]));
        pcmR.push(...rightSynth.next(block[1]));
      }
    }
    offset += header.sizeBytes;
  }
  return [Float64Array.from(pcmL), Float64Array.from(pcmR)];
}

function correlate(pcm: Float64Array, ref: Float32Array, offset: number): number {
  const n = Math.min(pcm.length - offset, ref.length);
  let dot = 0, normPcm = 0, normRef = 0;
  for (let i = 0; i < n; i++) {
    const x = pcm[i + offset];
    const y = ref[i];
    dot += x * y;
    normPcm += x * x;
    normRef += y * y;
  }
  return dot / (Math.sqrt(normPcm) * Math.sqrt(normRef));
}

/** Finds the offset (0..maxOffset) that maximizes |correlation|. */
function bestOffset(pcm: Float64Array, ref: Float32Array, maxOffset = 1024): { offset: number; corr: number } {
  let best = { offset: 0, corr: correlate(pcm, ref, 0) };
  for (let d = 16; d <= maxOffset; d += 16) {
    const c = correlate(pcm, ref, d);
    if (Math.abs(c) > Math.abs(best.corr)) best = { offset: d, corr: c };
  }
  return best;
}

const [ac3File, refFile] = process.argv.slice(2);
if (!ac3File || !refFile) {
  console.error("usage: correlate-stereo.mts <file.ac3> <reference.f32>");
  process.exit(1);
}

const data = new Uint8Array(readFileSync(ac3File));
const [pcmL, pcmR] = decode(data);

const refInterleaved = new Float32Array(readFileSync(refFile).buffer);
const refL = new Float32Array(refInterleaved.length / 2);
const refR = new Float32Array(refInterleaved.length / 2);
for (let i = 0; i < refL.length; i++) {
  refL[i] = refInterleaved[i * 2];
  refR[i] = refInterleaved[i * 2 + 1];
}

console.log("decoded samples (L):", pcmL.length, "/ reference:", refL.length);
const bestL = bestOffset(pcmL, refL);
console.log("best offset (L):", bestL);
console.log("R correlation at the same offset:", correlate(pcmR, refR, bestL.offset));
