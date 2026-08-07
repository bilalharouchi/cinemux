import { EbmlReader } from "../ebml/reader.js";

/**
 * Decoding a Matroska SimpleBlock / Block.
 *
 * A block can contain MULTIPLE frames via "lacing" — three different
 * encodings, all used in practice (Xiph by older muxers, EBML by mkvmerge,
 * fixed by constant-bitrate audio). Ignoring lacing produces a choppy audio
 * track that "mostly works": the worst kind of bug.
 */

export type DecodedBlock = {
  trackNumber: number;
  /** Offset in Track Ticks relative to the Cluster's timestamp. Can be negative. */
  relativeTimestamp: number;
  keyframe: boolean;
  invisible: boolean;
  /** One entry per frame — lacing can produce several. */
  frames: Uint8Array[];
};

const LACING_NONE = 0;
const LACING_XIPH = 1;
const LACING_FIXED = 2;
const LACING_EBML = 3;

/**
 * @param data content of the SimpleBlock/Block, without its element header
 * @param simple `true` for a SimpleBlock (flags carry the keyframe bit),
 *               `false` for a Block inside a BlockGroup (keyframe inferred elsewhere)
 */
export function decodeBlock(data: Uint8Array, simple: boolean): DecodedBlock | null {
  const r = new EbmlReader(data);

  const trackNumber = r.readSize(); // the track number is a vint
  if (trackNumber === null) return null;
  if (r.remaining < 3) return null;

  const relativeTimestamp = r.readInt(2);
  const flags = r.data[r.pos++];

  const keyframe = simple ? (flags & 0x80) !== 0 : false;
  const invisible = (flags & 0x08) !== 0;
  const lacing = (flags >> 1) & 0x03;

  if (lacing === LACING_NONE) {
    return {
      trackNumber,
      relativeTimestamp,
      keyframe,
      invisible,
      frames: [r.readBytes(r.remaining)],
    };
  }

  if (r.remaining < 1) return null;
  // "frame count - 1": a laced block always contains at least two.
  const frameCount = r.data[r.pos++] + 1;
  const sizes: number[] = [];

  if (lacing === LACING_XIPH) {
    // Xiph: each size is a run of 255-valued bytes terminated by < 255.
    for (let i = 0; i < frameCount - 1; i++) {
      let size = 0;
      let byte = 255;
      while (byte === 255) {
        if (r.remaining < 1) return null;
        byte = r.data[r.pos++];
        size += byte;
      }
      sizes.push(size);
    }
  } else if (lacing === LACING_EBML) {
    // EBML: first size as an absolute vint, following ones as a SIGNED delta.
    const first = r.readSize();
    if (first === null) return null;
    sizes.push(first);
    for (let i = 1; i < frameCount - 1; i++) {
      const delta = r.readSignedVint();
      if (delta === null) return null;
      sizes.push(sizes[i - 1] + delta);
    }
  } else {
    // Fixed: every frame is the same size, none of them stored.
    const size = Math.floor(r.remaining / frameCount);
    for (let i = 0; i < frameCount - 1; i++) sizes.push(size);
  }

  const frames: Uint8Array[] = [];
  for (const size of sizes) {
    if (size < 0 || size > r.remaining) return null; // corrupt file
    frames.push(r.readBytes(size));
  }
  // The last frame takes everything that's left: its size is never stored.
  frames.push(r.readBytes(r.remaining));

  return { trackNumber, relativeTimestamp, keyframe, invisible, frames };
}
