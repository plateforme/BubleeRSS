import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { urlKey, titleKey } from '../server/dedupe.js';

/* ------------------------------------------------------- cles de comparaison */

test('urlKey ignore le schema, le www, le fragment et le tracking', () => {
  const attendu = 'lemonde.fr/eco/article/2026/x_123.html?id=7';
  assert.equal(urlKey('https://WWW.Lemonde.fr/eco/article/2026/x_123.html?utm_source=rss&id=7#xtor=RSS-3'), attendu);
  assert.equal(urlKey('http://lemonde.fr/eco/article/2026/x_123.html?id=7'), attendu);
  assert.equal(urlKey('https://www.lemonde.fr/eco/article/2026/x_123.html?id=7&fbclid=abc'), attendu);
});

test('urlKey ramene les variantes AMP et mobile sur la page normale', () => {
  assert.equal(urlKey('https://m.exemple.fr/post/amp/'), 'exemple.fr/post');
  assert.equal(urlKey('https://exemple.fr/post/'), 'exemple.fr/post');
  assert.equal(urlKey('https://exemple.fr/post/index.html'), 'exemple.fr/post');
});

test('urlKey refuse ce qui n est pas une adresse web', () => {
  assert.equal(urlKey('urn:uuid:1234'), null);
  assert.equal(urlKey(''), null);
  assert.equal(urlKey('pas une url'), null);
});

test('urlKey garde les parametres qui identifient vraiment la page', () => {
  assert.notEqual(urlKey('https://site.fr/a?p=1'), urlKey('https://site.fr/a?p=2'));
});

test('titleKey neutralise accents, ponctuation et nom du site', () => {
  assert.equal(
    titleKey('Élection : la « surprise » du scrutin — Le Monde'),
    titleKey('Election: la surprise du scrutin | Numerama')
  );
});

test('titleKey distingue deux titres differents', () => {
  assert.notEqual(titleKey('La greve des trains continue'), titleKey('La greve des bus continue'));
});

/* ------------------------------------------- deduplication a l enregistrement */

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'bublee-test-'));
process.env.BUBLEE_DATA = dossier;

const store = await import('../server/store.js');
const { db } = await import('../server/db.js');

// Depuis les comptes, tout appartient a quelqu'un : on cree le porteur des
// fixtures avant d'inserer quoi que ce soit.
const U = Number(db.prepare(
  "INSERT INTO users (email, nom, mot_de_passe, role, created_at) VALUES (?, ?, ?, 'super', ?)"
).run('essai@bublee.test', 'Essai', 'x', Date.now()).lastInsertRowid);

let sequence = 0;
function article(surcharge = {}) {
  sequence++;
  return {
    guid: 'g' + sequence,
    url: 'https://presse.test/a/' + sequence,
    title: 'Un titre de longueur tout a fait respectable numero ' + sequence,
    author: null,
    summary: 'resume',
    content: '<p>contenu</p>',
    image: null,
    published_at: Date.parse('2026-05-04T10:00:00Z'),
    word_count: 120,
    ...surcharge
  };
}

function creerFlux(titre) {
  return Number(db.prepare(
    'INSERT INTO feeds (url, title, created_at, user_id) VALUES (?, ?, ?, ?)'
  ).run('https://presse.test/' + titre + '/rss', titre, Date.now(), U).lastInsertRowid);
}

const fluxA = creerFlux('A');
const fluxB = creerFlux('B');

