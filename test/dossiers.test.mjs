import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'bublee-dossiers-'));
process.env.BUBLEE_DATA = dossier;

const store = await import('../server/store.js');
const { db, synchroniserDossiers } = await import('../server/db.js');
const comptes = await import('../server/comptes.js');
const { importOpml } = await import('../server/opml.js');

const nouveauCompte = async (email) => (await comptes.creerCompte({ email, motDePasse: 'un-mot-de-passe-long' })).id;

const source = (u, url, folder = '') => Number(db.prepare(
  'INSERT INTO feeds (url, title, folder, created_at, user_id) VALUES (?, ?, ?, ?, ?)'
).run(url, 'Source', folder, Date.now(), u).lastInsertRowid);

const noms = (u) => store.listFolders(u).map((d) => d.name);
const dossierDe = (id) => db.prepare('SELECT folder FROM feeds WHERE id = ?').get(id).folder;

test('un nouveau compte n a aucun dossier', async () => {
  const u = await nouveauCompte('neuf@bublee.test');
  assert.deepEqual(store.listFolders(u), []);
});

test('un dossier se cree vide, une seule fois, et un nom vide est refuse', async () => {
  const u = await nouveauCompte('creer@bublee.test');
  assert.deepEqual(store.creerDossier('  Philosophie   antique ', u), { name: 'Philosophie antique', feeds: 0 });
  store.creerDossier('Philosophie antique', u);
  assert.deepEqual(noms(u), ['Philosophie antique']);
  assert.throws(() => store.creerDossier('   ', u), /vide/);
});

test('ranger une source dans un dossier, a la main ou par OPML, l inscrit dans la liste', async () => {
  const u = await nouveauCompte('ranger@bublee.test');
  const id = source(u, 'https://tech.test/rss');
  store.updateFeed(id, { folder: ' Tech ' }, u);
  assert.equal(dossierDe(id), 'Tech');

  importOpml(`<?xml version="1.0"?><opml version="2.0"><body>
    <outline text="Culture"><outline type="rss" text="Revue" xmlUrl="https://culture.test/rss"/></outline>
  </body></opml>`, {}, u);

  assert.deepEqual(store.listFolders(u), [{ name: 'Culture', feeds: 1 }, { name: 'Tech', feeds: 1 }]);
});

test('renommer emmene les sources ; vers un nom existant, les deux fusionnent', async () => {
  const u = await nouveauCompte('renommer@bublee.test');
  const a = source(u, 'https://a.test/rss', 'Actu');
  const b = source(u, 'https://b.test/rss', 'Monde');
  synchroniserDossiers(u);

  assert.equal(store.renommerDossier('Actu', 'Actualités', u), 1);
  assert.equal(dossierDe(a), 'Actualités');
  assert.deepEqual(noms(u), ['Actualités', 'Monde']);

  store.renommerDossier('Monde', 'Actualités', u);
  assert.equal(dossierDe(b), 'Actualités');
  assert.deepEqual(store.listFolders(u), [{ name: 'Actualités', feeds: 2 }]);
});

test('supprimer un dossier garde ses sources, sans dossier, et il ne revient pas', async () => {
  const u = await nouveauCompte('supprimer@bublee.test');
  const id = source(u, 'https://idees.test/rss', 'Idées');
  synchroniserDossiers(u);

  assert.deepEqual(store.supprimerDossier('Idées', u), { sorties: 1 });
  assert.equal(dossierDe(id), '');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM feeds WHERE id = ?').get(id).n, 1);

  synchroniserDossiers();
  assert.deepEqual(noms(u), []);
});

test('un dossier inconnu repond introuvable, a la suppression comme au renommage', async () => {
  const u = await nouveauCompte('inconnu@bublee.test');
  assert.throws(() => store.supprimerDossier('Nulle part', u), (e) => e.status === 404);
  assert.throws(() => store.renommerDossier('Nulle part', 'Ailleurs', u), (e) => e.status === 404);
  assert.throws(() => store.supprimerDossier('', u), (e) => e.status === 404);
});

test('deux comptes gardent chacun leurs dossiers', async () => {
  const alice = await nouveauCompte('alice-dossiers@bublee.test');
  const bob = await nouveauCompte('bob-dossiers@bublee.test');
  store.creerDossier('Tech', alice);
  const deBob = source(bob, 'https://bob.test/rss', 'Tech');
  synchroniserDossiers(bob);

  store.supprimerDossier('Tech', alice);
  assert.deepEqual(noms(alice), []);
  assert.deepEqual(noms(bob), ['Tech']);
  assert.equal(dossierDe(deBob), 'Tech');
  assert.throws(() => store.renommerDossier('Tech', 'Volé', alice), (e) => e.status === 404);
});

test('une base d avant la liste retrouve les dossiers de ses sources', async () => {
  const u = await nouveauCompte('ancienne@bublee.test');
  source(u, 'https://vieux.test/rss', 'Archives');
  db.prepare('DELETE FROM folders WHERE user_id = ?').run(u);

  assert.ok(synchroniserDossiers() >= 1);
  assert.deepEqual(noms(u), ['Archives']);
});
