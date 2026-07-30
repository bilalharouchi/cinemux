/**
 * cinemux — lecture de fichiers MKV dans un navigateur.
 *
 * Principe : un MKV et un MP4 emballent souvent les MÊMES flux élémentaires
 * (H.264, HEVC, AV1, AAC, Opus…). Le navigateur ne sait pas ouvrir la boîte
 * Matroska, mais il sait décoder ce qu'elle contient. On remballe donc les
 * échantillons en MP4 fragmenté à la volée, et on les donne à MediaSource.
 *
 * Aucun octet de bitstream n'est réencodé : ce n'est pas du transcodage, c'est
 * du reconditionnement. D'où l'absence de WASM, de worker et d'en-têtes
 * COOP/COEP — et un coût processeur négligeable.
 *
 * ```ts
 * import { Cinemux, SourceHttp } from "cinemux";
 *
 * const lecteur = await Cinemux.attacher(
 *   document.querySelector("video")!,
 *   new SourceHttp("/film.mkv"),
 *   { languePreferee: "fr" },
 * );
 * console.log(lecteur.diagnostic);
 * ```
 */

export { Cinemux, type OptionsLecture } from "./player";
export { Remuxer, type Diagnostic, type PisteChoisie, type OptionsRemuxer } from "./remuxer";
export { SourceHttp } from "./source/http";
export { SourceBlob } from "./source/blob";
export type { Source } from "./source";

export { MatroskaDemuxer } from "./matroska/demuxer";
export type { Piste, Echantillon, PointCue } from "./matroska/demuxer";
export { TrackType } from "./ebml/ids";

export { decrire, analyserAc3, mimeDe, CodecNonSupporte, type Description } from "./codecs";
export { segmentInit, segmentMedia, reconstruireDts } from "./mp4/muxer";

/**
 * Ce navigateur peut-il lire du MKV via cinemux ?
 *
 * Répond non sans MediaSource (vieux navigateurs, et surtout Safari iPhone où MSE
 * n'existe pas hors mode « Managed Media Source »).
 */
export function navigateurCompatible(): boolean {
  return typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function";
}

/**
 * Codecs réellement décodables ici, pour informer avant même d'ouvrir un fichier.
 * Utile pour choisir une source côté serveur plutôt que d'échouer devant l'utilisateur.
 */
export function codecsDisponibles(): Record<string, boolean> {
  if (typeof MediaSource === "undefined") return {};
  const tester = (mime: string) => MediaSource.isTypeSupported(mime);
  return {
    "h264": tester('video/mp4; codecs="avc1.640028"'),
    "hevc": tester('video/mp4; codecs="hvc1.1.6.L93.B0"'),
    "av1": tester('video/mp4; codecs="av01.0.08M.08"'),
    "aac": tester('audio/mp4; codecs="mp4a.40.2"'),
    "opus": tester('audio/mp4; codecs="opus"'),
    "flac": tester('audio/mp4; codecs="flac"'),
    "ac3": tester('audio/mp4; codecs="ac-3"'),
    "eac3": tester('audio/mp4; codecs="ec-3"'),
  };
}