test('un guid deja connu ne cree pas de seconde ligne', () => {
  const item = article({ guid: 'stable', url: 'https://presse.test/stable' });
  assert.deepEqual(store.saveItems(fluxA, [item], U), { ajoutes: 1, doublons: 0, filtres: 0 });
  assert.deepEqual(store.saveItems(fluxA, [item], U), { ajoutes: 0, doublons: 0, filtres: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM articles WHERE feed_id = ?').get(fluxA).n, 1);
});

test('meme flux, guid change, meme adresse : rien n est duplique', () => {
  const url = 'https://presse.test/republie?utm_source=rss';
  store.saveItems(fluxA, [article({ guid: 'v1', url, title: 'Un article republie par son editeur maladroit' })], U);
  const avant = db.prepare('SELECT COUNT(*) n FROM articles').get().n;

  const resultat = store.saveItems(fluxA, [article({
    guid: 'v2',
    url: 'https://presse.test/republie?utm_source=newsletter&fbclid=x',
    title: 'Un article republie par son editeur maladroit'
  })], U);

  assert.deepEqual(resultat, { ajoutes: 0, doublons: 1, filtres: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM articles').get().n, avant);
});

test('deux flux relaient la meme adresse : la copie est rattachee a l originale', () => {
  const url = 'https://presse.test/reprise';
  const titre = 'Une depeche reprise par plusieurs redactions du pays';
  store.saveItems(fluxA, [article({ guid: 'a-reprise', url, title: titre })], U);
  const resultat = store.saveItems(fluxB, [article({ guid: 'b-reprise', url: url + '?utm_medium=rss', title: titre })], U);

  assert.deepEqual(resultat, { ajoutes: 0, doublons: 1, filtres: 0 });

  const original = db.prepare('SELECT id FROM articles WHERE guid = ?').get('a-reprise');
  const copie = db.prepare('SELECT id, dupe_of FROM articles WHERE guid = ?').get('b-reprise');
  assert.equal(copie.dupe_of, original.id);
});

test('titre identique et dates proches suffisent quand l adresse differe', () => {
  const titre = 'Le conseil municipal vote enfin la renovation du vieux pont';
  store.saveItems(fluxA, [article({ guid: 'a-pont', url: 'https://a.test/pont', title: titre })], U);
  const resultat = store.saveItems(fluxB, [article({
    guid: 'b-pont',
    url: 'https://b.test/2026/pont-renove',
    title: titre + ' — Le Journal',
    published_at: Date.parse('2026-05-04T22:00:00Z')
  })], U);

  assert.deepEqual(resultat, { ajoutes: 0, doublons: 1, filtres: 0 });
  assert.ok(db.prepare('SELECT dupe_of FROM articles WHERE guid = ?').get('b-pont').dupe_of);
});

test('un titre court ne suffit pas a declarer un doublon', () => {
  store.saveItems(fluxA, [article({ guid: 'a-court', url: 'https://a.test/breve', title: 'Revue de presse' })], U);
  const resultat = store.saveItems(fluxB, [article({ guid: 'b-court', url: 'https://b.test/breve', title: 'Revue de presse' })], U);

  assert.deepEqual(resultat, { ajoutes: 1, doublons: 0, filtres: 0 });
  assert.equal(db.prepare('SELECT dupe_of FROM articles WHERE guid = ?').get('b-court').dupe_of, null);
});

test('un titre identique mais publie bien plus tard reste un article distinct', () => {
  const titre = 'Le bilan hebdomadaire des transports urbains de la region';
  store.saveItems(fluxA, [article({ guid: 'a-hebdo', url: 'https://a.test/h1', title: titre })], U);
  const resultat = store.saveItems(fluxB, [article({
    guid: 'b-hebdo',
    url: 'https://b.test/h2',
    title: titre,
    published_at: Date.parse('2026-05-11T10:00:00Z')
  })], U);

  assert.deepEqual(resultat, { ajoutes: 1, doublons: 0, filtres: 0 });
});

test('les doublons sont masques globalement mais visibles dans leur flux', () => {
  const url = 'https://presse.test/masque';
  const titre = 'Une information relayee a l identique par deux redactions';
  store.saveItems(fluxA, [article({ guid: 'a-masque', url, title: titre })], U);
  store.saveItems(fluxB, [article({ guid: 'b-masque', url, title: titre })], U);

  const global = store.queryArticles({ view: 'all', limit: 200 }, U).articles;
  assert.equal(global.filter((a) => a.title === titre).length, 1);

  const dansB = store.queryArticles({ view: 'all', feedId: fluxB, limit: 200 }, U).articles;
  assert.equal(dansB.filter((a) => a.title === titre).length, 1);
});

test('lire un exemplaire marque toute l histoire comme lue', () => {
  const url = 'https://presse.test/lecture';
  const titre = 'Une nouvelle que deux journaux publient le meme matin';
  store.saveItems(fluxA, [article({ guid: 'a-lect', url, title: titre })], U);
  store.saveItems(fluxB, [article({ guid: 'b-lect', url, title: titre })], U);

  const original = db.prepare('SELECT id FROM articles WHERE guid = ?').get('a-lect').id;
  store.setRead(original, true, U);

  const copie = db.prepare('SELECT read_at FROM articles WHERE guid = ?').get('b-lect');
  assert.ok(copie.read_at, 'la copie doit passer en lu');

  store.setRead(original, false, U);
  assert.equal(db.prepare('SELECT read_at FROM articles WHERE guid = ?').get('b-lect').read_at, null);
});

test('une copie arrivee apres coup herite de l etat de lecture', () => {
  const url = 'https://presse.test/apres';
  const titre = 'Un article deja lu avant que le second flux ne le publie';
  store.saveItems(fluxA, [article({ guid: 'a-apres', url, title: titre })], U);
  store.setRead(db.prepare('SELECT id FROM articles WHERE guid = ?').get('a-apres').id, true, U);

  store.saveItems(fluxB, [article({ guid: 'b-apres', url, title: titre })], U);
  assert.ok(db.prepare('SELECT read_at FROM articles WHERE guid = ?').get('b-apres').read_at);
});

test('le compteur global ne compte chaque histoire qu une fois', () => {
  db.exec('DELETE FROM articles');
  const url = 'https://presse.test/compte';
  const titre = 'Une seule histoire comptee une seule fois dans le total';
  store.saveItems(fluxA, [article({ guid: 'a-cpt', url, title: titre })], U);
  store.saveItems(fluxB, [article({ guid: 'b-cpt', url, title: titre })], U);

  const c = store.counts(U);
  assert.equal(c.unread, 1);
  assert.equal(c.total, 1);
  assert.equal(c.duplicates, 1);
});

test('marquer tout lu propage aux copies des autres flux', () => {
  db.exec('DELETE FROM articles');
  const url = 'https://presse.test/tout';
  const titre = 'Une histoire publiee par deux sources et lue en bloc';
  store.saveItems(fluxA, [article({ guid: 'a-tout', url, title: titre })], U);
  store.saveItems(fluxB, [article({ guid: 'b-tout', url, title: titre })], U);

  store.markRead({ feedId: fluxA }, U);
  assert.ok(db.prepare('SELECT read_at FROM articles WHERE guid = ?').get('b-tout').read_at);
  assert.equal(store.counts(U).unread, 0);
});

test.after(() => {
  db.close();
  fs.rmSync(dossier, { recursive: true, force: true });
});

/* ------------------------- pieges rencontres sur de vrais flux ------------- */

test('urlKey ecarte une adresse sans chemin : elle ne designe aucun article', () => {
  assert.equal(urlKey('https://www.radiofrance.fr/'), null);
  assert.equal(urlKey('https://exemple.fr'), null);
  // ... mais un parametre suffit a identifier une page
  assert.equal(urlKey('https://exemple.fr/?p=12'), 'exemple.fr/?p=12');
});

test('un podcast qui met la racine du site sur chaque episode garde ses episodes', () => {
  const racine = 'https://www.radiofrance.fr/';
  const resultat = store.saveItems(fluxA, [
    article({ guid: 'ep1', url: racine, title: 'Averroes passeur de savoirs : la raison et la foi' }),
    article({ guid: 'ep2', url: racine, title: 'Averroes passeur de savoirs : Averroes et la philosophie grecque' }),
    article({ guid: 'ep3', url: racine, title: 'Hannah Arendt, la liberte de philosopher : Arendt et la democratie' })
  ], U);
  assert.deepEqual(resultat, { ajoutes: 3, doublons: 0, filtres: 0 });
});

test('dans un meme flux, une adresse partagee ne replie pas des titres differents', () => {
  const lien = 'https://revue.test/emission';
  store.saveItems(fluxA, [article({ guid: 'em1', url: lien, title: 'Le premier episode parle longuement de Spinoza' })], U);
  const resultat = store.saveItems(fluxA, [
    article({ guid: 'em2', url: lien, title: 'Le second episode parle longuement de Leibniz' })
  ], U);
  assert.deepEqual(resultat, { ajoutes: 1, doublons: 0, filtres: 0 });
});

test('recalculerDoublons defait les rapprochements devenus faux', () => {
  db.exec('DELETE FROM articles');
  const racine = 'https://podcast.test/';
  store.saveItems(fluxA, [
    article({ guid: 'r1', url: racine, title: 'Un premier episode au titre suffisamment long' }),
    article({ guid: 'r2', url: racine, title: 'Un second episode au titre tout aussi long' })
  ], U);
  // On simule d'anciennes cles calculees avec la regle fautive.
  db.prepare("UPDATE articles SET url_key = 'podcast.test'").run();
  db.prepare('UPDATE articles SET dupe_of = (SELECT MIN(id) FROM articles) WHERE id > (SELECT MIN(id) FROM articles)').run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM articles WHERE dupe_of IS NOT NULL').get().n, 1);

  store.recalculerDoublons(U);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM articles WHERE dupe_of IS NOT NULL').get().n, 0);
});
