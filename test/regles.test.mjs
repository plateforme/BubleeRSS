import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'bublee-regles-'));
process.env.BUBLEE_DATA = dossier;

const regles = await import('../server/regles.js');
const store = await import('../server/store.js');
const comptes = await import('../server/comptes.js');
const { db } = await import('../server/db.js');

const moi = await comptes.creerCompte({ email: 'r@bublee.test', motDePasse: 'dix-caracteres-au-moins', role: 'super' });
const autre = await comptes.creerCompte({ email: 'autre@bublee.test', motDePasse: 'dix-caracteres-au-moins' });

const creerFlux = (u, url) => Number(db.prepare(
  'INSERT INTO feeds (url, title, folder, created_at, user_id) VALUES (?, ?, ?, ?, ?)'
).run(url, 'Source', '', Date.now(), u).lastInsertRowid);

const flux = creerFlux(moi.id, 'https://presse.test/rss');
const fluxB = creerFlux(moi.id, 'https://autre.test/rss');
const fluxAutre = creerFlux(autre.id, 'https://presse.test/rss');

let n = 0;
const article = (titre, surcharge = {}) => ({
  guid: 'g' + ++n, url: 'https://presse.test/a' + n, title: titre,
  author: null, summary: '', content: '<p>corps ordinaire</p>', image: null,
  published_at: Date.now() - n * 1000, duration: null, word_count: 5, ...surcharge
});

/* ----------------------------------------------------- la correspondance */

test('le motif est une suite de mots, tous requis, sans ordre ni accents', () => {
  const r = { champ: 'titre', motif: 'bon plan' };
  assert.ok(regles.correspond({ title: 'Un très bon plan du jour' }, r));
  assert.ok(regles.correspond({ title: 'Plan : le meilleur, bon marché' }, r), 'l’ordre est libre');
  assert.ok(!regles.correspond({ title: 'Un bon article' }, r), 'tous les mots sont requis');
  assert.ok(regles.correspond({ title: 'BON PLAN' }, r), 'la casse est ignorée');
  assert.ok(regles.correspond({ title: 'Un bòn plán' }, r), 'les accents aussi');
});

test('les guillemets font une expression exacte', () => {
  const r = { champ: 'titre', motif: '"black friday"' };
  assert.ok(regles.correspond({ title: 'Les soldes du Black Friday' }, r));
  assert.ok(!regles.correspond({ title: 'Black : vendredi noir' }, r));
});

test('rien de ce qu’on tape ne devient une expression régulière', () => {
  const r = { champ: 'titre', motif: '.*' };
  assert.ok(!regles.correspond({ title: 'un titre quelconque' }, r));
  assert.ok(regles.correspond({ title: 'ceci .* cela' }, r), 'c’est cherché littéralement');
});

test('le champ dit où chercher', () => {
  const a = { title: 'Titre neutre', author: 'Sponsorisé', summary: 'un résumé', content: '<p>publicité</p>' };
  assert.ok(regles.correspond(a, { champ: 'auteur', motif: 'sponsorise' }));
  assert.ok(!regles.correspond(a, { champ: 'titre', motif: 'sponsorise' }));
  assert.ok(regles.correspond(a, { champ: 'corps', motif: 'publicite' }));
  assert.ok(regles.correspond(a, { champ: 'partout', motif: 'publicite' }));
});

/* ------------------------------------------------------ à l'arrivée */

test('une règle marque comme lu à l’insertion', () => {
  regles.creerRegle(moi.id, { motif: 'bon plan', action: 'lu' });
  const r = store.saveItems(flux, [article('Le bon plan du jour'), article('Une vraie information')], moi.id);
  assert.equal(r.ajoutes, 2);
  assert.equal(r.filtres, 1);
  const lus = db.prepare('SELECT title, read_at FROM articles WHERE feed_id = ? ORDER BY id').all(flux);
  assert.ok(lus[0].read_at, 'le bon plan arrive déjà lu');
  assert.equal(lus[1].read_at, null, 'l’autre non');
});

test('une règle peut étiqueter et mettre en favori', () => {
  regles.creerRegle(moi.id, { motif: 'climat', action: 'etiquette', valeur: 'à creuser' });
  regles.creerRegle(moi.id, { motif: 'climat', action: 'favori' });
  store.saveItems(flux, [article('Rapport sur le climat')], moi.id);

  const a = db.prepare('SELECT id, starred FROM articles WHERE title = ?').get('Rapport sur le climat');
  assert.equal(a.starred, 1);
  assert.deepEqual(store.getArticle(a.id, moi.id).tags, ['à creuser']);
});

