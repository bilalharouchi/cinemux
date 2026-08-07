import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MatroskaDemuxer } from "../src/matroska/demuxer.js";
import { TrackType } from "../src/ebml/ids.js";
import { decodeFrame, readHeader, frameSizeWords } from "../src/codecs/ac3/trame.js";
import { BitReader } from "../src/codecs/ac3/bits.js";
import { MANTISSA_BITS } from "../src/codecs/ac3/bitalloc.js";

/**
 * Regression: `frameSizeWords` at 44.1 kHz gave 6-7 words (12-14 bytes)
 * where the real frame is ~836 — a derived formula that wasn't the right
 * conversion (division by 2 instead of ×1000/16). The whole frame would
 * desync at the very next syncword.
 *
 * Verified against the REAL fixture `h264-ac3.mkv` (a real ffmpeg muxer, not
 * fabricated bytes) rather than a standalone .ac3 file: that's exactly what
 * the remuxer receives in practice.
 */
function ac3Track(): Uint8Array {
  const data = new Uint8Array(readFileSync(new URL("./fixtures/h264-ac3.mkv", import.meta.url)));
  const samples: { track: number; data: Uint8Array }[] = [];
  let audioNumber = -1;
  const d = new MatroskaDemuxer({
    onTracks: (tracks) => {
      audioNumber = tracks.find((t) => t.type === TrackType.AUDIO)!.number;
    },
    onSample: (e) => samples.push(e),
  });
  d.feed(data);

  const chunks = samples.filter((e) => e.track === audioNumber).map((e) => e.data);
  const total = chunks.reduce((n, m) => n + m.length, 0);
  const stream = new Uint8Array(total);
  let off = 0;
  for (const m of chunks) {
    stream.set(m, off);
    off += m.length;
  }
  return stream;
}

describe("AC-3 frame size at 44.1 kHz", () => {
  it("lands exactly on the next syncword, across the whole real stream", () => {
    const stream = ac3Track();
    const header = readHeader(new BitReader(stream));
    expect(header?.frequency).toBe(44100);

    let offset = 0;
    let frames = 0;
    while (offset + 6 < stream.length) {
      if (!(stream[offset] === 0x0b && stream[offset + 1] === 0x77)) {
        // A Matroska sample can carry several AC-3 frames or the tail of
        // the previous one: skip forward to the next syncword.
        offset++;
        continue;
      }
      const h = readHeader(new BitReader(stream.subarray(offset)));
      if (!h) {
        offset++;
        continue;
      }
      frames++;
      const next = offset + h.sizeBytes;
      // The next syncword must be EXACTLY at `sizeBytes` — not "somewhere
      // after": it's the size that drives the rest of decoding.
      if (next + 1 < stream.length) {
        expect(
          [stream[next], stream[next + 1]],
          `frame #${frames} @ offset ${offset} (${h.sizeBytes} bytes announced)`,
        ).toEqual([0x0b, 0x77]);
      }
      offset = next;
    }
    expect(frames).toBeGreaterThan(50); // the test file is 3s at 44.1 kHz
  });

  it("alternates between two neighboring sizes (44.1 kHz padding word)", () => {
    // 192 kb/s @ 44.1 kHz: 417 or 418 WORDS (834/836 bytes, measured by
    // generating all 19 bitrates with ffmpeg) depending on frmsizecod
    // parity — never 6-7 words like before the fix (a derived formula
    // wrong by a factor of ~70).
    expect(frameSizeWords(1, 20)).toBe(417); // frmsizecod even
    expect(frameSizeWords(1, 21)).toBe(418); // frmsizecod odd
  });

  it("stays exact at 48 and 32 kHz (integer division, no table)", () => {
    expect(frameSizeWords(0, 20)).toBe(2 * 192); // 48 kHz: words
    expect(frameSizeWords(2, 20)).toBe(3 * 192); // 32 kHz
  });
});

describe("mantissa reading (bap → bits)", () => {
  it("bap=3 and bap=5 read a DIRECT mantissa, not a zero-bit group", () => {
    // Regression: these two bap values were 0 in MANTISSA_BITS — treated
    // as grouped (like bap 1/2/4) when they aren't. Verified against
    // `ac3_decode_transform_coeffs_ch` in ffmpeg/libavcodec/ac3dec.c:
    // `case 3: get_bits(gbc, 3)`, `case 5: get_bits(gbc, 4)`. Bug result:
    // 0 bits skipped on every occurrence → the rest of the frame drifts.
    expect(MANTISSA_BITS[3]).toBe(3);
    expect(MANTISSA_BITS[5]).toBe(4);
  });

  it("bap 6 to 15 follow Table 7.18 (ff_ac3_quantization_tab)", () => {
    expect(Array.from(MANTISSA_BITS.slice(6))).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 14, 16]);
  });

  it("decodes an ENTIRE frame of a real stream without drifting — bap included", () => {
    // The test closest to reality: not just frame size (test above), but
    // the WHOLE content of a block — exponents, allocation, AND mantissa
    // consumption. Before the bap=3/5 fix, only 1 frame in 87 landed
    // exactly on a real mono 192 kb/s stream; after, the margin at the end
    // of the frame (CRC2 plus optional padding) is always small and never
    // negative (never a read past the end).
    const stream = ac3Track();
    let offset = 0;
    let decoded = 0;
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
      const frame = stream.subarray(offset, offset + header.sizeBytes);
      const res = decodeFrame(frame);
      decoded++;
      expect(res, `frame #${decoded} @ offset ${offset}`).not.toBeNull();
      const remaining = header.sizeBytes * 8 - res!.bitsConsumed;
      // Never negative (a read past the end of the frame): that's the
      // direct symptom of a deficit of skipped bits somewhere earlier.
      expect(remaining, `frame #${decoded} @ offset ${offset}`).toBeGreaterThanOrEqual(0);
      offset += header.sizeBytes;
    }
    expect(decoded).toBeGreaterThan(50);
  });
});
