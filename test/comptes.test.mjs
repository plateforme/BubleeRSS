import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'bublee-comptes-'));
process.env.BUBLEE_DATA = dossier;

const comptes = await import('../server/comptes.js');
const store = await import('../server/store.js');
const { db } = await import('../server/db.js');

const greg = await comptes.creerCompte({
  email: 'Greg@Bublee.test', nom: 'Greg', motDePasse: 'un-mot-de-passe-long', role: 'super'
});
const alice = await comptes.creerCompte({
  email: 'alice@bublee.test', nom: 'Alice', motDePasse: 'le-mot-de-passe-alice'
});

/* Chaque compte reçoit la même source et le même article : si l'isolation
   tenait par hasard — noms différents, identifiants décalés — on ne le verrait
   pas. Là, seule la propriété peut les distinguer. */
const creerFlux = (userId, titre) => Number(db.prepare(
  'INSERT INTO feeds (url, title, folder, created_at, user_id) VALUES (?, ?, ?, ?, ?)'
).run('https://presse.test/rss', titre, 'Actualité', Date.now(), userId).lastInsertRowid);

const fluxGreg = creerFlux(greg.id, 'La même source');
const fluxAlice = creerFlux(alice.id, 'La même source');

let n = 0;
const article = (surcharge = {}) => ({
  guid: 'g' + ++n,
  url: 'https://presse.test/article-' + n,
  title: 'Un titre assez long pour être comparable, numéro ' + n,
  author: null, summary: 'résumé', content: '<p>Le mot sardine est dans le corps.</p>',
  image: null, published_at: Date.parse('2026-05-04T10:00:00Z') - n * 60000,
  duration: null, word_count: 120,
  ...surcharge
});

store.saveItems(fluxGreg, [article(), article()], greg.id);
store.saveItems(fluxAlice, [article(), article(), article()], alice.id);
store.createTag('veille', greg.id);
store.createTag('veille', alice.id);   // le même nom, chez les deux

/* ------------------------------------------------------- mots de passe --- */

test('un mot de passe se vérifie, et rien d’autre ne passe', async () => {
  const h = await comptes.empreinte('correct horse battery staple');
  assert.ok(await comptes.verifierMotDePasse('correct horse battery staple', h));
  assert.equal(await comptes.verifierMotDePasse('Correct horse battery staple', h), false);
  assert.equal(await comptes.verifierMotDePasse('', h), false);
  // Une empreinte abîmée ne doit jamais valider, ni lever.
  assert.equal(await comptes.verifierMotDePasse('x', 'nawak'), false);
  assert.equal(await comptes.verifierMotDePasse('x', ''), false);
});

test('deux empreintes du même mot de passe diffèrent', async () => {
  const [a, b] = [await comptes.empreinte('le même mot de passe'), await comptes.empreinte('le même mot de passe')];
  assert.notEqual(a, b, 'le sel doit être tiré à chaque fois');
});

test('un mot de passe trop court est refusé', async () => {
  await assert.rejects(
    () => comptes.creerCompte({ email: 'court@bublee.test', motDePasse: 'court' }),
    /au moins 10 caractères/
  );
});

test('l’adresse ne distingue pas la casse', () => {
  assert.equal(comptes.compteParEmail('GREG@BUBLEE.TEST').id, greg.id);
});

/* ------------------------------------------------------------- sessions --- */

test('une session s’ouvre, s’identifie et se ferme', () => {
  const jeton = comptes.ouvrirSession(alice.id);
  assert.equal(comptes.compteDeSession(jeton).id, alice.id);
  assert.ok(comptes.fermerSession(jeton));
  assert.equal(comptes.compteDeSession(jeton), null, 'fermée, elle n’identifie plus');
});

test('une session expirée n’identifie plus', () => {
  const jeton = comptes.ouvrirSession(alice.id);
  db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1000, alice.id);
  assert.equal(comptes.compteDeSession(jeton), null);
});

test('suspendre un compte ferme ses sessions', async () => {
  const jeton = comptes.ouvrirSession(alice.id);
  assert.ok(comptes.compteDeSession(jeton));
  await comptes.modifierCompte(alice.id, { actif: false }, { parSuper: true });
  assert.equal(comptes.compteDeSession(jeton), null);
  await comptes.modifierCompte(alice.id, { actif: true }, { parSuper: true });
});

test('la base ne garde pas le jeton en clair', () => {
  const jeton = comptes.ouvrirSession(greg.id);
  const lignes = db.prepare('SELECT token_hash FROM sessions').all();
  assert.ok(lignes.every((l) => l.token_hash !== jeton), 'seule l’empreinte est stockée');
  comptes.fermerSession(jeton);
});

/* ----------------------------------------------------------------- rôles --- */

test('un éditeur ne peut pas se donner de rôle', async () => {
  await assert.rejects(() => comptes.modifierCompte(alice.id, { role: 'super' }), /super-utilisateur/);
});

test('le dernier super ne peut être ni rétrogradé, ni suspendu, ni supprimé', async () => {
  await assert.rejects(() => comptes.modifierCompte(greg.id, { role: 'editeur' }, { parSuper: true }), /dernier super/);
  await assert.rejects(() => comptes.modifierCompte(greg.id, { actif: false }, { parSuper: true }), /dernier super/);
  assert.throws(() => comptes.supprimerCompte(greg.id), /dernier super/);
});

/* ------------------------------------------------------------ isolation --- */

