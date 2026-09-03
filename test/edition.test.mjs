import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'bublee-edition-'));
process.env.BUBLEE_DATA = dossier;

const edition = await import('../server/edition.js');
const store = await import('../server/store.js');
const comptes = await import('../server/comptes.js');
const { db } = await import('../server/db.js');

const moi = await comptes.creerCompte({ email: 'e@bublee.test', motDePasse: 'dix-caracteres-au-moins', role: 'super' });

const creerFlux = (titre, priorite = 'suivi') => Number(db.prepare(
  'INSERT INTO feeds (url, title, folder, created_at, user_id, priority) VALUES (?, ?, ?, ?, ?, ?)'
).run('https://' + titre + '.test/rss', titre, '', Date.now(), moi.id, priorite).lastInsertRowid);

/* ------------------------------------------------------ la composition */

test('minutesDe : la durée d’un épisode, sinon le temps de lecture', () => {
  assert.equal(edition.minutesDe({ duration: 2400 }), 40);
  assert.equal(edition.minutesDe({ word_count: 2300 }), 10);
  assert.equal(edition.minutesDe({ word_count: 12 }), 1, 'jamais moins d’une minute');
});

test('l’édition tourne d’une source à l’autre au lieu de vider la plus bavarde', () => {
  const articles = [];
  // Une source publie quarante fois, deux autres une seule.
  for (let i = 0; i < 40; i++) articles.push({ id: 100 + i, feed_id: 1, published_at: 5000 - i, word_count: 500 });
  articles.push({ id: 900, feed_id: 2, published_at: 4000, word_count: 500 });
  articles.push({ id: 901, feed_id: 3, published_at: 3000, word_count: 500 });

  const { articles: pris } = edition.composer(articles);
  const sources = new Set(pris.map((a) => a.feed_id));
  assert.ok(sources.has(2) && sources.has(3), 'les sources discrètes ont leur place');
  const deLaBavarde = pris.filter((a) => a.feed_id === 1).length;
  assert.ok(deLaBavarde <= 2, `la bavarde n’occupe pas l’édition (${deLaBavarde} articles)`);
});

test('l’édition vise une durée, et s’arrête', () => {
  const articles = [];
  for (let i = 0; i < 40; i++) articles.push({ id: i + 1, feed_id: i + 1, published_at: 9000 - i, word_count: 2300 });
  const { articles: pris, minutes } = edition.composer(articles, { minutes: 45, maximum: 15 });
  assert.ok(pris.length <= 15);
  assert.ok(minutes <= 55, `on ne dépasse pas franchement la cible (${minutes} min)`);
  assert.ok(minutes >= 40, `et on la remplit (${minutes} min)`);
});

test('un article long entre quand même dans une édition presque vide', () => {
  const { articles: pris } = edition.composer(
    [{ id: 1, feed_id: 1, published_at: 2, word_count: 40000 }, { id: 2, feed_id: 2, published_at: 1, word_count: 200 }],
    { minutes: 45, maximum: 15 }
  );
  assert.ok(pris.some((a) => a.id === 1), 'une enquête de trois heures n’est pas exclue d’office');
});

test('l’édition se lit dans l’ordre de publication', () => {
  const { articles: pris } = edition.composer([
    { id: 1, feed_id: 1, published_at: 100, word_count: 200 },
    { id: 2, feed_id: 2, published_at: 300, word_count: 200 },
    { id: 3, feed_id: 3, published_at: 200, word_count: 200 }
  ]);
  assert.deepEqual(pris.map((a) => a.id), [2, 3, 1]);
});

/* ------------------------------------------------------- sur la base */

