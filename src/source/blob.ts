import type { Source } from "./index.js";

/**
 * Local source (`File` from an `<input type=file>`, or `Blob`).
 *
 * Used for development and the "drag your MKV onto the page" case: no
 * server, and seeking is instant since everything is already on disk.
 */
export class BlobSource implements Source {
  constructor(
    private readonly blob: Blob,
    /** Size of the chunks read. 1 MB: big enough not to be choppy, small
     *  enough not to block the main thread on a large `arrayBuffer`. */
    private readonly chunkSize = 1024 * 1024,
  ) {}

  async size(): Promise<number> {
    return this.blob.size;
  }

  async supportsRanges(): Promise<boolean> {
    return true; // a Blob can be sliced freely
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    // `end` is inclusive on the HTTP side: matching that here keeps both
    // sources usable in exactly the same way.
    const chunk = this.blob.slice(start, Math.min(end + 1, this.blob.size));
    return new Uint8Array(await chunk.arrayBuffer());
  }

  async *stream(start: number, signal?: AbortSignal): AsyncIterableIterator<Uint8Array> {
    let pos = start;
    while (pos < this.blob.size) {
      if (signal?.aborted) return;
      const end = Math.min(pos + this.chunkSize, this.blob.size);
      const chunk = this.blob.slice(pos, end);
      yield new Uint8Array(await chunk.arrayBuffer());
      pos = end;
    }
  }
}
