// Cache disque du relais d'images.
//
// Sans lui, chaque affichage d'une vignette repart chercher l'octet chez
// l'editeur : le fond d'attente reste en place le temps de l'aller-retour, et
// on refait le trajet a chaque fois que le cache du navigateur a expire ou
// qu'un autre appareil regarde la meme page. Avec lui, seule la premiere vue
// paie le voyage.
//
// Un fichier par image, nomme d'apres l'empreinte de son adresse — jamais
// d'apres l'adresse elle-meme, qui pourrait sortir du dossier. Le type MIME
// tient sur la premiere ligne du fichier, ce qui evite un index a tenir a jour
// et donc a desynchroniser.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MEGA = 1024 * 1024;

/** Taille maximale du cache. Au-dela, on efface les plus anciens acces. */
const PLAFOND = Math.max(16, Number(process.env.BUBLEE_IMG_CACHE_MB) || 512) * MEGA;

/** On ne balaie pas a chaque ecriture : ce serait lire tout le dossier a
    chaque vignette. Un passage toutes les dix minutes suffit largement. */
const PERIODE_BALAYAGE = 10 * 60 * 1000;

/** Rafraichir la date d'acces a chaque lecture couterait une ecriture par
    image affichee. Un jour de granularite suffit pour classer par anciennete. */
const GRANULARITE_ACCES = 24 * 60 * 60 * 1000;

// Meme emplacement que la base : le cache vit avec les donnees, et `data/`
// etant deja ignore par git, il n'a aucune chance de partir dans un commit.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dossier = path.join(process.env.BUBLEE_DATA || path.join(root, 'data'), 'cache-images');

fs.mkdirSync(dossier, { recursive: true });

const chemin = (url) => path.join(dossier, crypto.createHash('sha256').update(url).digest('hex'));

let dernierBalayage = 0;
let balayageEnCours = null;

/**
 * Ramene le cache sous son plafond en effacant les entrees les moins
 * recemment lues. On descend a 90 % pour ne pas rebalayer au fichier suivant.
 */
export async function balayer(force = false) {
  const maintenant = Date.now();
  if (!force && maintenant - dernierBalayage < PERIODE_BALAYAGE) return null;
  if (balayageEnCours) return balayageEnCours;
  dernierBalayage = maintenant;

  balayageEnCours = (async () => {
    const noms = await fsp.readdir(dossier).catch(() => []);
    const entrees = [];
    let total = 0;
    for (const nom of noms) {
      const s = await fsp.stat(path.join(dossier, nom)).catch(() => null);
      if (!s?.isFile()) continue;
      entrees.push({ nom, taille: s.size, vu: s.mtimeMs });
      total += s.size;
    }
    if (total <= PLAFOND) return { total, efface: 0, restant: entrees.length };

    entrees.sort((a, b) => a.vu - b.vu);              // les plus vieux d'abord
    let efface = 0;
    for (const e of entrees) {
      if (total <= PLAFOND * 0.9) break;
      await fsp.unlink(path.join(dossier, e.nom)).catch(() => {});
      total -= e.taille;
      efface++;
    }
    return { total, efface, restant: entrees.length - efface };
  })().finally(() => { balayageEnCours = null; });

  return balayageEnCours;
}

/** Rend `{ type, corps }` si l'image est en cache, sinon `null`. */
export async function lire(url) {
  const f = chemin(url);
  const brut = await fsp.readFile(f).catch(() => null);
  if (!brut) return null;

  const coupure = brut.indexOf(10);                   // le \n qui suit le type
  if (coupure < 1 || coupure > 120) return null;      // fichier abime : on l'ignore
  const type = brut.subarray(0, coupure).toString('latin1');
  if (!/^image\//i.test(type)) return null;

  // Marque l'acces, mais pas plus d'une fois par jour : c'est ce qui permet
  // au balayage d'effacer ce qu'on ne regarde plus.
  fsp.stat(f).then((s) => {
    if (Date.now() - s.mtimeMs > GRANULARITE_ACCES) return fsp.utimes(f, new Date(), new Date());
  }).catch(() => {});

  return { type, corps: brut.subarray(coupure + 1) };
}

/** Range une image. Ecriture dans un fichier temporaire puis renommage, pour
    qu'une lecture concurrente ne tombe jamais sur un fichier a moitie ecrit. */
export async function ranger(url, type, corps) {
  if (!/^image\//i.test(type) || !corps?.length) return false;
  const f = chemin(url);
  const tmp = f + '.' + process.pid + '.tmp';
  try {
    await fsp.writeFile(tmp, Buffer.concat([Buffer.from(type + '\n', 'latin1'), corps]));
    await fsp.rename(tmp, f);
  } catch {
    await fsp.unlink(tmp).catch(() => {});
    return false;
  }
  balayer().catch(() => {});
  return true;
}

/** Etat du cache, pour /api/health. */
export async function etat() {
  const noms = await fsp.readdir(dossier).catch(() => []);
  let octets = 0;
  let fichiers = 0;
  for (const nom of noms) {
    const s = await fsp.stat(path.join(dossier, nom)).catch(() => null);
    if (!s?.isFile()) continue;
    octets += s.size;
    fichiers++;
  }
  return { fichiers, mo: Math.round((octets / MEGA) * 10) / 10, plafondMo: Math.round(PLAFOND / MEGA) };
}

export const dossierCache = dossier;
