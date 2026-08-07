# cinemux

**Play `.mkv` files in a browser.** No WASM, no transcoding, no worker for
video, no `SharedArrayBuffer`, no COOP/COEP headers.

![MIT license](https://img.shields.io/badge/license-MIT-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![tests](https://img.shields.io/badge/tests-46%20passing-brightgreen)

## The idea

Chromium and Firefox already decode H.264, HEVC, AV1, AAC, Opus, and FLAC —
the codecs inside almost every `.mkv` in the wild. `<video src="movie.mkv">`
fails anyway, not because the browser can't decode the bitstream, but
because it doesn't recognize the **container** it's wrapped in.

An MKV and an MP4 most often carry the exact same elementary streams. Better
still, Matroska already stores the decoder configuration in a form that maps
almost directly onto MP4's own boxes:

| Codec | What `CodecPrivate` holds | MP4 box |
| --- | --- | --- |
| H.264 | `AVCDecoderConfigurationRecord` | `avcC` — direct copy |
| HEVC | `HEVCDecoderConfigurationRecord` | `hvcC` — direct copy |
| AV1 | `AV1CodecConfigurationRecord` | `av1C` — direct copy |
| AAC | `AudioSpecificConfig` | `esds` — needs wrapping |
| Opus | `OpusHead` (Ogg) | `dOps` — needs converting |
| FLAC | FLAC metadata | `dfLa` — needs wrapping |

cinemux demuxes the Matroska stream and repackages the same samples as
fragmented MP4, handed straight to `MediaSource`. No bitstream byte is ever
re-encoded — this is repackaging, not transcoding. Because it goes through a
real `<video>` element, native controls, fullscreen, picture-in-picture,
casting, and keyboard shortcuts all come for free.

## Why this instead of a WASM decoder

`ffmpeg.wasm` solves the same problem by brute force: ship a full codec
suite and transcode. That works, but it's a different cost profile.

| | cinemux | `ffmpeg.wasm` |
| --- | --- | --- |
| Technique | container remux, no re-encode | full software transcode |
| Payload | ~50 KB gzipped, 0 runtime deps | ~25 MB |
| CPU per frame | one `memcpy` + box header | full decode + encode |
| `SharedArrayBuffer` / COOP-COEP | not required | required (breaks unrelated pages sharing the origin) |
| Ceiling | limited to codecs the browser already supports | can in principle handle anything |

The trade-off is real, not a marketing simplification: cinemux can't play a
codec the browser itself can't decode (see [AC-3](#ac-3-a-decoder-written-from-the-spec)
below). It trades that ceiling for a footprint two to three orders of
magnitude smaller, and a CPU cost close to zero — the difference between
"transcode this on every page load" and "read the box headers and copy
bytes."

## What works

**Video** — H.264 (Baseline → High, B-frames included), HEVC, AV1.
**Audio** — AAC, Opus, FLAC, MP3, and AC-3 wherever the browser decodes it
(Safari).

**Seeking without downloading the whole movie.** A MKV's `Cues` index lives
at the end of the file, but the `SeekHead` at the start says where to find
it: two `Range` requests are enough to fetch the index of a 3 GB movie.
Seeking then does a binary search through the Cues and resumes at the right
Cluster.

**Audio track selection.** On a multi-language file, cinemux first prefers
whatever the browser can decode, then the requested language, then the
best-handled codec. A French AC-3 track is useless if nothing plays it.

**Progressive playback.** The remuxer works as a stream: the first frame
shows up after a few hundred KB. Downloading pauses as soon as the buffer
has enough of a lead, and memory is freed behind the playhead.

## Two traps that cost hours

These are the kind of bugs that only show up once you've actually shipped a
media pipeline — noted here because the second-order effects are non-obvious
even if you know the spec.

**PTS ≠ DTS.** Matroska only stores presentation timestamps. MP4 requires a
decode timestamp plus a composition offset. With B-frames the two differ:
setting `DTS = PTS` displays frames in decode order — a permanent stutter on
any modern encoding. The reconstruction relies on a simple property: within
a closed group of pictures, the *set* of PTS equals the *set* of DTS, only
the order changes. Sorting the PTS and reassigning them in decode order
yields exact, increasing DTS values.

Consequence: the first DTS comes before the first PTS, and `tfdt` is
unsigned. The only way out is to advance the entire presentation by the
reordering delay — **and to apply it to audio too**. Applying it only to
video shifts the sound by 80 ms, an audible lip-sync bug.