test('une règle bornée à une source ne déborde pas', () => {
  regles.creerRegle(moi.id, { motif: 'chronique', action: 'lu', feedId: fluxB });
  store.saveItems(flux, [article('Chronique du matin')], moi.id);
  store.saveItems(fluxB, [article('Chronique du soir')], moi.id);

  assert.equal(db.prepare('SELECT read_at FROM articles WHERE title = ?').get('Chronique du matin').read_at, null);
  assert.ok(db.prepare('SELECT read_at FROM articles WHERE title = ?').get('Chronique du soir').read_at);
});

test('les règles d’un compte ne s’appliquent pas à un autre', () => {
  store.saveItems(fluxAutre, [article('Le bon plan du jour, chez l’autre')], autre.id);
  const a = db.prepare('SELECT read_at FROM articles WHERE feed_id = ? ORDER BY id DESC LIMIT 1').get(fluxAutre);
  assert.equal(a.read_at, null);
});

test('une règle compte ce qu’elle attrape', () => {
  const liste = regles.listerRegles(moi.id);
  const bonPlan = liste.find((r) => r.motif === 'bon plan');
  assert.ok(bonPlan.touches >= 1);
});

/* --------------------------------------------------- sur la pile d'hier */

test('une règle s’essaie avant d’agir, puis se rejoue sur les non-lus', () => {
  store.saveItems(flux, [article('Publireportage : la maison connectée'), article('Publireportage : le jardin')], moi.id);

  const essai = store.essayerRegle(moi.id, { champ: 'titre', motif: 'publireportage' });
  assert.equal(essai.total, 2);
  assert.equal(essai.exemples.length, 2);
  assert.ok(essai.exemples[0].feed_title, 'l’exemple dit d’où il vient');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM articles WHERE read_at IS NULL AND feed_id = ?').get(flux).n > 0, true,
    'l’essai n’a rien changé');

  const regle = regles.creerRegle(moi.id, { motif: 'publireportage', action: 'lu' });
  const rejoue = store.rejouerRegles(moi.id, { regleId: regle.id });
  assert.equal(rejoue.lus, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM articles WHERE title LIKE ? AND read_at IS NULL').get('Publireportage%').n, 0);
});

test('rejouer ne défait pas une lecture déjà faite', () => {
  const a = store.saveItems(flux, [article('Un titre sans rapport avec rien')], moi.id);
  assert.equal(a.ajoutes, 1);
  const id = db.prepare('SELECT id FROM articles WHERE title = ?').get('Un titre sans rapport avec rien').id;
  store.setRead(id, true, moi.id);
  const avant = db.prepare('SELECT read_at FROM articles WHERE id = ?').get(id).read_at;
  store.rejouerRegles(moi.id);
  assert.equal(db.prepare('SELECT read_at FROM articles WHERE id = ?').get(id).read_at, avant);
});

test('une règle se désactive, et cesse alors d’agir', () => {
  const regle = regles.creerRegle(moi.id, { motif: 'inutile', action: 'lu' });
  regles.modifierRegle(regle.id, moi.id, { actif: false });
  store.saveItems(flux, [article('Un article inutile')], moi.id);
  assert.equal(db.prepare('SELECT read_at FROM articles WHERE title = ?').get('Un article inutile').read_at, null);
  assert.ok(regles.supprimerRegle(regle.id, moi.id));
  assert.ok(!regles.supprimerRegle(regle.id, moi.id), 'la seconde fois, il n’y a plus rien');
});

test('une règle refuse ce qui ne veut rien dire', () => {
  assert.throws(() => regles.creerRegle(moi.id, { motif: '   ' }), /vide/);
  assert.throws(() => regles.creerRegle(moi.id, { motif: 'x', champ: 'nawak' }), /Champ inconnu/);
  assert.throws(() => regles.creerRegle(moi.id, { motif: 'x', action: 'nawak' }), /Action inconnue/);
  assert.throws(() => regles.creerRegle(moi.id, { motif: 'x', action: 'etiquette' }), /étiquette/);
  assert.throws(() => regles.creerRegle(moi.id, { motif: 'x', feedId: fluxAutre }), /introuvable/);
});
