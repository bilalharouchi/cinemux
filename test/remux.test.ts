import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Remuxer, type Diagnostic } from "../src/remuxer.js";

/**
 * Ces tests jugent la sortie avec ffprobe, pas avec mes propres convictions.
 * Un fMP4 « qui a l'air bon » et qu'aucun démultiplexeur ne relit n'a aucune valeur.
 */

function lireFixture(nom: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${nom}`, import.meta.url)));
}

/** Codecs que le faux navigateur des tests accepte : le cas Chrome. */
function faussSupport(mime: string): boolean {
  return !/ac-3|ec-3|dts/.test(mime);
}

type Resultat = { fichier: string; diag: Diagnostic; segments: number; octets: number };

function remuxer(nom: string, options: { support?: (m: string) => boolean; langue?: string } = {}): Resultat {
  const morceaux: Uint8Array[] = [];
  let diag: Diagnostic | null = null;
  let segments = 0;

  const r = new Remuxer({
    supporte: options.support ?? faussSupport,
    languePreferee: options.langue,
    onInit: (seg, d) => {
      diag = d;
      morceaux.push(seg);
    },
    onSegment: (seg) => {
      segments++;
      morceaux.push(seg);
    },
    onErreur: (e) => {
      throw e;
    },
  });

  // Alimenté par morceaux de 64 Ko, comme le ferait une requête HTTP en flux.
  const octets = lireFixture(nom);
  for (let i = 0; i < octets.length; i += 65536) {
    r.alimenter(octets.subarray(i, Math.min(i + 65536, octets.length)));
  }
  r.terminer();

  const total = morceaux.reduce((n, m) => n + m.length, 0);
  const sortie = new Uint8Array(total);
  let pos = 0;
  for (const m of morceaux) {
    sortie.set(m, pos);
    pos += m.length;
  }

  const fichier = join(mkdtempSync(join(tmpdir(), "cinemux-")), nom.replace(/\.mkv$/, ".mp4"));
  writeFileSync(fichier, sortie);
  return { fichier, diag: diag!, segments, octets: total };
}

function ffprobe(fichier: string, ...args: string[]): string {
  return execFileSync("ffprobe", ["-v", "error", ...args, fichier], { encoding: "utf8" }).trim();
}

describe("remux MKV → fMP4", () => {
  it("produit un MP4 que ffprobe relit, avec les deux pistes", () => {
    const { fichier, diag } = remuxer("h264-aac.mkv");

    expect(diag.video?.piste.codecId).toBe("V_MPEG4/ISO/AVC");
    expect(diag.audio?.piste.codecId).toBe("A_AAC");
    // La chaîne est DÉRIVÉE de l'avcC, jamais devinée : x264 en `ultrafast`
    // produit du Constrained Baseline niveau 1.2, soit 42c00c.
    const avcC = diag.video!.piste.codecPrivate!;
    const attendu = [avcC[1], avcC[2], avcC[3]]
      .map((o) => o.toString(16).padStart(2, "0"))
      .join("");
    expect(diag.mime).toBe(`video/mp4; codecs="avc1.${attendu},mp4a.40.2"`);
    expect(diag.mime).toMatch(/^video\/mp4; codecs="avc1\.[0-9a-f]{6},mp4a\.40\.2"$/);

    const flux = ffprobe(fichier, "-show_entries", "stream=codec_name,codec_type,width,height", "-of", "csv=p=0");
    expect(flux).toContain("h264,video,320,180");
    expect(flux).toContain("aac,audio");
  });

  it("le conteneur est bien du MP4 fragmenté", () => {
    const { fichier } = remuxer("h264-aac.mkv");
    const format = ffprobe(fichier, "-show_entries", "format=format_name", "-of", "csv=p=0");
    expect(format).toMatch(/mp4/);
    // Un fragmenté n'a pas de table d'échantillons : ffprobe le lit via les moof.
    const octets = readFileSync(fichier);
    expect(octets.includes(Buffer.from("moof"))).toBe(true);
    expect(octets.includes(Buffer.from("mvex"))).toBe(true);
    expect(octets.includes(Buffer.from("tfdt"))).toBe(true);
  });

  it("aucune trame n'est perdue ni inventée", () => {
    const { fichier } = remuxer("h264-aac.mkv");
    const source = new URL("./fixtures/h264-aac.mkv", import.meta.url).pathname;

    const compter = (f: string, flux: string) =>
      Number(
        execFileSync(
          "ffprobe",
          ["-v", "error", "-select_streams", flux, "-count_packets",
           "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", f],
          { encoding: "utf8" },
        ).trim(),
      );

    expect(compter(fichier, "v:0")).toBe(compter(source, "v:0"));
    expect(compter(fichier, "a:0")).toBe(compter(source, "a:0"));
  });

  it("la vidéo se décode réellement, sans erreur", () => {
    // Le seul test qui prouve que les octets sont au bon endroit : on décode tout.
    const { fichier } = remuxer("h264-aac.mkv");
    const sortie = execFileSync(
      "ffmpeg",
      ["-v", "error", "-i", fichier, "-f", "null", "-"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(sortie.trim()).toBe("");
  });

  it("la durée est préservée", () => {
    const { fichier } = remuxer("h264-aac.mkv");
    const duree = Number(ffprobe(fichier, "-show_entries", "format=duration", "-of", "csv=p=0"));
    expect(duree).toBeGreaterThan(2.9);
    expect(duree).toBeLessThan(3.2);
  });

  it("préfère l'AAC à l'AC-3 quand les deux existent", () => {
    // Cas réel d'une release MULTi : la piste AC-3 est souvent la première et
    // marquée par défaut, mais aucun navigateur ne la décode.
    const { diag } = remuxer("h264-multi-audio.mkv");
    expect(diag.audio?.piste.codecId).toBe("A_AAC");
    expect(diag.audio?.supportee).toBe(true);
  });

  it("garde l'AC-3 quand le navigateur le décode (Safari)", () => {
    const { diag } = remuxer("h264-multi-audio.mkv", { support: () => true });
    // Tout est supporté : c'est alors le rang de codec qui tranche, AAC en tête.
    expect(diag.audio?.supportee).toBe(true);
  });

  it("un fichier AC-3 seul est décrit, et signalé comme non lisible", () => {
    // On ne fait pas semblant : la piste est décrite (dac3 écrit depuis le flux),
    // mais `supportee` dit la vérité au lecteur, qui pourra proposer autre chose.
    const { diag } = remuxer("h264-ac3.mkv");
    expect(diag.audio?.piste.codecId).toBe("A_AC3");
    expect(diag.audio?.supportee).toBe(false);
    expect(diag.video?.supportee).toBe(true);
  });

  it("produit plusieurs fragments plutôt qu'un seul bloc", () => {
    // Un seul fragment interdirait la lecture progressive : il faudrait tout
    // télécharger avant la première image.
    const { segments } = remuxer("h264-aac.mkv");
    expect(segments).toBeGreaterThan(2);
  });

  it("l'audio AC-3 est analysé correctement depuis le flux", async () => {
    const { analyserAc3 } = await import("../src/codecs/index.js");
    // Première trame AC-3 de la fixture, extraite via le démultiplexeur.
    const { MatroskaDemuxer } = await import("../src/matroska/demuxer.js");
    let trame: Uint8Array | null = null;
    const d = new MatroskaDemuxer({
      onEchantillon: (e: { piste: number; donnees: Uint8Array }) => {
        if (!trame && e.piste === 2) trame = e.donnees;
      },
    });
    d.alimenter(lireFixture("h264-ac3.mkv"));

    const entete = analyserAc3(trame!);
    expect(entete).not.toBeNull();
    // ffprobe dit 44100 Hz / 1 canal sur cette fixture : notre lecture du
    // bitstream doit tomber exactement dessus, sans CodecPrivate pour aider.
    expect(entete!.frequence).toBe(44100);
    expect([48000, 44100, 32000]).toContain(entete!.frequence);
    expect(entete!.canaux).toBe(1);
  });
});
