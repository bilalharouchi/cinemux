import { readFileSync } from "node:fs";
import { decodeFrame, readHeader, SYNCWORD } from "../src/codecs/ac3/trame.js";
import { BitReader } from "../src/codecs/ac3/bits.js";

const file = process.argv[2];
const data = new Uint8Array(readFileSync(file));

let offset = 0, frames = 0, aligned = 0;
const gaps: number[] = [];

while (offset + 6 < data.length) {
  if (!(data[offset] === 0x0b && data[offset + 1] === 0x77)) { offset++; continue; }
  const header = readHeader(new BitReader(data.subarray(offset)));
  if (!header || header.sizeBytes === 0) { offset++; continue; }
  const frame = data.subarray(offset, offset + header.sizeBytes);
  if (frame.length < header.sizeBytes) break;

  const res = decodeFrame(frame);
  frames++;
  if (res) {
    // The read must land BACK INSIDE the frame, as close to its end as
    // possible: what's left is crc2 (16 bits) and possible padding.
    const frameBits = header.sizeBytes * 8;
    const remaining = frameBits - res.bitsConsumed;
    gaps.push(remaining);
    if (remaining >= 0 && remaining < 200) aligned++;
  }
  offset += header.sizeBytes;
}

const e0 = readHeader(new BitReader(data));
console.log(`file      : ${file}`);
console.log(`header    : ${e0?.frequency} Hz, acmod=${e0?.acmod} (${e0?.channels} channels), lfe=${e0?.lfeon}, ${e0?.sizeBytes} B/frame`);
console.log(`frames    : ${frames}`);
console.log(`aligned   : ${aligned}/${frames}  (${frames ? Math.round(100*aligned/frames) : 0} %)`);
if (gaps.length) {
  const sorted = [...gaps].sort((a, b) => a - b);
  console.log(`bits remaining at end of frame — min ${sorted[0]}, median ${sorted[sorted.length>>1]}, max ${sorted[sorted.length-1]}`);
  const negative = gaps.filter((x) => x < 0).length;
  console.log(`overruns (read past the frame) : ${negative}`);
}
