import { box, concat, u16, u32, u8, descriptor, full } from "../mp4/box.js";
import { BitReader } from "./ac3/bits.js";
import type { Track } from "../matroska/demuxer.js";

/**
 * Matroska → MP4 translation: sample entry and MSE codec string.
 *
 * THIS IS WHERE EVERYTHING HAPPENS. The remux only works because MKV and MP4
 * wrap the SAME elementary streams, and because Matroska already stores the
 * decoder configuration in MP4's own format:
 *   - H.264  : CodecPrivate = AVCDecoderConfigurationRecord = `avcC` content
 *   - HEVC   : CodecPrivate = HEVCDecoderConfigurationRecord = `hvcC` content
 *   - AV1    : CodecPrivate = AV1CodecConfigurationRecord   = `av1C` content
 *   - AAC    : CodecPrivate = AudioSpecificConfig           → wrap in `esds`
 *   - Opus   : CodecPrivate = OpusHead                      → wrap in `dOps`
 * No bitstream byte is ever rewritten: it's copied, then re-wrapped.
 *
 * The codec string, on the other hand, must be EXACT: one wrong character
 * and `MediaSource.isTypeSupported` returns false, or worse, `appendBuffer`
 * throws.
 */

export type Description = {
  /** Complete sample entry box (avc1, mp4a…). */
  entry: Uint8Array;
  /** String for `isTypeSupported`, e.g. `avc1.640028`. */
  codec: string;
  /** `video/mp4` or `audio/mp4`. */
  type: "video" | "audio";
  /** The track's clock rate. */
  timescale: number;
};