test('l’édition du jour se compose une fois, puis ne bouge plus', () => {
  const a = creerFlux('presse');
  const b = creerFlux('revue');
  let n = 0;
  const item = (feed) => ({
    guid: 'g' + ++n, url: 'https://x.test/a' + n, title: 'Un titre bien assez long pour compter ' + n,
    author: null, summary: '', content: '<p>x</p>', image: null,
    published_at: Date.now() - n * 60000, duration: null, word_count: 400
  });
  store.saveItems(a, [item(), item(), item()], moi.id);
  store.saveItems(b, [item(), item()], moi.id);

  const premiere = edition.editionDuJour(moi.id);
  assert.ok(premiere.composee);
  assert.ok(premiere.ids.length > 0);

  // Un article de plus arrive : l'édition d'aujourd'hui ne s'en trouve pas
  // changée, c'est tout son intérêt.
  store.saveItems(a, [item()], moi.id);
  const seconde = edition.editionDuJour(moi.id);
  assert.equal(seconde.composee, false);
  assert.deepEqual(seconde.ids, premiere.ids);
});

test('la vue « édition » rend la liste close, et annonce ce qu’elle demande', () => {
  const r = store.queryArticles({ view: 'edition', limit: 30 }, moi.id);
  assert.ok(r.edition);
  assert.equal(r.edition.total, r.articles.length);
  assert.equal(r.edition.restants, r.articles.length, 'rien n’est encore lu');
  assert.ok(r.edition.minutes > 0);
  assert.equal(r.nextCursor, null, 'une édition ne se pagine pas');

  // Un article lu reste dans l'édition : la pile ne fond pas sous les yeux.
  store.setRead(r.articles[0].id, true, moi.id);
  const apres = store.queryArticles({ view: 'edition', limit: 30 }, moi.id);
  assert.equal(apres.articles.length, r.articles.length);
  assert.equal(apres.edition.restants, r.edition.restants - 1);
});

test('les compteurs portent ce qu’il reste de l’édition', () => {
  const c = store.counts(moi.id);
  assert.equal(c.edition, store.queryArticles({ view: 'edition', limit: 30 }, moi.id).edition.restants);
});

test('une source en survol n’entre pas dans l’édition', () => {
  const discrete = creerFlux('discrete', 'survol');
  store.saveItems(discrete, [{
    guid: 'survol-1', url: 'https://d.test/1', title: 'Un article d’une source en survol, assez long',
    author: null, summary: '', content: '<p>x</p>', image: null,
    published_at: Date.now(), duration: null, word_count: 300
  }], moi.id);

  const { ids } = edition.editionDuJour(moi.id, { refaire: true });
  const dansLEdition = db.prepare(
    `SELECT feed_id FROM articles WHERE id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids).map((r) => r.feed_id);
  assert.ok(!dansLEdition.includes(discrete), 'le survol reste hors de l’édition');
});

test('une édition composée vide ne gèle pas la journée : elle se recompose', async () => {
  // Un compte à part, pour maîtriser ce qu'il a à lire.
  const seul = await comptes.creerCompte({ email: 'vide@bublee.test', motDePasse: 'dix-caracteres-au-moins', role: 'super' });
  const flux = Number(db.prepare(
    'INSERT INTO feeds (url, title, folder, created_at, user_id, priority) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('https://vide.test/rss', 'vide', '', Date.now(), seul.id, 'suivi').lastInsertRowid);

  // Première demande du jour, sans aucun article : l'édition se compose vide
  // et se met en cache — c'est le moment qui, en prod, tombait juste après un
  // redémarrage, avant l'arrivée des articles frais.
  const avant = edition.editionDuJour(seul.id);
  assert.equal(avant.ids.length, 0, 'rien à composer pour l’instant');

  // Les articles arrivent ensuite.
  store.saveItems(flux, [{
    guid: 'tardif-1', url: 'https://vide.test/1', title: 'Un article arrivé après la première demande, bien assez long',
    author: null, summary: '', content: '<p>x</p>', image: null,
    published_at: Date.now(), duration: null, word_count: 400
  }], seul.id);

  // Sans refaire : l'édition doit maintenant les voir, pas rester gelée vide.
  const apres = edition.editionDuJour(seul.id);
  assert.ok(apres.ids.length > 0, 'l’édition se recompose au lieu de rester vide toute la journée');
});
