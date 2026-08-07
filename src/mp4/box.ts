/**
 * Writing ISO BMFF boxes (MP4 "atoms").
 *
 * A box is: 4-byte size, 4-byte ASCII type, then the content — possibly
 * more boxes. Everything is big-endian.
 */

export type Content = Uint8Array | number[];

const encoder = new TextEncoder();

/** Concatenates chunks into a single buffer. */
export function concat(...chunks: Content[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const output = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    output.set(c instanceof Uint8Array ? c : new Uint8Array(c), pos);
    pos += c.length;
  }
  return output;
}

/** Builds a box: `[size][type][content…]`. */
export function box(type: string, ...content: Content[]): Uint8Array {
  let size = 8;
  for (const c of content) size += c.length;

  const output = new Uint8Array(size);
  output[0] = (size >>> 24) & 0xff;
  output[1] = (size >>> 16) & 0xff;
  output[2] = (size >>> 8) & 0xff;
  output[3] = size & 0xff;
  output.set(encoder.encode(type), 4);

  let pos = 8;
  for (const c of content) {
    output.set(c instanceof Uint8Array ? c : new Uint8Array(c), pos);
    pos += c.length;
  }
  return output;
}

/** 32-bit unsigned integer, big-endian. */
export function u32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

export function u16(v: number): number[] {
  return [(v >>> 8) & 0xff, v & 0xff];
}

export function u8(v: number): number[] {
  return [v & 0xff];
}

/**
 * 64-bit integer.
 *
 * Written as two 32-bit halves instead of via BigInt: a 3-hour movie's
 * `tfdt` values exceed 2^32 in 90 kHz ticks, but stay far below 2^53, where
 * `Number` loses exactness.
 */
export function u64(v: number): number[] {
  const high = Math.floor(v / 0x100000000);
  const low = v % 0x100000000;
  return [...u32(high), ...u32(low >>> 0)];
}

/** Header of a "full box": 1-byte version + 3-byte flags. */
export function full(version: number, flags: number): number[] {
  return [version & 0xff, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff];
}

/** 4-character ASCII string (box types, compatibility brands). */
export function fourcc(s: string): Uint8Array {
  return encoder.encode(s.padEnd(4, " ").slice(0, 4));
}

/**
 * Length in "MPEG-4 descriptor" format: 7 usable bits per byte, the
 * high bit signaling that another byte follows. Used by AAC's `esds`.
 */
export function descriptorLength(size: number): number[] {
  const bytes: number[] = [];
  let remaining = size;
  do {
    bytes.unshift(remaining & 0x7f);
    remaining >>>= 7;
  } while (remaining > 0);
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
  return bytes;
}

/** MPEG-4 descriptor: `[tag][length][content]`. */
export function descriptor(tag: number, ...content: Content[]): Uint8Array {
  let size = 0;
  for (const c of content) size += c.length;
  return concat([tag], descriptorLength(size), ...content);
}
