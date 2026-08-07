import { box, concat, full, u16, u32, u64, u8, fourcc } from "./box.js";
import type { Description } from "../codecs/index.js";

/**
 * Writing fMP4 (fragmented MP4) for MediaSource.
 *
 * An MSE stream is made of two things:
 *   - an **init segment**: `ftyp` + `moov`, describing the tracks;
 *   - **media segments**: `moof` + `mdat`, carrying the samples.
 * The `moov` must contain an `mvex`/`trex`, or the browser reads the movie
 * as a plain MP4 and waits for a sample table that doesn't exist.
 */

export type MuxTrack = {
  /** MP4 identifier (1-based, independent of the Matroska track number). */
  id: number;
  description: Description;
};

export type MuxSample = {
  /** Presentation, in the track's timescale. */
  pts: number;
  /** Decode, in the track's timescale. */
  dts: number;
  duration: number;
  keyframe: boolean;
  data: Uint8Array;
};

/** Movie timescale: 1 ms, readable and good enough for the header. */
const MOVIE_TIMESCALE = 1000;

const IDENTITY_MATRIX = [
  ...u32(0x00010000), ...u32(0), ...u32(0),
  ...u32(0), ...u32(0x00010000), ...u32(0),
  ...u32(0), ...u32(0), ...u32(0x40000000),
];

function mvhd(durationMs: number): Uint8Array {
  return box(
    "mvhd",
    full(0, 0),
    u32(0), // creation_time
    u32(0), // modification_time
    u32(MOVIE_TIMESCALE),
    u32(Math.max(0, Math.round(durationMs))),
    u32(0x00010000), // rate 1.0
    u16(0x0100), // volume 1.0
    u16(0), // reserved
    u32(0),
    u32(0), // reserved
    IDENTITY_MATRIX,
    u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), // pre_defined
    // next_track_ID: 0xffffffff means "unknown", which is true in fragmented MP4.
    u32(0xffffffff),
  );
}

function tkhd(track: MuxTrack, durationMs: number): Uint8Array {
  const isVideo = track.description.type === "video";
  // Dimensions in 16.16, read back from the sample entry (fixed offsets).
  const width = isVideo ? readU16(track.description.entry, 32) : 0;
  const height = isVideo ? readU16(track.description.entry, 34) : 0;

  return box(
    "tkhd",
    full(0, 0x000007), // enabled | in_movie | in_preview
    u32(0),
    u32(0),
    u32(track.id),
    u32(0), // reserved
    u32(Math.max(0, Math.round(durationMs))),
    u32(0),
    u32(0), // reserved
    u16(0), // layer
    u16(0), // alternate_group
    u16(isVideo ? 0 : 0x0100), // volume: 1.0 for audio, 0 for video
    u16(0), // reserved
    IDENTITY_MATRIX,
    u32(width << 16),
    u32(height << 16),
  );
}

function readU16(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 8) | buf[offset + 1];
}

function mdhd(timescale: number, durationMs: number): Uint8Array {
  return box(
    "mdhd",
    full(0, 0),
    u32(0),
    u32(0),
    u32(timescale),
    u32(Math.max(0, Math.round((durationMs / 1000) * timescale))),
    // "und" language as 5-bit-per-letter code: (u-0x60)<<10 | (n-0x60)<<5 | (d-0x60)
    u16(0x55c4),
    u16(0), // pre_defined
  );
}

function hdlr(type: "video" | "audio"): Uint8Array {
  return box(
    "hdlr",
    full(0, 0),
    u32(0), // pre_defined
    fourcc(type === "video" ? "vide" : "soun"),
    u32(0), u32(0), u32(0), // reserved
    // Human-readable name, zero-terminated.
    new TextEncoder().encode(type === "video" ? "CinemuxVideo\0" : "CinemuxAudio\0"),
  );
}

function dinf(): Uint8Array {
  // `dref` with a self-referencing `url `: the data lives in this same file.
  const url = box("url ", full(0, 0x000001));
  return box("dinf", box("dref", full(0, 0), u32(1), url));
}

function stbl(entry: Uint8Array): Uint8Array {
  return box(
    "stbl",
    box("stsd", full(0, 0), u32(1), entry),
    // Empty tables: in fragmented MP4, everything is described in the `trun`s.
    box("stts", full(0, 0), u32(0)),
    box("stsc", full(0, 0), u32(0)),
    box("stsz", full(0, 0), u32(0), u32(0)),
    box("stco", full(0, 0), u32(0)),
  );
}

function trak(track: MuxTrack, durationMs: number): Uint8Array {
  const d = track.description;
  const header = d.type === "video"
    ? box("vmhd", full(0, 1), u16(0), u16(0), u16(0), u16(0))
    : box("smhd", full(0, 0), u16(0), u16(0));

  return box(
    "trak",
    tkhd(track, durationMs),
    box(
      "mdia",
      mdhd(d.timescale, durationMs),
      hdlr(d.type),
      box("minf", header, dinf(), stbl(d.entry)),
    ),
  );
}

function mvex(tracks: MuxTrack[]): Uint8Array {
  const trexs = tracks.map((t) =>
    box(
      "trex",
      full(0, 0),
      u32(t.id),
      u32(1), // default_sample_description_index
      u32(0), // default_sample_duration
      u32(0), // default_sample_size
      u32(0), // default_sample_flags
    ),
  );
  return box("mvex", ...trexs);
}

