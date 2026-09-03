// Dessine la marque de Bublee en PNG, aux tailles que reclame un ecran
// d'accueil. Le logo est fait de deux cercles et d'une intersection : ca se
// calcule, ca ne demande pas de bibliotheque d'images.
//
//   node scripts/icones.mjs
//
// Un encodeur PNG tient en quarante lignes quand on se contente de RGBA sans
// filtre : en-tete, donnees compressees par zlib, fin, et un CRC par bloc.
// Ajouter une dependance native pour deux cercles aurait ete cher paye.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dossier = path.join(root, 'public', 'icones');
fs.mkdirSync(dossier, { recursive: true });

/* ------------------------------------------------------------------ PNG */

const TABLE_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const octet of buf) c = TABLE_CRC[(c ^ octet) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function bloc(type, donnees) {
  const corps = Buffer.concat([Buffer.from(type, 'latin1'), donnees]);
  const taille = Buffer.alloc(4);
  taille.writeUInt32BE(donnees.length);
  const somme = Buffer.alloc(4);
  somme.writeUInt32BE(crc32(corps));
  return Buffer.concat([taille, corps, somme]);
}

/** `pixels` : RGBA, quatre octets par point, sans en-tete de ligne. */
function png(largeur, hauteur, pixels) {
  const entete = Buffer.alloc(13);
  entete.writeUInt32BE(largeur, 0);
  entete.writeUInt32BE(hauteur, 4);
  entete[8] = 8;    // huit bits par composante
  entete[9] = 6;    // RGBA
  // Chaque ligne est precedee de son octet de filtre, ici « aucun ».
  const brut = Buffer.alloc(hauteur * (1 + largeur * 4));
  for (let y = 0; y < hauteur; y++) {
    brut[y * (1 + largeur * 4)] = 0;
    pixels.copy(brut, y * (1 + largeur * 4) + 1, y * largeur * 4, (y + 1) * largeur * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloc('IHDR', entete),
    bloc('IDAT', zlib.deflateSync(brut, { level: 9 })),
    bloc('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------- la marque */

const ENCRE = [0x24, 0x23, 0x1f];
const PAPIER = [0xe9, 0xe7, 0xe0];
const ACCENT = [0x10, 0x60, 0x4a];

/** Quatre points par pixel, dans chaque sens : le filet reste net. */
const SUR = 4;

/**
 * Deux cercles qui se recouvrent, traces au meme filet que la page,
 * l'intersection remplie a l'accent. Ce sont les seules courbes de tout Bublee.
 */
function marque(taille, { fond = PAPIER, part = 0.82 } = {}) {
  const px = Buffer.alloc(taille * taille * 4);
  // Le dessin vit dans un carre de 30 x 20 comme dans le SVG de la page ;
  // on le pose au centre, `part` disant quelle largeur il occupe.
  const echelle = taille / 30 * part;
  const dx = taille / 2 - 15 * echelle;
  const dy = taille / 2 - 10 * echelle;
  const rayon = 8.2 * echelle;
  const filet = Math.max(1.4, 1.15 * echelle);
  const centres = [[9.8 * echelle + dx, 10 * echelle + dy], [20.2 * echelle + dx, 10 * echelle + dy]];

  for (let y = 0; y < taille; y++) {
    for (let x = 0; x < taille; x++) {
      let encre = 0;
      let lentille = 0;
      for (let sy = 0; sy < SUR; sy++) {
        for (let sx = 0; sx < SUR; sx++) {
          const px2 = x + (sx + 0.5) / SUR;
          const py2 = y + (sy + 0.5) / SUR;
          let surUnTrait = false;
          let dedans = 0;
          for (const [cx, cy] of centres) {
            const d = Math.hypot(px2 - cx, py2 - cy);
            if (Math.abs(d - rayon) <= filet / 2) surUnTrait = true;
            if (d <= rayon) dedans++;
          }
          if (surUnTrait) encre++;
          else if (dedans === 2) lentille++;
        }
      }
      const total = SUR * SUR;
      const i = (y * taille + x) * 4;
      const melange = (a, b, t) => Math.round(a + (b - a) * t);
      let couleur = fond;
      if (lentille) couleur = [0, 1, 2].map((c) => melange(fond[c], ACCENT[c], lentille / total));
      if (encre) couleur = [0, 1, 2].map((c) => melange(couleur[c], ENCRE[c], encre / total));
      px[i] = couleur[0]; px[i + 1] = couleur[1]; px[i + 2] = couleur[2]; px[i + 3] = 255;
    }
  }
  return png(taille, taille, px);
}

for (const taille of [192, 512]) {
  fs.writeFileSync(path.join(dossier, `bublee-${taille}.png`), marque(taille));
  console.log(`public/icones/bublee-${taille}.png`);
}

// L'icone « masquable » d'Android est rognee, parfois en cercle : le dessin
// ne doit occuper que les quatre cinquiemes du centre, sur un fond plein.
fs.writeFileSync(path.join(dossier, 'bublee-masquable.png'), marque(512, { part: 0.58 }));
console.log('public/icones/bublee-masquable.png');
