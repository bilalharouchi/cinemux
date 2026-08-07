# Fixtures

MKV files produced by ffmpeg — real files written by a real muxer, not bytes
hand-crafted by hand. A parser that only passes on its own fixtures proves
nothing.

To regenerate them:

```bash
# Baseline case: H.264 Baseline + AAC
ffmpeg -f lavfi -i "testsrc2=size=320x180:rate=25:duration=3" \
  -f lavfi -i "sine=frequency=440:duration=3" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 25 -c:a aac -b:a 64k h264-aac.mkv

# AC-3: what no browser decodes
ffmpeg -f lavfi -i "testsrc2=size=320x180:rate=25:duration=3" \
  -f lavfi -i "sine=frequency=440:duration=3" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 25 -c:a ac3 -b:a 192k h264-ac3.mkv

# Two audio tracks (AC-3 default + AAC): the selector must prefer the AAC
ffmpeg -f lavfi -i "testsrc2=size=320x180:rate=25:duration=3" \
  -f lavfi -i "sine=frequency=440:duration=3" -f lavfi -i "sine=frequency=880:duration=3" \
  -map 0:v -map 1:a -map 2:a -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
  -c:a:0 ac3 -c:a:1 aac h264-multi-audio.mkv

# B-frames: THE test for DTS reconstruction
ffmpeg -f lavfi -i "testsrc2=size=640x360:rate=25:duration=4" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=4" \
  -c:v libx264 -preset medium -profile:v high -bf 3 -g 25 -pix_fmt yuv420p \
  -c:a aac -ar 48000 -b:a 96k h264-bframes-aac.mkv

# HEVC: the painful codec string (reversed compatibility bits)
ffmpeg -f lavfi -i "testsrc2=size=640x360:rate=25:duration=3" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3" \
  -c:v libx265 -preset ultrafast -x265-params log-level=none -pix_fmt yuv420p \
  -c:a aac -ar 48000 hevc-aac.mkv

# Opus: little-endian OpusHead → big-endian dOps
ffmpeg -f lavfi -i "testsrc2=size=320x180:rate=25:duration=3" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a libopus -b:a 96k h264-opus.mkv

# E-AC-3: described for an honest diagnostic, but not decoded (an entirely
# different syntax from plain AC-3 — see the note in trame.ts)
ffmpeg -f lavfi -i "testsrc2=size=320x180:rate=25:duration=3" \
  -f lavfi -i "sine=frequency=440:duration=3" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 25 -c:a eac3 -b:a 192k h264-eac3.mkv

# Reference PCM for the AC-3 track of h264-ac3.mkv (test/ac3-synthese.test.ts):
# an INDEPENDENT decoder (libavcodec, not our code) to compare our synthesis
# (IMDCT + window + overlap-add) against, sample by sample.
ffmpeg -y -i h264-ac3.mkv -map 0:a:0 -f f32le -acodec pcm_f32le h264-ac3-reference.f32

# Stereo AC-3 WITHOUT coupling (two distinct tones, never shared): mono
# can't reveal a channel-boundary bug (a single channel, never a boundary) —
# see test/ac3-stereo.test.ts.
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=2" \
  -f lavfi -i "sine=frequency=880:duration=2" \
  -filter_complex "[0:a][1:a]amerge=inputs=2[a]" -map "[a]" -ac 2 \
  -c:a ac3 -b:a 192k -channel_coupling 0 stereo-simple.ac3
ffmpeg -y -i stereo-simple.ac3 -f f32le -acodec pcm_f32le stereo-simple-reference.f32

# Stereo AC-3 WITH forced coupling (§7.4 — high frequencies shared between
# channels, very common in real 5.1/stereo content): pink noise instead of a
# pure tone, to force real content into the coupling range and distinguish
# "the bits are consumed" from "the coefficients are correctly distributed
# to each channel".
ffmpeg -y -f lavfi -i "anoisesrc=d=2:c=pink:r=44100" \
  -f lavfi -i "anoisesrc=d=2:c=pink:r=44100:seed=42" \
  -filter_complex "[0:a][1:a]amerge=inputs=2[a]" -map "[a]" -ac 2 \
  -c:a ac3 -b:a 192k -channel_coupling 1 stereo-coupling.ac3
ffmpeg -y -i stereo-coupling.ac3 -f f32le -acodec pcm_f32le stereo-coupling-reference.f32
```
