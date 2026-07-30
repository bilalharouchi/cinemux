import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MatroskaDemuxer, type Echantillon, type Piste } from "../src/matroska/demuxer.js";
import { TrackType } from "../src/ebml/ids.js";

/**
 * Les fixtures sont produites par ffmpeg (voir test/fixtures/README.md) : ce sont
 * de vrais MKV écrits par un vrai muxer, pas des octets fabriqués à la main. Un
 * parseur qui ne passe que sur ses propres fichiers de test ne prouve rien.
 */
function lire(nom: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${nom}`, import.meta.url)));
}

/** Démultiplexe en un seul morceau. */
function demuxer(nom: string) {
  const pistes: Piste[] = [];
  const echantillons: Echantillon[] = [];
  const d = new MatroskaDemuxer({
    onPistes: (p) => pistes.push(...p),
    onEchantillon: (e) => echantillons.push(e),
  });
  d.alimenter(lire(nom));
  return { d, pistes, echantillons };
}

describe("démultiplexeur Matroska", () => {
  it("lit l'échelle de temps et la durée", () => {
    const { d } = demuxer("h264-aac.mkv");
    // ffmpeg écrit 1 ms par tick, la valeur par défaut de la spec.
    expect(d.timestampScale).toBe(1_000_000);
    expect(d.dureeMs).toBeGreaterThan(2900);
    expect(d.dureeMs).toBeLessThan(3200);
  });

  it("trouve les deux pistes et leurs codecs", () => {
    const { pistes } = demuxer("h264-aac.mkv");
    expect(pistes).toHaveLength(2);

    const video = pistes.find((p) => p.type === TrackType.VIDEO)!;
    expect(video.codecId).toBe("V_MPEG4/ISO/AVC");
    expect(video.video?.largeur).toBe(320);
    expect(video.video?.hauteur).toBe(180);
    // Sans avcC, impossible d'initialiser le décodeur : c'est éliminatoire.
    expect(video.codecPrivate).not.toBeNull();
    expect(video.codecPrivate!.length).toBeGreaterThan(7);

    const audio = pistes.find((p) => p.type === TrackType.AUDIO)!;
    expect(audio.codecId).toBe("A_AAC");
    expect(audio.audio?.frequence).toBe(44100);
    expect(audio.audio?.canaux).toBe(1);
    expect(audio.codecPrivate).not.toBeNull(); // AudioSpecificConfig
  });

  it("le CodecPrivate H.264 est bien un avcC", () => {
    // C'est l'hypothèse qui rend le remux possible sans réécrire le bitstream :
    // configurationVersion = 1, puis profil/compat/niveau.
    const { pistes } = demuxer("h264-aac.mkv");
    const avcC = pistes.find((p) => p.type === TrackType.VIDEO)!.codecPrivate!;
    expect(avcC[0]).toBe(1);
    // Les 2 bits de poids fort de l'octet 4 sont réservés à 1 (0xFC).
    expect(avcC[4] & 0xfc).toBe(0xfc);
  });

  it("extrait toutes les trames avec des timestamps croissants", () => {
    const { echantillons } = demuxer("h264-aac.mkv");
    // 3 s à 25 i/s = 75 trames vidéo, plus l'audio.
    const video = echantillons.filter((e) => e.piste === 1);
    expect(video.length).toBeGreaterThanOrEqual(74);

    // Le premier échantillon vidéo est forcément une image clé.
    expect(video[0].keyframe).toBe(true);

    // Ordre de décodage : les timestamps ne doivent jamais reculer.
    for (let i = 1; i < video.length; i++) {
      expect(video[i].timestamp).toBeGreaterThanOrEqual(video[i - 1].timestamp);
    }
  });

  it("aucune trame vide ne sort du démultiplexeur", () => {
    // Une trame de 0 octet passerait le typage et casserait le décodeur en aval.
    const { echantillons } = demuxer("h264-aac.mkv");
    expect(echantillons.length).toBeGreaterThan(0);
    for (const e of echantillons) expect(e.donnees.length).toBeGreaterThan(0);
  });

  it("le découpage en morceaux ne change rien au résultat", () => {
    // C'est LE test qui compte pour le streaming : un élément coupé au milieu d'un
    // morceau doit être remis à plus tard, pas perdu ni dupliqué.
    const octets = lire("h264-aac.mkv");
    const enUnBloc = demuxer("h264-aac.mkv").echantillons;

    for (const taille of [1, 7, 64, 1000, 65536]) {
      const echantillons: Echantillon[] = [];
      const d = new MatroskaDemuxer({ onEchantillon: (e) => echantillons.push(e) });
      for (let i = 0; i < octets.length; i += taille) {
        d.alimenter(octets.subarray(i, Math.min(i + taille, octets.length)));
      }
      expect(echantillons.length, `morceaux de ${taille} o`).toBe(enUnBloc.length);
      expect(echantillons[0].donnees, `morceaux de ${taille} o`).toEqual(enUnBloc[0].donnees);
      const dernier = echantillons.length - 1;
      expect(echantillons[dernier].timestamp).toBe(enUnBloc[dernier].timestamp);
    }
  });

  it("reconnaît l'AC3, qu'aucun navigateur ne décode", () => {
    const { pistes } = demuxer("h264-ac3.mkv");
    const audio = pistes.find((p) => p.type === TrackType.AUDIO)!;
    expect(audio.codecId).toBe("A_AC3");
    // La spec ne prévoit pas de CodecPrivate pour l'AC3 : tout est dans le flux.
    expect(audio.codecPrivate).toBeNull();
  });

  it("voit les deux pistes audio d'un fichier multi-langue", () => {
    const { pistes } = demuxer("h264-multi-audio.mkv");
    const audio = pistes.filter((p) => p.type === TrackType.AUDIO);
    expect(audio).toHaveLength(2);
    expect(audio.map((p) => p.codecId).sort()).toEqual(["A_AAC", "A_AC3"]);
  });

  it("collecte l'index de seek (Cues)", () => {
    const { d } = demuxer("h264-aac.mkv");
    expect(d.cues.length).toBeGreaterThan(0);
    // Les positions sont relatives au Segment : on les a rendues absolues.
    for (const c of d.cues) expect(c.positionCluster).toBeGreaterThan(0);
    // Le premier point de seek est à zéro.
    expect(d.cues[0].temps).toBe(0);
  });
});
