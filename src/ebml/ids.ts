/**
 * Identifiants d'éléments EBML/Matroska.
 *
 * Les IDs sont notés tels qu'ils apparaissent dans le fichier, en-tête de
 * longueur INCLUS — c'est ce que renvoie le lecteur, donc la comparaison est
 * directe. `0xA3` est bien la valeur brute du premier octet d'un SimpleBlock,
 * pas un identifiant « décodé ».
 *
 * Référence : matroska.org/technical/elements.html
 */
export const ID = {
  // Niveau racine
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,

  // Niveau 1
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

/** TrackType — valeurs Matroska. */
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
 * Éléments « maîtres » dans lesquels il faut descendre.
 *
 * Nécessaire parce qu'EBML ne dit pas dans l'octet lui-même si un élément est un
 * conteneur : c'est le schéma qui le sait. Sans cette liste, on lirait le contenu
 * de `Tracks` comme un bloc binaire opaque.
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