test('chacun ne voit que ses propres sources', () => {
  assert.deepEqual(store.listFeeds(greg.id).map((f) => f.id), [fluxGreg]);
  assert.deepEqual(store.listFeeds(alice.id).map((f) => f.id), [fluxAlice]);
});

test('chacun ne voit que ses propres articles', () => {
  const chez = (u) => store.queryArticles({ view: 'all', limit: 50 }, u).articles;
  assert.equal(chez(greg.id).length, 2);
  assert.equal(chez(alice.id).length, 3);
  const idsGreg = new Set(chez(greg.id).map((a) => a.id));
  assert.ok(chez(alice.id).every((a) => !idsGreg.has(a.id)), 'aucun article commun');
});

test('les compteurs ne comptent que le sien', () => {
  assert.equal(store.counts(greg.id).total, 2);
  assert.equal(store.counts(alice.id).total, 3);
});

test('on ne peut pas lire l’article d’un autre par son identifiant', () => {
  const [chezAlice] = store.queryArticles({ view: 'all', limit: 1 }, alice.id).articles;
  assert.ok(chezAlice);
  assert.equal(store.getArticle(chezAlice.id, greg.id), null, 'invisible depuis l’autre compte');
  assert.equal(store.getArticle(chezAlice.id, alice.id).id, chezAlice.id);
});

test('on ne peut pas modifier l’article d’un autre', () => {
  const [chezAlice] = store.queryArticles({ view: 'all', limit: 1 }, alice.id).articles;
  assert.throws(() => store.setRead(chezAlice.id, true, greg.id), /introuvable/);
  assert.throws(() => store.setStarred(chezAlice.id, true, greg.id), /introuvable/);
  assert.throws(() => store.tagArticle(chezAlice.id, { add: ['vol'] }, greg.id), /introuvable/);
  assert.equal(db.prepare('SELECT read_at FROM articles WHERE id = ?').get(chezAlice.id).read_at, null);
});

test('on ne peut ni modifier ni supprimer la source d’un autre', () => {
  assert.throws(() => store.updateFeed(fluxAlice, { folder: 'Volé' }, greg.id), /introuvable/);
  assert.equal(store.deleteFeed(fluxAlice, greg.id), false);
  assert.equal(db.prepare('SELECT folder FROM feeds WHERE id = ?').get(fluxAlice).folder, 'Actualité');
});

test('deux comptes peuvent porter la même étiquette sans se mélanger', () => {
  const chezGreg = store.listTags(greg.id);
  const chezAlice = store.listTags(alice.id);
  assert.deepEqual(chezGreg.map((t) => t.name), ['veille']);
  assert.deepEqual(chezAlice.map((t) => t.name), ['veille']);
  assert.notEqual(chezGreg[0].id, chezAlice[0].id, 'ce sont deux étiquettes distinctes');
  assert.equal(store.deleteTag(chezAlice[0].id, greg.id), false, 'et on ne supprime pas celle de l’autre');
});

test('la recherche ne traverse pas les comptes', () => {
  // « sardine » est dans le corps des articles des deux comptes.
  assert.equal(store.queryArticles({ view: 'all', q: 'sardine', limit: 50 }, greg.id).articles.length, 2);
  assert.equal(store.queryArticles({ view: 'all', q: 'sardine', limit: 50 }, alice.id).articles.length, 3);
});

test('marquer tout lu ne touche que son propre compte', () => {
  store.markRead({ all: true }, greg.id);
  assert.equal(store.counts(greg.id).unread, 0);
  assert.equal(store.counts(alice.id).unread, 3, 'l’autre compte n’a pas bougé');
});

test('la déduplication ne rapproche pas les articles de deux comptes', () => {
  // Les deux comptes ont des articles au même titre et à la même adresse.
  const memeUrl = 'https://presse.test/histoire-commune';
  const memeTitre = 'Une histoire que les deux comptes reçoivent le même jour';
  store.saveItems(fluxGreg, [article({ guid: 'commun-g', url: memeUrl, title: memeTitre })], greg.id);
  store.saveItems(fluxAlice, [article({ guid: 'commun-a', url: memeUrl, title: memeTitre })], alice.id);

  const g = db.prepare('SELECT id, dupe_of FROM articles WHERE guid = ?').get('commun-g');
  const a = db.prepare('SELECT id, dupe_of FROM articles WHERE guid = ?').get('commun-a');
  assert.equal(g.dupe_of, null);
  assert.equal(a.dupe_of, null, 'chacun garde son exemplaire, ce ne sont pas des doublons');
});

test('supprimer un compte emporte tout ce qui lui appartient', async () => {
  const jetable = await comptes.creerCompte({ email: 'jetable@bublee.test', motDePasse: 'mot-de-passe-jetable' });
  const flux = creerFlux(jetable.id, 'Éphémère');
  store.saveItems(flux, [article(), article()], jetable.id);
  store.createTag('à jeter', jetable.id);

  assert.equal(store.counts(jetable.id).total, 2);
  assert.ok(comptes.supprimerCompte(jetable.id));

  assert.equal(db.prepare('SELECT COUNT(*) n FROM feeds WHERE user_id = ?').get(jetable.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM articles WHERE feed_id = ?').get(flux).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tags WHERE user_id = ?').get(jetable.id).n, 0);
});

test('sans compte, le store refuse de répondre', () => {
  assert.throws(() => store.listFeeds(), /Compte manquant/);
  assert.throws(() => store.counts(null), /Compte manquant/);
  assert.throws(() => store.queryArticles({}, 0), /Compte manquant/);
});
