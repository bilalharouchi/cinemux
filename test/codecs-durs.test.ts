import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Remuxer, type Diagnostic } from "../src/remuxer";

/**
 * Les cas qui cassent vraiment un remuxeur : images B (DTS ≠ PTS), HEVC (chaîne
 * de codec pénible), Opus (horloge à 48 kHz imposée).
 */

function remuxerVers(nom: string): { fichier: string; diag: Diagnostic } {
  const octets = new Uint8Array(readFileSync(new URL(`./fixtures/${nom}`, import.meta.url)));
  const morceaux: Uint8Array[] = [];
  let diag: Diagnostic | null = null;

  const r = new Remuxer({
    supporte: () => true,
    onInit: (s, d) => {
      diag = d;
      morceaux.push(s);
    },
    onSegment: (s) => morceaux.push(s),
    onErreur: (e) => {
      throw e;
    },
  });
  for (let i = 0; i < octets.length; i += 32768) {
    r.alimenter(octets.subarray(i, Math.min(i + 32768, octets.length)));
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
  return { fichier, diag: diag! };
}

/** Liste les PTS d'un flux, dans l'ordre de PRÉSENTATION. */
function ptsPresentation(fichier: string, flux = "v:0"): number[] {
  const sortie = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", flux, "-show_entries", "frame=pts_time",
     "-of", "csv=p=0", fichier],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  // ffprobe ajoute parfois un champ vide en fin de ligne (« 0.080000, ») : on ne
  // garde que la première colonne, sinon Number() rend NaN sur la 1re image.
  return sortie
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l: string) => Number(l.split(",")[0]));
}

describe("codecs difficiles", () => {
  it("images B : l'ordre de présentation est intact", () => {
    // LE test qui valide la reconstruction des DTS. Si DTS = PTS, ffprobe voit
    // des images dans l'ordre de décodage et la séquence n'est plus croissante.
    const source = new URL("./fixtures/h264-bframes-aac.mkv", import.meta.url).pathname;
    const { fichier } = remuxerVers("h264-bframes-aac.mkv");

    const avant = ptsPresentation(source);
    const apres = ptsPresentation(fichier);

    expect(apres.length).toBe(avant.length);
    // Strictement croissant : c'est ce que garantit un CTS correct.
    for (let i = 1; i < apres.length; i++) {
      expect(apres[i], `image ${i}`).toBeGreaterThan(apres[i - 1]);
    }
    // Le décalage par rapport à la source doit être CONSTANT : c'est le délai de
    // réordonnancement, inévitable puisque `tfdt` ne peut pas être négatif. Ce qui
    // compte, c'est qu'il soit identique partout — sinon l'image accélère ou traîne.
    const decalages = apres.map((t, i) => Number((t - avant[i]).toFixed(4)));
    expect(new Set(decalages).size, `décalages observés : ${[...new Set(decalages)]}`).toBe(1);
    // Et qu'il reste de l'ordre de quelques images, pas d'une seconde.
    expect(Math.abs(decalages[0])).toBeLessThan(0.2);
  });

  it("images B : le fichier se décode sans erreur", () => {
    const { fichier } = remuxerVers("h264-bframes-aac.mkv");
    const sortie = execFileSync("ffmpeg", ["-v", "error", "-i", fichier, "-f", "null", "-"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(sortie.trim()).toBe("");
  });

  it("HEVC : chaîne de codec et décodage", () => {
    const { fichier, diag } = remuxerVers("hevc-aac.mkv");
    expect(diag.video?.piste.codecId).toBe("V_MPEGH/ISO/HEVC");
    // Forme attendue : hvc1.<profil>.<compat hex>.<tier><niveau>[.contraintes]
    expect(diag.video?.description.codec).toMatch(/^hvc1\.\d+\.[0-9A-F]+\.[LH]\d+/);

    const flux = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", fichier],
      { encoding: "utf8" },
    );
    expect(flux).toContain("hevc");

    const sortie = execFileSync("ffmpeg", ["-v", "error", "-i", fichier, "-f", "null", "-"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(sortie.trim()).toBe("");
  });

  it("Opus : horloge forcée à 48 kHz et OpusHead dépouillé", () => {
    const { fichier, diag } = remuxerVers("h264-opus.mkv");
    expect(diag.audio?.piste.codecId).toBe("A_OPUS");
    expect(diag.audio?.description.codec).toBe("opus");
    // Opus travaille toujours en 48 kHz, quelle que soit la fréquence déclarée.
    expect(diag.audio?.description.timescale).toBe(48000);

    const flux = execFileSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate",
       "-of", "csv=p=0", fichier],
      { encoding: "utf8" },
    );
    expect(flux.trim()).toContain("opus");

    const sortie = execFileSync("ffmpeg", ["-v", "error", "-i", fichier, "-f", "null", "-"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(sortie.trim()).toBe("");
  });

  it("640x360 : les dimensions traversent le remux", () => {
    const { fichier } = remuxerVers("h264-bframes-aac.mkv");
    const dim = execFileSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
       "-of", "csv=p=0", fichier],
      { encoding: "utf8" },
    ).trim();
    expect(dim).toBe("640,360");
  });

  it("l'audio et la vidéo restent alignés", () => {
    // Une dérive A/V est le symptôme d'un timescale ou d'un tfdt faux.
    const { fichier } = remuxerVers("h264-bframes-aac.mkv");
    const debut = (flux: string) =>
      Number(
        execFileSync(
          "ffprobe",
          ["-v", "error", "-select_streams", flux, "-show_entries", "stream=start_time",
           "-of", "csv=p=0", fichier],
          { encoding: "utf8" },
        ).trim(),
      );
    // Le décalage de réordonnancement s'applique aux DEUX pistes : ne le mettre
    // que sur la vidéo décalait le son de 80 ms (défaut audible sur les lèvres).
    expect(Math.abs(debut("v:0") - debut("a:0"))).toBeLessThan(0.005);

    const duree = (flux: string) =>
      Number(
        execFileSync(
          "ffprobe",
          ["-v", "error", "-select_streams", flux, "-show_entries", "stream=duration",
           "-of", "csv=p=0", fichier],
          { encoding: "utf8" },
        ).trim(),
      );
    // Moins de 100 ms d'écart de durée entre les deux pistes sur 4 s.
    expect(Math.abs(duree("v:0") - duree("a:0"))).toBeLessThan(0.1);
  });
});
