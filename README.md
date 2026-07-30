# cinemux

Lecture de fichiers **MKV dans un navigateur**. Sans WASM, sans transcodage, sans
worker, sans en-têtes COOP/COEP.

## L'idée

Un navigateur refuse un `.mkv`. Pas parce qu'il ne sait pas décoder ce qu'il y a
dedans — mais parce qu'il ne sait pas **ouvrir la boîte**.

Or un MKV et un MP4 emballent le plus souvent les mêmes flux élémentaires. Mieux :
Matroska range déjà la configuration du décodeur au format MP4.

| Codec | Ce que contient `CodecPrivate` | Boîte MP4 |
|---|---|---|
| H.264 | `AVCDecoderConfigurationRecord` | `avcC` — copie directe |
| HEVC | `HEVCDecoderConfigurationRecord` | `hvcC` — copie directe |
| AV1 | `AV1CodecConfigurationRecord` | `av1C` — copie directe |
| AAC | `AudioSpecificConfig` | `esds` — à envelopper |
| Opus | `OpusHead` (Ogg) | `dOps` — à convertir |
| FLAC | métadonnées FLAC | `dfLa` — à envelopper |

cinemux démultiplexe donc le Matroska et **remballe** les échantillons en MP4
fragmenté, qu'il donne à `MediaSource`. Aucun octet de bitstream n'est réencodé :
ce n'est pas du transcodage, c'est du reconditionnement. D'où un coût processeur
négligeable et un paquet de quelques dizaines de Ko, là où un `ffmpeg.wasm` pèse
25 Mo, exige `SharedArrayBuffer` et donc des en-têtes qui cassent le reste du site.

Et comme on passe par un vrai `<video>`, on hérite gratuitement des contrôles
natifs, du plein écran, de l'image dans l'image, du casting et des raccourcis.

## Usage

```ts
import { Cinemux, SourceHttp } from "cinemux";

const lecteur = await Cinemux.attacher(
  document.querySelector("video")!,
  new SourceHttp("/film.mkv"),
  { languePreferee: "fr" },
);

console.log(lecteur.diagnostic);
// { mime: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
//   video: { … supportee: true }, audio: { … }, ecartees: [], dureeMs: 7_320_000 }
```

Fichier local, sans serveur :

```ts
import { Cinemux, SourceBlob } from "cinemux";
await Cinemux.attacher(video, new SourceBlob(input.files[0]));
```

Savoir avant d'ouvrir quoi que ce soit :

```ts
import { navigateurCompatible, codecsDisponibles } from "cinemux";
navigateurCompatible();  // false sans MediaSource (Safari iPhone)
codecsDisponibles();     // { h264: true, hevc: false, aac: true, ac3: false, … }
```

## Ce qui marche

**Vidéo** — H.264 (Baseline → High, images B comprises), HEVC, AV1.
**Audio** — AAC, Opus, FLAC, MP3, et AC-3 là où le navigateur le décode (Safari).

**Seek sans télécharger le film.** L'index `Cues` d'un MKV vit à la fin du fichier,
mais le `SeekHead` du début dit où le trouver : deux requêtes `Range` suffisent à
récupérer l'index d'un film de 3 Go. Le seek fait ensuite une recherche binaire
dans les Cues et repart au Cluster voulu.

**Sélection de piste audio.** Sur un fichier multi-langue, cinemux préfère d'abord
ce que le navigateur sait décoder, puis la langue demandée, puis le codec le mieux
traité. Un AC-3 en français est inutile si rien ne le joue.

**Lecture progressive.** Le remuxeur travaille en flux : la première image
s'affiche après quelques centaines de Ko. Le téléchargement s'interrompt dès que le
tampon a assez d'avance, et la mémoire est rendue derrière la tête de lecture.

## Ce qui ne marche pas, et pourquoi

**AC-3, E-AC-3, DTS, TrueHD** ne sont décodés par aucun navigateur grand public —
Chromium a retiré les codecs audio propriétaires. cinemux les **détecte, les décrit
correctement** (`dac3` écrit depuis le bitstream, faute de `CodecPrivate` en
Matroska) et le dit dans `diagnostic.audio.supportee`. Il ne fait pas semblant : à
l'application de proposer une autre source, ou une autre piste du même fichier.

Les lever demanderait un décodeur AC-3 en WASM produisant du PCM, puis un
réencodage en Opus via `AudioEncoder` (WebCodecs) — faisable, mais c'est du
transcodage, avec le poids et le coût processeur que ça implique. Hors périmètre
pour l'instant ; l'interface est prête à l'accueillir.

**VP8/VP9** ne sont pas remuxés : un MKV en VP9/Opus est déjà presque du WebM, que
les navigateurs lisent nativement. Sers-le en `video/webm`.

**Safari sur iPhone** n'a pas `MediaSource` (hors « Managed Media Source »).
`navigateurCompatible()` renvoie `false` — mieux vaut le savoir avant.

**Sous-titres embarqués** (ASS/SSA, PGS) ne sont pas extraits. Les pistes de
sous-titres du MKV sont ignorées.

## Architecture

```
src/
  ebml/        lecteur de primitives EBML (vint, entiers, flottants) + IDs Matroska
  matroska/    démultiplexeur en flux + décodage des blocs (les 3 lacings)
  codecs/      CodecID Matroska → entrée d'échantillon MP4 + chaîne de codec MSE
  mp4/         écriture de boîtes ISO BMFF, segments d'init et fragments
  source/      sources d'octets : HTTP (Range) et Blob
  remuxer.ts   assemble le tout : sélection de pistes, découpage en fragments
  player.ts    MediaSource, contre-pression, seek par Cues, quota mémoire
```

## Les deux pièges qui coûtent des heures

**Matroska ne stocke que des PTS.** MP4 exige des DTS plus un décalage de
composition. Avec des images B les deux diffèrent : poser `DTS = PTS` fait afficher
les images dans l'ordre de décodage — saccade permanente sur tout encodage moderne.
La reconstruction s'appuie sur une propriété simple : sur un groupe d'images fermé,
l'*ensemble* des PTS égale l'ensemble des DTS, seul l'ordre change. Les PTS triés,
réattribués dans l'ordre de décodage, donnent des DTS croissants et exacts.

Conséquence : le premier DTS est antérieur au premier PTS, et `tfdt` est non signé.
La seule issue est d'avancer toute la présentation du délai de réordonnancement —
**et de l'appliquer à l'audio aussi**. Ne le mettre que sur la vidéo décale le son
de 80 ms, un défaut de synchronisation labiale audible.

**L'`OpusHead` d'Ogg n'est pas l'`OpusSpecificBox` de MP4.** La version vaut 1 d'un
côté et 0 de l'autre, et les entiers sont petit-boutistes en Ogg, gros-boutistes en
MP4. Recopier l'un dans l'autre en retirant la signature produit un `unsupported
OpusSpecificBox version`.

## Tests

```bash
npm test
```

25 tests. Les fixtures sont produites par ffmpeg (voir `test/fixtures/README.md`) et
la sortie est jugée par **ffprobe et ffmpeg**, pas par mes convictions : nombre de
paquets identique à la source, décodage complet sans une erreur, ordre de
présentation strictement croissant, pistes alignées à moins de 5 ms.

## Démo

```bash
npm run build
npx http-server -p 8899 .
# puis http://localhost:8899/demo/index.html
```

Dépose un `.mkv` dans la page. Le tableau affiche les pistes retenues, leur chaîne
de codec, et une pastille verte ou rouge selon que ton navigateur sait les décoder.

## Licence

MIT.
