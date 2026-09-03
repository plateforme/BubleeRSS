import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'bublee-cache-'));
process.env.BUBLEE_DATA = dossier;
// Un plafond minuscule : l'éviction doit se déclencher sans écrire 512 Mo.
process.env.BUBLEE_IMG_CACHE_MB = '16';

const cache = await import('../server/cache-images.js');

const image = (n, octet = 0x41) => Buffer.alloc(n, octet);

test('une image rangée se relit à l’identique, type compris', async () => {
  const url = 'https://exemple.test/photo.jpg';
  assert.equal(await cache.lire(url), null, 'rien avant de ranger');

  assert.equal(await cache.ranger(url, 'image/jpeg', image(64)), true);
  const relu = await cache.lire(url);
  assert.equal(relu.type, 'image/jpeg');
  assert.deepEqual(relu.corps, image(64));
});

test('deux adresses ne se marchent pas dessus', async () => {
  await cache.ranger('https://exemple.test/a.png', 'image/png', image(10, 0x01));
  await cache.ranger('https://exemple.test/b.png', 'image/png', image(10, 0x02));
  assert.deepEqual((await cache.lire('https://exemple.test/a.png')).corps, image(10, 0x01));
  assert.deepEqual((await cache.lire('https://exemple.test/b.png')).corps, image(10, 0x02));
});

test('l’adresse ne devient jamais un chemin', async () => {
  // Une adresse pleine de « .. » et de séparateurs ne doit pas sortir du dossier.
  const vicieuse = 'https://exemple.test/../../../etc/passwd?x=/../../a';
  await cache.ranger(vicieuse, 'image/png', image(8));
  const fichiers = await fsp.readdir(path.join(dossier, 'cache-images'));
  assert.ok(fichiers.every((f) => /^[0-9a-f]{64}$/.test(f)), 'les noms sont des empreintes, rien d’autre');
  assert.deepEqual((await cache.lire(vicieuse)).corps, image(8));
});

test('ce qui n’est pas une image est refusé', async () => {
  assert.equal(await cache.ranger('https://exemple.test/x', 'text/html', image(10)), false);
  assert.equal(await cache.ranger('https://exemple.test/y', 'image/png', Buffer.alloc(0)), false);
  assert.equal(await cache.lire('https://exemple.test/x'), null);
});

test('un fichier abîmé est ignoré plutôt que servi', async () => {
  const url = 'https://exemple.test/abime.jpg';
  const marque = Buffer.from('abime-marque-unique');
  await cache.ranger(url, 'image/jpeg', marque);

  /* On retrouve le fichier par son contenu, pas par son rang dans le dossier :
     l'empreinte est un détail interne, et le premier fichier venu n'est pas
     forcément le nôtre. */
  const dir = path.join(dossier, 'cache-images');
  const fichiers = await fsp.readdir(dir);
  let cible = null;
  for (const f of fichiers) {
    const contenu = await fsp.readFile(path.join(dir, f)).catch(() => null);
    if (contenu?.includes(marque)) { cible = path.join(dir, f); break; }
  }
  assert.ok(cible, 'le fichier rangé se retrouve');

  // On écrase par un contenu sans en-tête de type.
  await fsp.writeFile(cible, Buffer.alloc(200, 0xff));
  assert.equal(await cache.lire(url), null);
});

test('le balayage ramène le cache sous son plafond, les plus vieux d’abord', async () => {
  const dir = path.join(dossier, 'cache-images');
  for (const f of await fsp.readdir(dir)) await fsp.unlink(path.join(dir, f));

  // 24 Mo dans un cache plafonné à 16 : il doit en rester au plus 90 %.
  const unMo = image(1024 * 1024);
  for (let i = 0; i < 24; i++) {
    const avantEcriture = new Set(await fsp.readdir(dir));
    await cache.ranger(`https://exemple.test/gros-${i}.jpg`, 'image/jpeg', unMo);
    // Dates d'accès croissantes, pour que l'ordre d'éviction soit déterminé.
    // On repère le fichier qui vient d'apparaître, pas le premier venu.
    const nouveau = (await fsp.readdir(dir)).find((n) => !avantEcriture.has(n));
    const quand = new Date(Date.now() - (24 - i) * 60000);
    await fsp.utimes(path.join(dir, nouveau), quand, quand);
  }

  const avant = await cache.etat();
  assert.ok(avant.mo > 16, `le cache doit avoir dépassé son plafond (${avant.mo} Mo)`);

  await cache.balayer(true);
  const apres = await cache.etat();
  assert.ok(apres.mo <= 16, `ramené sous le plafond, mesuré ${apres.mo} Mo`);
  assert.ok(apres.fichiers < avant.fichiers, 'des entrées ont bien été effacées');

  // La dernière rangée, donc la plus récemment vue, doit avoir survécu.
  assert.notEqual(await cache.lire('https://exemple.test/gros-23.jpg'), null);
});