**Ogg's `OpusHead` is not MP4's `OpusSpecificBox`.** The version byte is 1
on one side and 0 on the other, and the integers are little-endian in Ogg,
big-endian in MP4. Copying one into the other while just stripping the
signature produces an `unsupported OpusSpecificBox version`.

## AC-3: a decoder written from the spec

Chromium dropped proprietary audio decoders; no mainstream browser decodes
AC-3 or E-AC-3 natively outside Safari. Rather than pull in a WASM port of
`liba52`, `src/codecs/ac3/` implements the ATSC A/52 bitstream decoder from
the normative tables up: header parsing, exponent decoding, bit allocation,
mantissa dequantization, and the IMDCT, producing PCM that plays through Web
Audio in lockstep with the muted `<video>` element's clock.

This is the newest and least stable part of the repo — treat it as a
work in progress. Two known, accepted limitations, not bugs: the LFE
channel isn't decoded, and channel order follows bitstream order rather
than the WAV/Web Audio 5.1 convention. Where a browser can't decode AC-3 at
all, cinemux still writes a correct `dac3` box from the bitstream and
reports it in `diagnostic.audio.supported` — it detects and describes the
track rather than pretending it's playable.

## Usage

```ts
import { Cinemux, HttpSource } from "cinemux";

const player = await Cinemux.attach(
  document.querySelector("video")!,
  new HttpSource("/movie.mkv"),
  { preferredLanguage: "fr" },
);

console.log(player.diagnostic);
// { mime: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
//   video: { … supported: true }, audio: { … }, discarded: [], durationMs: 7_320_000 }
```

Local file, no server:

```ts
import { Cinemux, BlobSource } from "cinemux";
await Cinemux.attach(video, new BlobSource(input.files[0]));
```

Knowing before opening anything:

```ts
import { browserCompatible, availableCodecs } from "cinemux";
browserCompatible();  // false without MediaSource (Safari on iPhone)
availableCodecs();    // { h264: true, hevc: false, aac: true, ac3: false, … }
```

## What doesn't work, and why

**E-AC-3, DTS, TrueHD** aren't decoded by any mainstream browser and aren't
implemented here yet. cinemux detects them, describes them correctly, and
reports `diagnostic.audio.supported: false` — it's up to the application to
offer another source or another track from the same file.

Lifting this would mean a decoder producing PCM, then re-encoding to Opus
via `AudioEncoder` (WebCodecs) — doable, but that's transcoding, with the
weight and CPU cost that implies. Out of scope for now; the interface is
ready to accommodate it.

**VP8/VP9** aren't remuxed: an MKV with VP9/Opus is already almost WebM,
which browsers play natively. Serve it as `video/webm`.

**Safari on iPhone** doesn't have `MediaSource` (outside "Managed Media
Source"). `browserCompatible()` returns `false` — better to know that ahead
of time.

**Embedded subtitles** (ASS/SSA, PGS) aren't extracted. The MKV's subtitle
tracks are ignored.

## Architecture

```text
src/
  ebml/        EBML primitive reader (vint, integers, floats) + Matroska IDs
  matroska/    streaming demuxer + block decoding (the 3 lacing types)
  codecs/      Matroska CodecID → MP4 sample entry + MSE codec string
  codecs/ac3/  in-house AC-3 decoder (bitstream → PCM)
  mp4/         ISO BMFF box writing, init segments and fragments
  source/      byte sources: HTTP (Range) and Blob
  remuxer.ts   ties it together: track selection, fragment chunking
  player.ts    MediaSource, backpressure, seek via Cues, memory quota
  audio-ac3.ts separate AC-3 playback via Web Audio, locked to <video>'s clock
```

## Tests: ground truth comes from external tools, not our own assumptions

```bash
npm test
```

46 tests across 7 files. MKV fixtures are produced by real `ffmpeg` calls
(commands documented in `test/fixtures/README.md`), never hand-built byte by
byte. Assertions compare our output against **ffprobe and ffmpeg**, not
values we hardcoded ourselves: packet count matching the source, error-free
decoding throughout, strictly increasing presentation order, tracks aligned
within less than 5 ms. For the AC-3 decoder, the reference is PCM extracted
via `ffmpeg -acodec pcm_f32le`, compared sample by sample — correlation, not
exact equality, since two floating-point implementations diverge slightly.

A parser that only passes on its own fixtures proves nothing.

## Demo

```bash
npm run build
npx http-server -p 8899 .
# then http://localhost:8899/demo/index.html
```

Drop an `.mkv` onto the page. The table shows the chosen tracks, their codec
string, and a green or red dot depending on whether your browser can decode
them.

## License

MIT.
