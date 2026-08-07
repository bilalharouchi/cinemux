/**
 * EBML/Matroska element identifiers.
 *
 * IDs are recorded as they appear in the file, length header INCLUDED — this
 * is what the reader returns, so the comparison is direct. `0xA3` is the raw
 * value of a SimpleBlock's first byte, not a "decoded" identifier.
 *
 * Reference: matroska.org/technical/elements.html
 */
export const ID = {
  // Root level
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,

  // Level 1
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  Tracks: 0x1654ae6b,
  Cluster: 0x1f43b675,
  Cues: 0x1c53bb6b,
  Attachments: 0x1941a469,
  Chapters: 0x1043a770,
  Tags: 0x1254c367,
  Void: 0xec,
  CRC32: 0xbf,

  // Info
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,

  // SeekHead
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,

  // Tracks
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagEnabled: 0xb9,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  Name: 0x536e,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecName: 0x258688,
  DefaultDuration: 0x23e383,
  CodecDelay: 0x56aa,
  SeekPreRoll: 0x56bb,

  // Track > Video
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  DisplayWidth: 0x54b0,
  DisplayHeight: 0x54ba,

  // Track > Audio
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  OutputSamplingFrequency: 0x78b5,
  Channels: 0x9f,
  BitDepth: 0x6264,

  // Cluster
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,

  // Cues
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  CueRelativePosition: 0xf0,
} as const;

/** TrackType — Matroska values. */
export const TrackType = {
  VIDEO: 1,
  AUDIO: 2,
  COMPLEX: 3,
  LOGO: 0x10,
  SUBTITLE: 0x11,
  BUTTONS: 0x12,
  CONTROL: 0x20,
  METADATA: 0x21,
} as const;

/**
 * "Master" elements that must be descended into.
 *
 * Needed because EBML doesn't say in the byte itself whether an element is a
 * container: only the schema knows. Without this list, `Tracks`'s content
 * would be read as an opaque binary blob.
 */
export const MASTER_ELEMENTS: ReadonlySet<number> = new Set<number>([
  ID.EBML,
  ID.Segment,
  ID.SeekHead,
  ID.Seek,
  ID.Info,
  ID.Tracks,
  ID.TrackEntry,
  ID.Video,
  ID.Audio,
  ID.Cluster,
  ID.BlockGroup,
  ID.Cues,
  ID.CuePoint,
  ID.CueTrackPositions,
]);
