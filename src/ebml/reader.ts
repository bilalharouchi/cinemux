/**
 * Reading EBML primitives.
 *
 * EBML encodes lengths as a "vint": the number of leading zero bits in the
 * first byte gives the total byte count, with the first 1 bit acting as a
 * marker. Two distinct rules, often confused:
 *   - for an **ID**, the marker is kept (the ID includes its header);
 *   - for a **size**, it is stripped (it's a plain number).
 *
 * Every read can run out of data: they return `null` instead of throwing,
 * because the demuxer works on an incomplete stream and must be able to wait
 * for more.
 */

/** Unknown size (all data bits set to 1) — used by live Segments and Clusters. */
export const UNKNOWN_SIZE = -1;

export class EbmlReader {
  /** Read position, in bytes from the start of `data`. */
  pos = 0;

  constructor(
    public data: Uint8Array,
    /** Offset of `data[0]` within the full file — used for absolute positions (Cues). */
    readonly baseOffset = 0,
  ) {}

  get remaining(): number {
    return this.data.length - this.pos;
  }

  /** Absolute position within the file. */
  get absolutePosition(): number {
    return this.baseOffset + this.pos;
  }

  /** Number of bytes in a vint given its first byte. 0 = invalid byte. */
  private static vintLength(first: number): number {
    if (first === 0) return 0; // 8+ bytes: outside practical spec range
    return 8 - Math.floor(Math.log2(first));
  }

  /**
   * Reads an element ID — marker kept.
   * `null` if bytes are missing (will be retried once more data arrives).
   */
  readId(): number | null {
    if (this.remaining < 1) return null;
    const first = this.data[this.pos];
    const length = EbmlReader.vintLength(first);
    if (length === 0 || length > 4) return null; // EBMLMaxIDLength = 4
    if (this.remaining < length) return null;

    let value = 0;
    for (let i = 0; i < length; i++) value = value * 256 + this.data[this.pos + i];
    this.pos += length;
    return value;
  }

  /**
   * Reads an element size — marker stripped.
   * Returns [UNKNOWN_SIZE] when every data bit is set to 1.
   */
  readSize(): number | null {
    if (this.remaining < 1) return null;
    const first = this.data[this.pos];
    const length = EbmlReader.vintLength(first);
    if (length === 0 || length > 8) return null;
    if (this.remaining < length) return null;

    // Strip the marker bit from the first byte.
    let value = first & ((1 << (8 - length)) - 1);
    let allOnes = value === (1 << (8 - length)) - 1;

    for (let i = 1; i < length; i++) {
      const byte = this.data[this.pos + i];
      // Number stays exact up to 2^53: enough for file sizes.
      value = value * 256 + byte;
      if (byte !== 0xff) allOnes = false;
    }
    this.pos += length;
    return allOnes ? UNKNOWN_SIZE : value;
  }

  /** Big-endian unsigned integer over `n` bytes. */
  readUint(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) value = value * 256 + this.data[this.pos + i];
    this.pos += n;
    return value;
  }

  /** Big-endian signed integer (two's complement) over `n` bytes. */
  readInt(n: number): number {
    if (n === 0) return 0;
    let value = this.data[this.pos];
    if (value & 0x80) value -= 0x100; // sign carried by the first byte
    for (let i = 1; i < n; i++) value = value * 256 + this.data[this.pos + i];
    this.pos += n;
    return value;
  }

  /** EBML float: 4 or 8 bytes. Any other size is 0 (spec: 0-byte float = 0). */
  readFloat(n: number): number {
    const view = new DataView(this.data.buffer, this.data.byteOffset + this.pos, n);
    this.pos += n;
    if (n === 4) return view.getFloat32(0, false);
    if (n === 8) return view.getFloat64(0, false);
    return 0;
  }

  readString(n: number): string {
    const bytes = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    // Matroska strings may be zero-padded.
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return new TextDecoder().decode(bytes.subarray(0, end));
  }

  readBytes(n: number): Uint8Array {
    // `slice`, not `subarray`: the data survives the stream buffer being recycled.
    const bytes = this.data.slice(this.pos, this.pos + n);
    this.pos += n;
    return bytes;
  }

  /** "Signed" vint of an EBML lacing: offset by half its range. */
  readSignedVint(): number | null {
    const before = this.pos;
    const raw = this.readSize();
    if (raw === null) return null;
    const length = this.pos - before;
    // Spec offset: 2^(7n-1) - 1
    return raw - (Math.pow(2, 7 * length - 1) - 1);
  }
}

/** Writes an EBML-sized vint — used by tests to build fixture files. */
export function writeSize(value: number, forcedLength?: number): Uint8Array {
  let length = forcedLength ?? 1;
  if (!forcedLength) {
    while (value >= Math.pow(2, 7 * length) - 1) length++;
  }
  const output = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i--) {
    output[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  output[0] |= 1 << (8 - length); // marker
  return output;
}
