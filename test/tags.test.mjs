import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'bublee-tags-'));
process.env.BUBLEE_DATA = dossier;

const store = await import('../server/store.js');
const { db } = await import('../server/db.js');


// Depuis les comptes, tout appartient a quelqu'un : on cree le porteur des
// fixtures avant d'inserer quoi que ce soit.
const U = Number(db.prepare(
  "INSERT INTO users (email, nom, mot_de_passe, role, created_at) VALUES (?, ?, ?, 'super', ?)"
).run('essai@bublee.test', 'Essai', 'x', Date.now()).lastInsertRowid);

const fluxA = Number(db.prepare('INSERT INTO feeds (url, title, created_at, user_id) VALUES (?, ?, ?, ?)')
  .run('https://a.test/rss', 'A', Date.now(), U).lastInsertRowid);
const fluxB = Number(db.prepare('INSERT INTO feeds (url, title, created_at, user_id) VALUES (?, ?, ?, ?)')
  .run('https://b.test/rss', 'B', Date.now(), U).lastInsertRowid);

let n = 0;
function article(surcharge = {}) {
  n++;
  return {
    guid: 'g' + n,
    url: 'https://a.test/' + n,
    title: 'Un titre suffisamment long pour être comparable numéro ' + n,
    author: null,
    summary: 'resume',
    content: '<p>contenu</p>',
    image: null,
    published_at: Date.parse('2026-05-04T10:00:00Z'),
    duration: null,
    word_count: 120,
    ...surcharge
  };
}

function premierId() {
  return db.prepare('SELECT id FROM articles ORDER BY id LIMIT 1').get().id;
}

test('poser une étiquette la crée et la teinte', () => {
  store.saveItems(fluxA, [article()], U);
  const a = store.tagArticle(premierId(), { add: ['veille IA'] }, U);
  assert.deepEqual(a.tags, ['veille IA']);

  const tags = store.listTags(U);
  assert.equal(tags.length, 1);
  assert.equal(tags[0].count, 1);
  assert.ok(store.PALETTE_TAGS.includes(tags[0].color), 'une teinte de la palette est attribuée');
});

test('les étiquettes se cumulent et se retirent', () => {
  const id = premierId();
  store.tagArticle(id, { add: ['à lire', 'urgent'] }, U);
  assert.deepEqual(store.getArticle(id, U).tags, ['à lire', 'urgent', 'veille IA']);

  store.tagArticle(id, { remove: ['urgent'] }, U);
  assert.deepEqual(store.getArticle(id, U).tags, ['à lire', 'veille IA']);

  store.tagArticle(id, { set: ['seule'] }, U);
  assert.deepEqual(store.getArticle(id, U).tags, ['seule']);
});

test('un nom se compare sans casse ni espaces superflus', () => {
  const id = premierId();
  // « veille IA » existe déjà : les variantes de casse et d'espacement la
  // retrouvent au lieu d'en créer une jumelle, et son orthographe est gardée.
  store.tagArticle(id, { set: ['  Veille   IA  '] }, U);
  assert.deepEqual(store.getArticle(id, U).tags, ['veille IA']);

  store.tagArticle(id, { add: ['veille ia'] }, U);
  assert.equal(store.getArticle(id, U).tags.length, 1, 'même étiquette, pas de doublon');
  assert.equal(store.listTags(U).filter((t) => /veille/i.test(t.name)).length, 1);
});

test('la requête filtre sur une étiquette, et exige les deux quand on en donne deux', () => {
  db.exec('DELETE FROM article_tags');
  store.saveItems(fluxA, [article(), article()], U);
  const [un, deux] = db.prepare('SELECT id FROM articles ORDER BY id LIMIT 2').all().map((r) => r.id);

  store.tagArticle(un, { set: ['tech', 'à lire'] }, U);
  store.tagArticle(deux, { set: ['tech'] }, U);

  assert.equal(store.queryArticles({ view: 'all', tag: 'tech', limit: 50 }, U).articles.length, 2);
  assert.equal(store.queryArticles({ view: 'all', tag: 'à lire', limit: 50 }, U).articles.length, 1);
  assert.equal(store.queryArticles({ view: 'all', tag: 'tech,à lire', limit: 50 }, U).articles.length, 1);
  assert.equal(store.queryArticles({ view: 'all', tag: ['tech', 'inconnue'], limit: 50 }, U).articles.length, 0);
});

test('une étiquette suit le groupe de doublons', () => {
  db.exec('DELETE FROM articles; DELETE FROM article_tags');
  const url = 'https://presse.test/reprise';
  const titre = 'Une dépêche que deux rédactions publient le même jour';
  store.saveItems(fluxA, [article({ guid: 'a1', url, title: titre })], U);
  store.saveItems(fluxB, [article({ guid: 'b1', url, title: titre })], U);

  const original = db.prepare('SELECT id FROM articles WHERE guid = ?').get('a1').id;
  const copie = db.prepare('SELECT id FROM articles WHERE guid = ?').get('b1').id;

  store.tagArticle(original, { add: ['suivi'] }, U);
  assert.deepEqual(store.getArticle(copie, U).tags, ['suivi'], 'la copie porte la même étiquette');
});

test('renommer sur un nom existant fusionne les deux étiquettes', () => {
  db.exec('DELETE FROM articles; DELETE FROM article_tags; DELETE FROM tags');
  store.saveItems(fluxA, [article(), article()], U);
  const [un, deux] = db.prepare('SELECT id FROM articles ORDER BY id LIMIT 2').all().map((r) => r.id);

  store.tagArticle(un, { set: ['ia'] }, U);
  store.tagArticle(deux, { set: ['intelligence artificielle'] }, U);

  const source = store.listTags(U).find((t) => t.name === 'ia');
  const fusionnee = store.updateTag(source.id, { name: 'intelligence artificielle' }, U);

  assert.equal(fusionnee.name, 'intelligence artificielle');
  assert.equal(store.listTags(U).length, 1);
  assert.equal(store.listTags(U)[0].count, 2);
});

test('une étiquette vide survit — c’est l’utilisateur qui la supprime', () => {
  db.exec('DELETE FROM article_tags');
  assert.equal(store.listTags(U)[0].count, 0, 'plus aucun article, mais l’étiquette reste');

  const id = store.listTags(U)[0].id;
  assert.equal(store.deleteTag(id, U), true);
  assert.equal(store.listTags(U).length, 0);
});

test('une teinte hors palette est refusée', () => {
  const cree = store.createTag('couleurs', U);
  store.updateTag(cree.id, { color: 'javascript:alert(1)' }, U);
  assert.equal(store.listTags(U).find((t) => t.name === 'couleurs').color, null);

  store.updateTag(cree.id, { color: store.PALETTE_TAGS[2] }, U);
  assert.equal(store.listTags(U).find((t) => t.name === 'couleurs').color, store.PALETTE_TAGS[2]);
});

test.after(() => {
  db.close();
  fs.rmSync(dossier, { recursive: true, force: true });
});
