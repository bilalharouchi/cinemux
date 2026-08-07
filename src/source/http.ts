import type { Source } from "./index.js";

/**
 * HTTP source with partial requests (`Range`).
 *
 * Seeking depends on it entirely: without `Accept-Ranges: bytes` on the
 * server side, the file can only be read from the start, and jumping to
 * 1h30 into a movie would mean downloading 1h30 of video. The class checks
 * for it and says so plainly.
 */
export class HttpSource implements Source {
  private knownSize: number | null | undefined;
  private rangesOk: boolean | undefined;

  constructor(
    readonly url: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  /**
   * Probes the source. A HEAD is tried first, falling back to a 1-byte GET:
   * many servers (and CDN signed URLs) refuse HEAD while handling Range
   * requests perfectly well.
   */
  private async probe(): Promise<void> {
    if (this.knownSize !== undefined) return;

    const readHeaders = (res: Response) => {
      const length = res.headers.get("content-length");
      const range = res.headers.get("content-range");
      this.rangesOk =
        res.status === 206 || (res.headers.get("accept-ranges") ?? "").includes("bytes");
      if (range) {
        // Content-Range: bytes 0-0/123456 → the size is after the slash.
        const total = range.split("/")[1];
        this.knownSize = total && total !== "*" ? Number(total) : null;
      } else {
        this.knownSize = length ? Number(length) : null;
      }
    };

    try {
      const head = await fetch(this.url, { method: "HEAD", headers: this.headers });
      if (head.ok) {
        readHeaders(head);
        if (this.knownSize) return;
      }
    } catch {
      // HEAD refused: fall back to a partial GET.
    }

    const res = await fetch(this.url, {
      headers: { ...this.headers, Range: "bytes=0-0" },
    });
    readHeaders(res);
    // The 1-byte body must be consumed, or the connection stays open.
    await res.arrayBuffer().catch(() => undefined);
  }

  async size(): Promise<number | null> {
    await this.probe();
    return this.knownSize ?? null;
  }

  async supportsRanges(): Promise<boolean> {
    await this.probe();
    return this.rangesOk ?? false;
  }

  async read(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await fetch(this.url, {
      headers: { ...this.headers, Range: `bytes=${start}-${end}` },
      signal,
    });
    if (!res.ok) throw new Error(`range ${start}-${end} refused: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async *stream(start: number, signal?: AbortSignal): AsyncIterableIterator<Uint8Array> {
    const headers = { ...this.headers };
    // `bytes=N-`: from N to the end. Omitted when starting from zero, to
    // avoid requiring range support unnecessarily.
    if (start > 0) headers.Range = `bytes=${start}-`;

    const res = await fetch(this.url, { headers, signal });
    if (!res.ok) throw new Error(`read refused: HTTP ${res.status}`);
    if (!res.body) throw new Error("response has no body");

    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) yield value;
      }
    } finally {
      // Abandoning the iterator (seek, close) must cut off the download,
      // otherwise bandwidth keeps being consumed for nothing.
      await reader.cancel().catch(() => undefined);
    }
  }
}
