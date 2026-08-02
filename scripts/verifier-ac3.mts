import { readFileSync } from "node:fs";
import { analyserTrame, lireEntete, SYNCWORD } from "../src/codecs/ac3/trame.js";
import { LecteurBits } from "../src/codecs/ac3/bits.js";

const fichier = process.argv[2];
const data = new Uint8Array(readFileSync(fichier));

let offset = 0, trames = 0, alignes = 0;
const ecarts: number[] = [];

while (offset + 6 < data.length) {
  if (!(data[offset] === 0x0b && data[offset + 1] === 0x77)) { offset++; continue; }
  const entete = lireEntete(new LecteurBits(data.subarray(offset)));
  if (!entete || entete.tailleOctets === 0) { offset++; continue; }
  const trame = data.subarray(offset, offset + entete.tailleOctets);
  if (trame.length < entete.tailleOctets) break;

  const res = analyserTrame(trame);
  trames++;
  if (res) {
    // La lecture doit retomber DANS la trame, au plus près de sa fin :
    // il reste crc2 (16 bits) et un éventuel bourrage.
    const bitsTrame = entete.tailleOctets * 8;
    const reste = bitsTrame - res.bitsConsommes;
    ecarts.push(reste);
    if (reste >= 0 && reste < 200) alignes++;
  }
  offset += entete.tailleOctets;
}

const e0 = lireEntete(new LecteurBits(data));
console.log(`fichier   : ${fichier}`);
console.log(`entête    : ${e0?.frequence} Hz, acmod=${e0?.acmod} (${e0?.canaux} canaux), lfe=${e0?.lfeon}, ${e0?.tailleOctets} o/trame`);
console.log(`trames    : ${trames}`);
console.log(`alignées  : ${alignes}/${trames}  (${trames ? Math.round(100*alignes/trames) : 0} %)`);
if (ecarts.length) {
  const tri = [...ecarts].sort((a, b) => a - b);
  console.log(`bits restants en fin de trame — min ${tri[0]}, médiane ${tri[tri.length>>1]}, max ${tri[tri.length-1]}`);
  const negatifs = ecarts.filter((x) => x < 0).length;
  console.log(`dépassements (lecture au-delà de la trame) : ${negatifs}`);
}
