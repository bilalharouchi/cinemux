/**
 * Big-endian bit reader.
 *
 * AC-3 is a format with unaligned fields: `fscod` is 2 bits, `frmsizecod`
 * 6, `dialnorm` 5… Reading it byte by byte is impossible. And since the
 * number of bits in each mantissa depends on the allocation computed just
 * before it, the position must be exact to the bit: an error of a single
 * bit shifts everything else in the frame.
 */
export class BitReader {
  private byte = 0;
  private bit = 0;

  constructor(private readonly data: Uint8Array) {}

  /** Current position, in bits from the start. */
  get position(): number {
    return this.byte * 8 + this.bit;
  }

  set position(p: number) {
    this.byte = p >> 3;
    this.bit = p & 7;
  }

  get bitsRemaining(): number {
    return this.data.length * 8 - this.position;
  }

  /** Reads `n` bits (0 ≤ n ≤ 32) without consuming past the buffer. */
  read(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const o = this.data[this.byte];
      // Past the buffer we return zeros: a truncated stream must not throw,
      // the decoder will notice by checking the frame size.
      const b = o === undefined ? 0 : (o >> (7 - this.bit)) & 1;
      value = value * 2 + b;
      if (++this.bit === 8) {
        this.bit = 0;
        this.byte++;
      }
    }
    return value;
  }

  /** Reads 1 bit as a boolean — the most frequent form in AC-3. */
  flag(): boolean {
    return this.read(1) === 1;
  }

  /** Reads `n` bits as two's complement (bap 6-15 mantissas, ungrouped). */
  readSigned(n: number): number {
    const raw = this.read(n);
    const sign = 1 << (n - 1);
    return raw & sign ? raw - (sign << 1) : raw;
  }

  skip(n: number): void {
    this.position = this.position + n;
  }
}
