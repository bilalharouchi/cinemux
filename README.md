# cinemux

Play **MKV files in a browser**. No WASM, no transcoding, no worker, no
COOP/COEP headers.

## The idea

A browser refuses a `.mkv`. Not because it can't decode what's inside — but
because it doesn't know how to **open the box**.

Yet an MKV and an MP4 most often wrap the same elementary streams. Better
still: Matroska already stores the decoder configuration in MP4's own
format.

| Codec | What `CodecPrivate` holds | MP4 box |
|---|---|---|
| H.264 | `AVCDecoderConfigurationRecord` | `avcC` — direct copy |
| HEVC | `HEVCDecoderConfigurationRecord` | `hvcC` — direct copy |
| AV1 | `AV1CodecConfigurationRecord` | `av1C` — direct copy |
| AAC | `AudioSpecificConfig` | `esds` — needs wrapping |
| Opus | `OpusHead` (Ogg) | `dOps` — needs converting |
| FLAC | FLAC metadata | `dfLa` — needs wrapping |

So cinemux demuxes the Matroska and **repackages** the samples as fragmented
MP4, which it hands to `MediaSource`. No bitstream byte is ever re-encoded:
this isn't transcoding, it's repackaging. Hence a negligible CPU cost and a
package weighing a few dozen KB, where an `ffmpeg.wasm` weighs 25 MB,
requires `SharedArrayBuffer`, and therefore headers that break the rest of
the site.

And since it goes through a real `<video>`, native controls, fullscreen,
picture-in-picture, casting, and keyboard shortcuts all come for free.

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

## What works

**Video** — H.264 (Baseline → High, B-frames included), HEVC, AV1.
**Audio** — AAC, Opus, FLAC, MP3, and AC-3 wherever the browser decodes it (Safari).

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

## What doesn't work, and why

**AC-3, E-AC-3, DTS, TrueHD** aren't decoded by any mainstream browser —
Chromium dropped proprietary audio codecs. cinemux **detects them and
describes them correctly** (`dac3` written from the bitstream, since
Matroska has no `CodecPrivate` for it) and reports it in
`diagnostic.audio.supported`. It doesn't fake it: it's up to the application
to offer another source, or another track from the same file.

Lifting this would require a WASM AC-3 decoder producing PCM, then
re-encoding to Opus via `AudioEncoder` (WebCodecs) — doable, but that's
transcoding, with the weight and CPU cost that implies. Out of scope for
now; the interface is ready to accommodate it.

**VP8/VP9** aren't remuxed: an MKV with VP9/Opus is already almost WebM,
which browsers play natively. Serve it as `video/webm`.

**Safari on iPhone** doesn't have `MediaSource` (outside "Managed Media
Source"). `browserCompatible()` returns `false` — better to know that ahead
of time.

**Embedded subtitles** (ASS/SSA, PGS) aren't extracted. The MKV's subtitle
tracks are ignored.

## Architecture

```
src/
  ebml/        EBML primitive reader (vint, integers, floats) + Matroska IDs
  matroska/    streaming demuxer + block decoding (the 3 lacing types)
  codecs/      Matroska CodecID → MP4 sample entry + MSE codec string
  mp4/         ISO BMFF box writing, init segments and fragments
  source/      byte sources: HTTP (Range) and Blob
  remuxer.ts   ties it together: track selection, fragment chunking
  player.ts    MediaSource, backpressure, seek via Cues, memory quota
```

## Two traps that cost hours

**Matroska only stores PTS.** MP4 requires DTS plus a composition offset.
With B-frames the two differ: setting `DTS = PTS` displays frames in decode
order — a permanent stutter on any modern encoding. The reconstruction
relies on a simple property: within a closed group of pictures, the *set* of
PTS equals the set of DTS, only the order changes. Sorting the PTS and
reassigning them in decode order yields exact, increasing DTS values.

Consequence: the first DTS comes before the first PTS, and `tfdt` is
unsigned. The only way out is to advance the entire presentation by the
reordering delay — **and to apply it to audio too**. Applying it only to
video shifts the sound by 80 ms, an audible lip-sync bug.

**Ogg's `OpusHead` is not MP4's `OpusSpecificBox`.** The version is 1 on one
side and 0 on the other, and the integers are little-endian in Ogg,
big-endian in MP4. Copying one into the other while just stripping the
signature produces an `unsupported OpusSpecificBox version`.

## Tests

```bash
npm test
```

25 tests. Fixtures are produced by ffmpeg (see `test/fixtures/README.md`)
and the output is judged by **ffprobe and ffmpeg**, not by my own
convictions: packet count matching the source, error-free decoding
throughout, strictly increasing presentation order, tracks aligned within
less than 5 ms.

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
