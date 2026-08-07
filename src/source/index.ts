/**
 * Byte source.
 *
 * Abstracted for two reasons: reading a local file during development
 * without a server, and above all being able to jump within the file
 * (`read(start, end)`) instead of downloading it whole — this is what makes
 * seeking possible on a 3 GB movie.
 */
export interface Source {
  /** Total size in bytes, or null if the server doesn't provide it. */
  size(): Promise<number | null>;

  /** Does the server accept partial requests? Without this, no seeking. */
  supportsRanges(): Promise<boolean>;

  /**
   * Byte stream starting at `start`.
   * The iterator must stop cleanly if abandoned (`return`).
   */
  stream(start: number, signal?: AbortSignal): AsyncIterableIterator<Uint8Array>;

  /** Reads a precise range — used to fetch the Cues index. */
  read(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
}

export { HttpSource } from "./http.js";
export { BlobSource } from "./blob.js";
