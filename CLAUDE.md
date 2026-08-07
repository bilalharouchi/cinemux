# cinemux

TypeScript library that makes a browser `<video>` play `.mkv` files by
demuxing Matroska and repackaging the samples as fMP4 for `MediaSource` — no
WASM, no transcoding. See [README.md](README.md) for the why (remuxing is not
decoding) and the CodecPrivate → MP4 box mapping table.

## Stack and commands

Strict TypeScript, pure ESM (`"type": "module"`, `verbatimModuleSyntax`), zero
runtime dependencies, browser target (the only Node-ism allowed is
`@types/node` in dev). No bundler: `tsc` alone produces `dist/`.

```bash
npm run typecheck   # tsc --noEmit — run after any change
npm test            # vitest run
npm run build        # tsc -p tsconfig.build.json → dist/
```

There is no linter/formatter configured (no ESLint, no Prettier): style comes
from matching the existing code, not from a tool.

Since `verbatimModuleSyntax` is on, imports that are only used for types must
be written as `import type { … }` (otherwise `tsc` fails).

## Architecture

```
src/
  ebml/        EBML primitive reader (vint, integers, floats) + Matroska IDs
  matroska/    streaming demuxer + block decoding (the 3 lacing types)
  codecs/      Matroska CodecID → MP4 sample entry + MSE codec string
  codecs/ac3/  in-house AC-3 decoder (bitstream → PCM), see "AC-3" below
  mp4/         ISO BMFF box writing, init segments and fragments
  source/      byte sources: HTTP (Range) and Blob
  remuxer.ts   ties it together: track selection, fragment chunking
  player.ts    MediaSource, backpressure, seek via Cues, memory quota
  audio-ac3.ts separate AC-3 playback via Web Audio, locked to <video>'s clock
  ac3-worker.ts AC-3 decoding in a Worker (see that file for why)
```

`test/` mirrors `src/` by topic, not by file. `scripts/` holds one-off
verification utilities (e.g. `verify-ac3.mts` compares our output against
`ffmpeg`) — not shipped code, no need to hold it to the same rigor as `src/`.

## Two traps that cost hours (already fixed, don't reintroduce them)

Detailed in the [README](README.md#two-traps-that-cost-hours):

1. **PTS ≠ DTS.** Matroska only stores PTS; reconstructing DTS requires
   sorting a closed group of pictures and reassigning in decode order. The
   reordering delay must be applied to both video and audio, or you get ~80ms
   of lip-sync drift.
2. **`OpusHead` (Ogg) ≠ `OpusSpecificBox` (MP4).** Version and endianness
   differ; a naive copy produces a stream the browser rejects.

## Tests: ground truth comes from external tools, not our own assumptions

MKV fixtures (`test/fixtures/*.mkv`) are produced by real `ffmpeg` calls
(commands documented in [test/fixtures/README.md](test/fixtures/README.md)),
never hand-built byte by byte. Assertions compare our output against
**ffprobe/ffmpeg** (packet count, error-free decoding, strictly increasing
PTS, tracks aligned within <5ms) — not against values we hardcoded ourselves.
For the AC-3 decoder, the reference is PCM extracted via
`ffmpeg -acodec pcm_f32le`, compared sample by sample (correlation, not exact
equality — two floating-point implementations diverge slightly).

When adding a case, prefer a new ffmpeg fixture over a mock: "a parser that
only passes on its own fixtures proves nothing."

## AC-3: work in progress

The AC-3 decoder (`src/codecs/ac3/`) is the newest and least stable part of
the repo (see recent commits: headers, bit allocation, normative tables). It
runs in a Worker (`ac3-worker.ts`) and plays via Web Audio alongside the muted
`<video>` (`audio-ac3.ts`) — MediaSource can't accept raw PCM. Known,
accepted limitations (not bugs): LFE channel not decoded, channel order
follows bitstream order rather than the WAV/Web Audio 5.1 convention. Before
"fixing" either of these, read the header comment of the file in question —
it explains why.

## Code conventions

- **Identifiers and prose in English** everywhere in the repo (code, docs,
  commit messages) — this used to be French with an exception for the
  AC-3/audio module; the whole codebase was translated ahead of
  open-sourcing, and English is now the only convention, no exceptions.
- **No comment that repeats what the code already says.** A comment earns its
  place only for a hidden constraint, a format trap (EBML/MP4/AC-3 all have a
  lot of non-obvious normative bits), or a pointer to a specific spec section
  (ETSI/ATSC section number for AC-3, e.g.).
- **Commit messages describe the discovery rather than the action** (e.g.
  `AC-3: the bug is in the headers, not the allocation` rather than
  `fix: header bug`) — consistent with `git log`.