export class UnsupportedCodec extends Error {
  constructor(readonly codecId: string, readonly reason: string) {
    super(`${codecId}: ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

const byteHex = (v: number) => v.toString(16).padStart(2, "0");

/** `avc1.PPCCLL` — profile, constraints, level, read from the avcC. */
function avcCodec(avcC: Uint8Array): string {
  if (avcC.length < 4) throw new UnsupportedCodec("V_MPEG4/ISO/AVC", "truncated avcC");
  return `avc1.${byteHex(avcC[1])}${byteHex(avcC[2])}${byteHex(avcC[3])}`;
}

/**
 * `hvc1.P.C.TL.CC…` — the painful part of HEVC.
 *
 * The 32 compatibility bits must be written in hex **with the bit order
 * reversed** (ISO 14496-15 §E.3). This is the classic trap: without the
 * reversal, the string looks plausible and the browser rejects the stream.
 */
function hevcCodec(hvcC: Uint8Array): string {
  if (hvcC.length < 13) throw new UnsupportedCodec("V_MPEGH/ISO/HEVC", "truncated hvcC");

  const profileSpace = (hvcC[1] >> 6) & 0x03;
  const tier = (hvcC[1] >> 5) & 0x01;
  const profile = hvcC[1] & 0x1f;

  let compat = 0;
  for (let i = 2; i <= 5; i++) compat = (compat << 8) | hvcC[i];
  let reversedCompat = 0;
  for (let i = 0; i < 32; i++) {
    reversedCompat = (reversedCompat << 1) | ((compat >>> i) & 1);
  }

  const parts = [
    "hvc1",
    (profileSpace === 0 ? "" : String.fromCharCode(64 + profileSpace)) + profile,
    (reversedCompat >>> 0).toString(16).toUpperCase(),
    (tier === 0 ? "L" : "H") + hvcC[12],
  ];

  // 6 bytes of constraints, trailing zeros stripped.
  const constraints: string[] = [];
  for (let i = 6; i <= 11; i++) constraints.push(hvcC[i].toString(16).toUpperCase().padStart(2, "0"));
  while (constraints.length > 0 && constraints[constraints.length - 1] === "00") constraints.pop();

  return [...parts, ...constraints].join(".");
}

/** `av01.P.LLT.BB` — profile, level, tier, bit depth. */
function av1Codec(av1C: Uint8Array): string {
  if (av1C.length < 3) throw new UnsupportedCodec("V_AV1", "truncated av1C");
  const profile = (av1C[1] >> 5) & 0x07;
  const level = av1C[1] & 0x1f;
  const tier = (av1C[2] >> 7) & 0x01;
  const highBitDepth = (av1C[2] >> 6) & 0x01;
  const twelveBit = (av1C[2] >> 5) & 0x01;
  const bits = twelveBit ? 12 : highBitDepth ? 10 : 8;
  return `av01.${profile}.${String(level).padStart(2, "0")}${tier ? "H" : "M"}.${String(bits).padStart(2, "0")}`;
}

/** Box shared by every video entry (`VisualSampleEntry`). */
function videoEntry(type: string, width: number, height: number, config: Uint8Array): Uint8Array {
  return box(
    type,
    u32(0), // reserved
    u16(0), // reserved
    u16(1), // data_reference_index
    u16(0), // pre_defined
    u16(0), // reserved
    u32(0),
    u32(0),
    u32(0), // pre_defined[3]
    u16(width),
    u16(height),
    u32(0x00480000), // horizresolution 72 dpi
    u32(0x00480000), // vertresolution
    u32(0), // reserved
    u16(1), // frame_count
    new Uint8Array(32), // compressorname
    u16(0x0018), // depth
    u16(0xffff), // pre_defined = -1
    config,
  );
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

/** AAC object type read from the AudioSpecificConfig (5 bits, 31 = extended). */
function aacObjectType(asc: Uint8Array): number {
  if (asc.length < 1) return 2;
  const type = asc[0] >> 3;
  if (type !== 31) return type;
  if (asc.length < 2) return 2;
  return 32 + (((asc[0] & 0x07) << 3) | (asc[1] >> 5));
}

/** `esds`: the descriptor matryoshka that wraps the AudioSpecificConfig. */
function esds(asc: Uint8Array): Uint8Array {
  const decSpecific = descriptor(0x05, asc); // DecoderSpecificInfo
  const decConfig = descriptor(
    0x04, // DecoderConfigDescriptor
    u8(0x40), // objectTypeIndication = MPEG-4 Audio
    u8(0x15), // streamType = audio (5) << 2 | upStream(0) << 1 | reserved(1)
    [0, 0, 0], // bufferSizeDB
    u32(0), // maxBitrate — 0 = unknown, accepted
    u32(0), // avgBitrate
    decSpecific,
  );
  const slConfig = descriptor(0x06, u8(0x02)); // SLConfigDescriptor: MP4 predefined
  const es = descriptor(0x03, u16(1), u8(0), decConfig, slConfig); // ES_Descriptor
  return box("esds", full(0, 0), es);
}

/** Box shared by every audio entry (`AudioSampleEntry`). */
function audioEntry(
  type: string,
  channels: number,
  frequency: number,
  bits: number,
  ...config: Uint8Array[]
): Uint8Array {
  // The sample_rate field is 16.16: past 65535 Hz it overflows. The spec then
  // requires writing 0 and relying on the track's timescale instead.
  const freq16_16 = frequency < 65536 ? Math.round(frequency) << 16 : 0;
  return box(
    type,
    u32(0),
    u16(0), // reserved
    u16(1), // data_reference_index
    u32(0),
    u32(0), // reserved
    u16(channels),
    u16(bits),
    u16(0), // pre_defined
    u16(0), // reserved
    u32(freq16_16),
    ...config,
  );
}

/**
 * `dOps` — MP4's OpusSpecificBox, which is NOT Ogg's OpusHead.
 *
 * Two differences invisible when reading both specs side by side:
 *   - the version is **0** in MP4, **1** in Ogg (ffmpeg rejects it: "unsupported
 *     OpusSpecificBox version");
 *   - Ogg's integers are **little-endian**, MP4's are **big-endian**.
 * Copying OpusHead while just stripping its signature therefore produces an
 * unreadable stream.
 *
 * Reference: opus-codec.org/docs/opus_in_isobmff.html §4.3.2
 */
function dOps(opusHead: Uint8Array, defaultChannels: number): Uint8Array {
  const hasSignature =
    opusHead.length >= 8 && String.fromCharCode(...opusHead.subarray(0, 8)) === "OpusHead";
  const t = hasSignature ? opusHead.subarray(8) : opusHead;
  if (t.length < 11) throw new UnsupportedCodec("A_OPUS", "truncated OpusHead");

  const readU16LE = (i: number) => t[i] | (t[i + 1] << 8);
  const readU32LE = (i: number) => t[i] | (t[i + 1] << 8) | (t[i + 2] << 16) | (t[i + 3] << 24);

  // t[0] = version (1 on the Ogg side), ignored: MP4 requires 0.
  const channels = t[1] || defaultChannels;
  const preSkip = readU16LE(2);
  const inputFrequency = readU32LE(4) >>> 0;
  const gain = readU16LE(8);
  const mappingFamily = t[10];

  const content: number[] = [
    0, // version
    channels,
    ...u16(preSkip),
    ...u32(inputFrequency),
    ...u16(gain),
    mappingFamily,
  ];

  // Family ≠ 0: the mapping table follows and is copied verbatim
  // (StreamCount, CoupledCount, then one byte per channel).
  if (mappingFamily !== 0 && t.length > 11) {
    for (let i = 11; i < t.length; i++) content.push(t[i]);
  }

  return box("dOps", content);
}

/** AC-3 frame header: what `dac3` must contain, and what nothing else tells you. */
export type Ac3Header = {
  frequency: number;
  channels: number;
  fscod: number;
  bsid: number;
  bsmod: number;
  acmod: number;
  lfeon: number;
  bitRateCode: number;
};

const FREQ_AC3 = [48000, 44100, 32000];
/** Channel count per acmod, excluding LFE. */
const CHANNELS_BY_ACMOD = [2, 1, 2, 3, 3, 4, 4, 5];

/**
 * Parses the first AC-3 frame of a sample.
 *
 * AC-3 has no CodecPrivate in Matroska: the frequency and channel count are
 * readable ONLY from the stream. Without that, `dac3` can't be written.
 */
export function parseAc3Header(frame: Uint8Array): Ac3Header | null {
  if (frame.length < 6) return null;
  if (frame[0] !== 0x0b || frame[1] !== 0x77) return null; // syncword

  const fscod = (frame[4] >> 6) & 0x03;
  if (fscod === 3) return null; // reserved
  const frmsizecod = frame[4] & 0x3f;
  const bsid = (frame[5] >> 3) & 0x1f;
  const bsmod = frame[5] & 0x07;

  // acmod immediately follows bsmod, 3 bits at the start of byte 6.
  if (frame.length < 7) return null;
  const acmod = (frame[6] >> 5) & 0x07;

  // lfeon's position depends on which mix fields are present, themselves a
  // function of acmod. Bits are counted rather than guessed.
  let bitsConsumed = 3; // acmod
  if ((acmod & 0x01) !== 0 && acmod !== 0x01) bitsConsumed += 2; // cmixlev
  if ((acmod & 0x04) !== 0) bitsConsumed += 2; // surmixlev
  if (acmod === 0x02) bitsConsumed += 2; // dsurmod
  const bitPosition = 6 * 8 + bitsConsumed;
  const byte = frame[bitPosition >> 3];
  const lfeon = byte === undefined ? 0 : (byte >> (7 - (bitPosition & 7))) & 1;

  return {
    frequency: FREQ_AC3[fscod],
    channels: CHANNELS_BY_ACMOD[acmod] + lfeon,
    fscod,
    bsid,
    bsmod,
    acmod,
    lfeon,
    bitRateCode: frmsizecod >> 1,
  };
}

/** `dac3` — 3 bytes of fields packed bit by bit. */
function dac3(h: Ac3Header): Uint8Array {
  // fscod(2) bsid(5) bsmod(3) acmod(3) lfeon(1) bit_rate_code(5) reserved(5)
  const bits =
    (h.fscod << 22) |
    (h.bsid << 17) |
    (h.bsmod << 14) |
    (h.acmod << 11) |
    (h.lfeon << 10) |
    (h.bitRateCode << 5);
  return box("dac3", u8((bits >> 16) & 0xff), u8((bits >> 8) & 0xff), u8(bits & 0xff));
}

/**
 * E-AC-3 header: what's needed to describe the track (channels, frequency)
 * and write `dec3` — NOT to decode it (an entirely different syntax from
 * plain AC-3, see the note in `trame.ts`). This track always ends up
 * `supported: false` (no browser reads `ec-3` in MSE): describing it only
 * exists so the diagnostic reports the REAL reason for the silence, instead
 * of leaving `this.audio` at `null` — which is what `describe()` used to do,
 * falling into the `default:` case for lack of an E-AC-3 branch.
 *
 * PROVENANCE — fields and read order checked against
 * `ff_ac3_parse_header`/`eac3_parse_header` in ffmpeg/libavcodec/ac3_parser.c
 * (the bsid > 10 branch), not guessed: unlike plain AC-3, bsid comes AFTER
 * acmod/lfeon in the E-AC-3 stream, not before.
 */
export type Eac3Header = {
  frequency: number;
  channels: number;
  fscod: number;
  bsid: number;
  bsmod: number;
  acmod: number;
  lfeon: number;
};

const BLOCKS_PER_FRAME_EAC3 = [1, 2, 3, 6] as const;

export function parseEac3Header(frame: Uint8Array): Eac3Header | null {
  if (frame.length < 8) return null;
  if (frame[0] !== 0x0b || frame[1] !== 0x77) return null; // syncword

  const r = new BitReader(frame);
  r.skip(16); // syncword already checked
  const frameType = r.read(2);
  if (frameType === 3) return null; // reserved
  const substreamId = r.read(3);
  if (substreamId !== 0) return null; // dependent substream: not the main frame
  r.skip(11); // frame_size — not needed here, frame size comes from the container

  const fscod = r.read(2);
  let frequency: number;
  if (fscod === 3) {
    const fscod2 = r.read(2);
    if (fscod2 === 3) return null; // reserved
    frequency = FREQ_AC3[fscod2] / 2;
  } else {
    r.skip(2); // numblkscod — derivable from BLOCKS_PER_FRAME_EAC3 if ever needed
    frequency = FREQ_AC3[fscod];
  }

  const acmod = r.read(3);
  const lfeon = r.read(1);
  const bsid = r.read(5); // AFTER acmod/lfeon in E-AC-3 — not before, unlike plain AC-3
  // bsmod: its exact position depends on acmod (as with plain AC-3, see
  // parseAc3Header), and it's only informational — 0 ("complete main") as a
  // fallback rather than a risky read for a field never used afterward.
  const bsmod = 0;

  return {
    frequency,
    channels: CHANNELS_BY_ACMOD[acmod] + lfeon,
    fscod,
    bsid,
    bsmod,
    acmod,
    lfeon,
  };
}

/**
 * `dec3` — a single independent substream (the common case), `num_dep_sub=0`.
 * Structure checked against `mov_write_eac3_tag` in ffmpeg/libavformat/movenc.c.
 */
function dec3(h: Eac3Header): Uint8Array {
  // data_rate(13) num_ind_sub(3) then, per independent substream (here just one):
  // fscod(2) bsid(5) reserved(1) asvc(1) bsmod(3) acmod(3) lfeon(1) reserved(3) num_dep_sub(4) reserved(1)
  const dataRate = 0; // unknown here (not in the syncinfo header) — 0 is the documented fallback
  const wordA = (dataRate << 3) | 0; // num_ind_sub = 0 (a single substream, index 0..0)
  const wordB =
    (h.fscod << 14) |
    (h.bsid << 9) |
    (0 << 8) | // reserved
    (0 << 7) | // asvc
    (h.bsmod << 4) |
    (h.acmod << 1) |
    h.lfeon;
  // wordB is 16 bits (2+5+1+1+3+3+1); what's left is reserved(3)+num_dep_sub(4)+reserved(1) = 8 bits.
  const wordC = 0; // reserved(3) num_dep_sub(4)=0 reserved(1)
  return box(
    "dec3",
    u16(wordA),
    u16(wordB),
    u8(wordC),
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Builds the MP4 description of a Matroska track.
 *
 * @param firstFrame the track's first frame — required for AC-3, whose
 *        configuration lives only in the stream.
 */
export function describe(track: Track, firstFrame?: Uint8Array): Description {
  const priv = track.codecPrivate;

  switch (track.codecId) {
    // ---- Video ----
    case "V_MPEG4/ISO/AVC": {
      if (!priv) throw new UnsupportedCodec(track.codecId, "missing avcC");
      const v = track.video!;
      return {
        entry: videoEntry("avc1", v.width, v.height, box("avcC", priv)),
        codec: avcCodec(priv),
        type: "video",
        // 90 kHz: MPEG's historical clock, divisible by 24, 25 and 30.
        timescale: 90000,
      };
    }

    case "V_MPEGH/ISO/HEVC": {
      if (!priv) throw new UnsupportedCodec(track.codecId, "missing hvcC");
      const v = track.video!;
      return {
        entry: videoEntry("hvc1", v.width, v.height, box("hvcC", priv)),
        codec: hevcCodec(priv),
        type: "video",
        timescale: 90000,
      };
    }

    case "V_AV1": {
      if (!priv) throw new UnsupportedCodec(track.codecId, "missing av1C");
      const v = track.video!;
      return {
        entry: videoEntry("av01", v.width, v.height, box("av1C", priv)),
        codec: av1Codec(priv),
        type: "video",
        timescale: 90000,
      };
    }

    // ---- Audio ----
    case "A_AAC": {
      if (!priv) throw new UnsupportedCodec(track.codecId, "missing AudioSpecificConfig");
      const a = track.audio!;
      return {
        entry: audioEntry("mp4a", a.channels, a.frequency, 16, esds(priv)),
        codec: `mp4a.40.${aacObjectType(priv)}`,
        type: "audio",
        // The audio clock IS the sampling frequency: no rounding possible.
        timescale: Math.round(a.frequency),
      };
    }

    case "A_OPUS": {
      if (!priv) throw new UnsupportedCodec(track.codecId, "missing OpusHead");
      const a = track.audio!;
      return {
        entry: audioEntry("Opus", a.channels, 48000, 16, dOps(priv, a.channels)),
        codec: "opus",
        type: "audio",
        // Opus always works at 48 kHz, regardless of the original frequency.
        timescale: 48000,
      };
    }

    case "A_FLAC": {
      if (!priv) throw new UnsupportedCodec(track.codecId, "missing FLAC metadata");
      const a = track.audio!;
      // `dfLa` = version/flags followed by the raw FLAC metadata blocks.
      return {
        entry: audioEntry("fLaC", a.channels, a.frequency, a.bits ?? 16, box("dfLa", full(0, 0), priv)),
        codec: "flac",
        type: "audio",
        timescale: Math.round(a.frequency),
      };
    }

    case "A_MPEG/L3": {
      const a = track.audio!;
      // MP3 inside MP4: objectTypeIndication 0x6B, with no DecoderSpecificInfo.
      return {
        entry: audioEntry("mp4a", a.channels, a.frequency, 16, esds(new Uint8Array(0))),
        codec: "mp4a.40.34",
        type: "audio",
        timescale: Math.round(a.frequency),
      };
    }

    case "A_AC3": {
      const h = firstFrame ? parseAc3Header(firstFrame) : null;
      if (!h) throw new UnsupportedCodec(track.codecId, "unreadable AC-3 header");
      return {
        entry: audioEntry("ac-3", h.channels, h.frequency, 16, dac3(h)),
        codec: "ac-3",
        type: "audio",
        timescale: h.frequency,
      };
    }

    case "A_EAC3": {
      // `supported` will be FALSE no matter what (no browser reads `ec-3`
      // in MSE, and there's no E-AC-3 decoder here): describing this track
      // only exists so `diag.audio` carries the REAL reason for the silence
      // instead of staying `null` — see `Ac3AudioPlayer` in player.ts, which
      // clearly warns in the console when this case comes up.
      const h = firstFrame ? parseEac3Header(firstFrame) : null;
      if (!h) throw new UnsupportedCodec(track.codecId, "unreadable E-AC-3 header");
      return {
        entry: audioEntry("ec-3", h.channels, h.frequency, 16, dec3(h)),
        codec: "ec-3",
        type: "audio",
        timescale: h.frequency,
      };
    }

    default:
      throw new UnsupportedCodec(
        track.codecId,
        "no MP4 equivalent — remux impossible without transcoding",
      );
  }
}

/** Does the browser support this complete MIME type? */
export function browserSupports(mime: string): boolean {
  if (typeof MediaSource === "undefined") return false;
  return MediaSource.isTypeSupported(mime);
}

/** MSE MIME type for one or two descriptions. */
export function mimeFor(...descriptions: Description[]): string {
  const container = descriptions.some((d) => d.type === "video") ? "video/mp4" : "audio/mp4";
  return `${container}; codecs="${descriptions.map((d) => d.codec).join(",")}"`;
}