/**
 * Init segment: `ftyp` + `moov`.
 * `iso6` in the compatibility brands: MSE implementations require it to
 * accept fragmented MP4.
 */
export function segmentInit(tracks: MuxTrack[], durationMs = 0): Uint8Array {
  const ftyp = box("ftyp", fourcc("isom"), u32(0x200), fourcc("isom"), fourcc("iso2"), fourcc("iso6"), fourcc("mp41"));
  const moov = box("moov", mvhd(durationMs), ...tracks.map((t) => trak(t, durationMs)), mvex(tracks));
  return concat(ftyp, moov);
}

// ---------------------------------------------------------------------------
// Media segments
// ---------------------------------------------------------------------------

/** `trun` flags: data-offset, then per-sample duration/size/flags/CTS-offset. */
const TRUN_FLAGS = 0x000001 | 0x000100 | 0x000200 | 0x000400 | 0x000800;

/** A non-key sample depends on other frames: flagging it avoids decoding against the grain. */
const KEY_SAMPLE_FLAGS = 0x02000000;
const NON_KEY_SAMPLE_FLAGS = 0x01010000;

export type TrackFragment = {
  track: MuxTrack;
  samples: MuxSample[];
};

/**
 * Media segment: a single `moof` followed by a single `mdat`.
 *
 * Every track in the fragment shares the `mdat`: this is what MSE
 * implementations expect, and it avoids one segment per track (so two
 * SourceBuffers to hand-sync).
 */
export function mediaSegment(sequenceNumber: number, fragments: TrackFragment[]): Uint8Array {
  const usable = fragments.filter((f) => f.samples.length > 0);
  if (usable.length === 0) return new Uint8Array(0);

  const mfhd = box("mfhd", full(0, 0), u32(sequenceNumber));

  // A `trun`'s `data_offset` is counted from the start of the `moof`. But
  // writing the `moof` requires knowing its size… which depends on the
  // `trun`s. So it's built once with 0, measured, then rebuilt.
  const build = (dataOffsets: number[]): Uint8Array => {
    const trafs = usable.map((f, i) => traf(f, dataOffsets[i]));
    return box("moof", mfhd, ...trafs);
  };

  const draft = build(usable.map(() => 0));
  const moofSize = draft.length;

  // Each track starts where the previous one ends in the `mdat`.
  const offsets: number[] = [];
  let cursor = moofSize + 8; // + mdat header
  for (const f of usable) {
    offsets.push(cursor);
    for (const s of f.samples) cursor += s.data.length;
  }

  const moof = build(offsets);
  // Safety net: if the size moved, the offsets are wrong and the picture
  // would silently corrupt. Better to fail loudly.
  if (moof.length !== moofSize) {
    throw new Error("unstable moof size — invalid data offsets");
  }

  const dataChunks: Uint8Array[] = [];
  for (const f of usable) for (const s of f.samples) dataChunks.push(s.data);
  return concat(moof, box("mdat", ...dataChunks));
}

function traf(f: TrackFragment, dataOffset: number): Uint8Array {
  const first = f.samples[0];

  const tfhd = box(
    "tfhd",
    // 0x020000 = default-base-is-moof: offsets are relative to the `moof`,
    // not the file. Required, since we don't know our absolute position.
    full(0, 0x020000),
    u32(f.track.id),
  );

  // Version 1: 64-bit baseMediaDecodeTime. A 3-hour movie at 90 kHz is 972
  // million ticks — that fits in 32 bits, but not a 6-hour concert at
  // 48 kHz cumulated. The 64-bit cost is 4 bytes per fragment; not worth
  // arguing over.
  const tfdt = box("tfdt", full(1, 0), u64(Math.max(0, first.dts)));

  const entries: number[] = [];
  for (const s of f.samples) {
    entries.push(
      ...u32(s.duration),
      ...u32(s.data.length),
      ...u32(s.keyframe ? KEY_SAMPLE_FLAGS : NON_KEY_SAMPLE_FLAGS),
      // Signed CTS offset (version 1): PTS - DTS. Zero without B-frames.
      ...u32(s.pts - s.dts),
    );
  }

  const trun = box(
    "trun",
    full(1, TRUN_FLAGS),
    u32(f.samples.length),
    u32(dataOffset),
    entries,
  );

  return box("traf", tfhd, tfdt, trun);
}

/**
 * Reconstructs DTS from PTS alone.
 *
 * WHY — Matroska stores ONLY presentation timestamps, while MP4 requires
 * decode timestamps plus an offset. With B-frames, the two differ: setting
 * DTS = PTS would display frames in decode order, a permanent stutter on
 * any modern encoding.
 *
 * The trick: within a closed group of pictures, the SET of PTS equals the
 * SET of DTS — only the order changes. Sorting the PTS and reassigning them
 * in decode order therefore yields exact, increasing DTS values.
 */
export function reconstructDts(ptsDecodeOrder: number[]): number[] {
  const sorted = [...ptsDecodeOrder].sort((a, b) => a - b);
  return sorted;
}
