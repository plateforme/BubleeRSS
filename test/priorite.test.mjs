import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'bublee-priorite-'));
process.env.BUBLEE_DATA = dossier;

const store = await import('../server/store.js');
const { db } = await import('../server/db.js');

const creerFlux = (url, titre) => Number(
  db.prepare('INSERT INTO feeds (url, title, folder, created_at) VALUES (?, ?, ?, ?)')
    .run(url, titre, 'Test', Date.now()).lastInsertRowid
);

const suivi = creerFlux('https://suivi.test/rss', 'Suivi');
const survole = creerFlux('https://survol.test/rss', 'Survolé');
const muet = creerFlux('https://muet.test/rss', 'Muet');

let n = 0;
const article = (surcharge = {}) => ({
  guid: 'g' + ++n,
  url: 'https://exemple.test/' + n,
  title: 'Un titre assez long pour ne pas être pris pour un doublon numéro ' + n,
  author: null,
  summary: 'resume',
  content: '<p>contenu</p>',
  image: null,
  published_at: Date.parse('2026-05-04T10:00:00Z') - n * 60000,
  duration: null,
  word_count: 120,
  ...surcharge
});

for (const flux of [suivi, survole, muet]) {
  store.saveItems(flux, [article(), article()]);
}
store.updateFeed(survole, { priority: 'survol' });
store.updateFeed(muet, { priority: 'muet' });

const titresDe = (opts) => store.queryArticles(opts).articles.map((a) => a.feed_title);

/* ------------------------------------------------------------ priorité --- */

test('« Non lus » ne montre que les sources suivies', () => {
  const vus = new Set(titresDe({ view: 'unread', limit: 50 }));
  assert.deepEqual([...vus], ['Suivi']);
});

test('« Tout » montre le survol mais pas le muet', () => {
  const vus = new Set(titresDe({ view: 'all', limit: 50 }));
  assert.ok(vus.has('Suivi'));
  assert.ok(vus.has('Survolé'));
  assert.ok(!vus.has('Muet'), 'une source muette ne remonte pas d’elle-même');
});

test('« Survol » isole les sources mises de côté', () => {
  const vus = new Set(titresDe({ view: 'survol', limit: 50 }));
  assert.deepEqual([...vus], ['Survolé']);
});

test('aller sur la source montre tout, même muette', () => {
  assert.equal(titresDe({ view: 'unread', feedId: muet, limit: 50 }).length, 2);
});

test('le dossier et la recherche ne cachent rien non plus', () => {
  // Demander explicitement, c'est passer outre la priorité : sinon on cacherait
  // à quelqu'un parti chercher.
  const parDossier = new Set(titresDe({ view: 'unread', folder: 'Test', limit: 50 }));
  assert.ok(parDossier.has('Muet'));
  const parRecherche = new Set(titresDe({ view: 'all', q: 'doublon', limit: 50 }));
  assert.ok(parRecherche.has('Muet'));
});

test('les compteurs suivent ce que les vues montrent', () => {
  const c = store.counts();
  assert.equal(c.unread, 2, 'seules les sources suivies comptent');
  assert.equal(c.survol, 2);
  assert.equal(c.muet, 2);
  assert.equal(c.total, 4, '« Tout » laisse de côté les muettes');
});

test('une priorité inconnue est refusée', () => {
  assert.throws(() => store.updateFeed(suivi, { priority: 'important' }), /Priorite inconnue/);
});

/* ------------------------------------------------------------ recherche --- */

test('expressionFts ne laisse passer aucun opérateur', () => {
  assert.equal(store.expressionFts('claude'), '"claude"*');
  // Les mots-clés de FTS tapés par mégarde restent des mots ordinaires.
  assert.equal(store.expressionFts('a AND b'), '"a" AND "AND" AND "b"*');
  assert.equal(store.expressionFts('"gué" OR *'), '"gué" AND "OR"*');
  assert.equal(store.expressionFts('???'), null, 'sans mot, rien à chercher');
});

test('la recherche voit le corps de l’article, pas seulement le titre', () => {
  store.saveItems(suivi, [article({
    title: 'Une chronique parfaitement anodine sur le temps qu’il fait',
    summary: 'resume',
    content: '<p>Le mot <b>hippocampe</b> n’apparaît que dans le corps du texte.</p>'
  })]);
  const trouves = store.queryArticles({ view: 'all', q: 'hippocampe', limit: 5 }).articles;
  assert.equal(trouves.length, 1);
  assert.match(trouves[0].title, /chronique parfaitement anodine/);
});

test('la recherche ignore les accents et cherche par préfixe', () => {
  store.saveItems(suivi, [article({
    title: 'Élections au Québec : un scrutin serré dans plusieurs circonscriptions'
  })]);
  assert.equal(store.queryArticles({ view: 'all', q: 'quebec', limit: 5 }).articles.length, 1);
  assert.equal(store.queryArticles({ view: 'all', q: 'circonscript', limit: 5 }).articles.length, 1);
});

test('le balisage n’est pas indexé comme des mots', () => {
  store.saveItems(suivi, [article({
    title: 'Une dépêche avec une image dedans et rien de particulier',
    content: '<p><img src="https://exemple.test/photo.jpg" alt=""> Légende.</p>'
  })]);
  assert.equal(store.queryArticles({ view: 'all', q: 'img', limit: 5 }).articles.length, 0);
  assert.equal(store.queryArticles({ view: 'all', q: 'légende', limit: 5 }).articles.length, 1);
});

test('modifier un article met l’index à jour', () => {
  const id = db.prepare("SELECT id FROM articles WHERE title LIKE '%hippocampe%' OR content LIKE '%hippocampe%'").get().id;
  db.prepare('UPDATE articles SET content = ? WHERE id = ?').run('<p>Désormais un tatou.</p>', id);
  assert.equal(store.queryArticles({ view: 'all', q: 'hippocampe', limit: 5 }).articles.length, 0);
  assert.equal(store.queryArticles({ view: 'all', q: 'tatou', limit: 5 }).articles.length, 1);
});
