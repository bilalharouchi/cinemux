# Fixtures

Fichiers MKV produits par ffmpeg — de vrais fichiers écrits par un vrai muxer,
pas des octets fabriqués à la main. Un parseur qui ne passe que sur ses propres
fixtures ne prouve rien.

Pour les régénérer :

```bash
# Cas nominal : H.264 Baseline + AAC
ffmpeg -f lavfi -i "testsrc2=size=320x180:rate=25:duration=3" \
  -f lavfi -i "sine=frequency=440:duration=3" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 25 -c:a aac -b:a 64k h264-aac.mkv

# AC-3 : ce qu'aucun navigateur ne décode
ffmpeg -f lavfi -i "testsrc2=size=320x180:rate=25:duration=3" \
  -f lavfi -i "sine=frequency=440:duration=3" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 25 -c:a ac3 -b:a 192k h264-ac3.mkv

# Deux pistes audio (AC-3 par défaut + AAC) : le sélecteur doit préférer l'AAC
ffmpeg -f lavfi -i "testsrc2=size=320x180:rate=25:duration=3" \
  -f lavfi -i "sine=frequency=440:duration=3" -f lavfi -i "sine=frequency=880:duration=3" \
  -map 0:v -map 1:a -map 2:a -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
  -c:a:0 ac3 -c:a:1 aac h264-multi-audio.mkv

# Images B : LE test de la reconstruction des DTS
ffmpeg -f lavfi -i "testsrc2=size=640x360:rate=25:duration=4" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=4" \
  -c:v libx264 -preset medium -profile:v high -bf 3 -g 25 -pix_fmt yuv420p \
  -c:a aac -ar 48000 -b:a 96k h264-bframes-aac.mkv

# HEVC : chaîne de codec pénible (bits de compatibilité inversés)
ffmpeg -f lavfi -i "testsrc2=size=640x360:rate=25:duration=3" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3" \
  -c:v libx265 -preset ultrafast -x265-params log-level=none -pix_fmt yuv420p \
  -c:a aac -ar 48000 hevc-aac.mkv

# Opus : OpusHead petit-boutiste → dOps gros-boutiste
ffmpeg -f lavfi -i "testsrc2=size=320x180:rate=25:duration=3" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a libopus -b:a 96k h264-opus.mkv
```
