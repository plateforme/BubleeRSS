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

/* --------------------------------------------------------------- débit */

test('les statistiques disent ce que chaque source apporte', () => {
  const d = store.statistiquesSources(moi.id);
  assert.ok(d.recus > 0);
  assert.equal(d.jours, 90);
  const source = d.sources.find((s) => s.id === flux);
  assert.ok(source.recus > 0);
  assert.equal(typeof source.partLue, 'number');
  assert.equal(typeof source.parJour, 'number');
});

test('aucune suggestion tant que la bibliothèque n’a pas été lue', () => {
  // Ici presque rien n'a été lu : comparer les sources n'aurait pas de sens.
  const d = store.statistiquesSources(moi.id);
  if (!d.assezDeRecul) assert.deepEqual(d.suggestions, [], 'on se tait faute de recul');
});

test('une source prolifique et jamais lue est proposée en survol', () => {
  const prolifique = Number(db.prepare(
    'INSERT INTO feeds (url, title, folder, created_at, user_id) VALUES (?, ?, ?, ?, ?)'
  ).run('https://beaucoup.test/rss', 'Beaucoup', '', Date.now(), moi.id).lastInsertRowid);

  // Vingt articles jamais lus chez elle, et de la lecture ailleurs pour que
  // la comparaison ait un sens.
  const lot = [];
  for (let i = 0; i < 20; i++) lot.push(article('Article prolifique numéro ' + i));
  store.saveItems(prolifique, lot, moi.id);

  const lus = db.prepare('SELECT id FROM articles WHERE feed_id = ?').all(flux);
  for (const l of lus) db.prepare('UPDATE articles SET read_at = ? WHERE id = ?').run(Date.now(), l.id);

  const d = store.statistiquesSources(moi.id);
  assert.ok(d.assezDeRecul, 'il y a maintenant assez de lectures');
  assert.ok(d.suggestions.includes(prolifique), 'la source prolifique et ignorée est proposée');

  assert.equal(store.changerPriorites([prolifique], 'survol', moi.id), 1);
  assert.equal(db.prepare('SELECT priority FROM feeds WHERE id = ?').get(prolifique).priority, 'survol');

  // Une fois en survol, elle ne se propose plus : ce serait sans effet.
  assert.ok(!store.statistiquesSources(moi.id).suggestions.includes(prolifique));
});

test('changer les priorités refuse une valeur inconnue, et ne sort pas du compte', () => {
  assert.throws(() => store.changerPriorites([flux], 'nawak', moi.id), /Priorite inconnue/);
  assert.equal(store.changerPriorites([fluxAutre], 'muet', moi.id), 0, 'la source d’un autre n’est pas touchée');
});

/* ------------------------------------------------ texte complet par source */

test('une source réglée sur « jamais » n’est plus jugée tronquée', () => {
  store.saveItems(fluxB, [article('Un article court, mais complet', { word_count: 30 })], moi.id);
  const id = db.prepare('SELECT id FROM articles WHERE title = ?').get('Un article court, mais complet').id;

  assert.equal(store.getArticle(id, moi.id).truncated, true, 'par défaut, trente mots paraissent tronqués');
  store.updateFeed(fluxB, { fulltext: 'jamais' }, moi.id);
  assert.equal(store.getArticle(id, moi.id).truncated, false, 'la source dit que son flux publie tout');
  assert.equal(store.getArticle(id, moi.id).should_fetch_full, false);
});

test('une source réglée sur « toujours » l’est même pour un long article', () => {
  store.saveItems(fluxB, [article('Un article déjà long dans le flux', { word_count: 5000 })], moi.id);
  const id = db.prepare('SELECT id FROM articles WHERE title = ?').get('Un article déjà long dans le flux').id;
  store.updateFeed(fluxB, { fulltext: 'toujours' }, moi.id);
  assert.equal(store.getArticle(id, moi.id).truncated, true);
  store.updateFeed(fluxB, { fulltext: 'auto' }, moi.id);
});

test('le réglage de texte complet refuse une valeur inconnue', () => {
  assert.throws(() => store.updateFeed(fluxB, { fulltext: 'nawak' }, moi.id), /texte complet inconnu/);
});

/* ------------------------------------------------- dossiers et ordre */

test('un dossier se renomme, et se fusionne avec un autre', () => {
  db.prepare('UPDATE feeds SET folder = ? WHERE id = ?').run('Tech', flux);
  db.prepare('UPDATE feeds SET folder = ? WHERE id = ?').run('Techno', fluxB);

  assert.equal(store.renommerDossier('Tech', 'Technique', moi.id), 1);
  assert.equal(db.prepare('SELECT folder FROM feeds WHERE id = ?').get(flux).folder, 'Technique');

  // Vers un nom qui existe déjà, les deux n'en font qu'un.
  store.renommerDossier('Techno', 'Technique', moi.id);
  assert.equal(store.listFolders(moi.id).find((f) => f.name === 'Technique').feeds, 2);
  assert.equal(store.listFolders(moi.id).some((f) => f.name === 'Techno'), false);
});

test('renommer ne touche pas au dossier d’un autre compte', () => {
  db.prepare('UPDATE feeds SET folder = ? WHERE id = ?').run('Technique', fluxAutre);
  store.renommerDossier('Technique', 'Ailleurs', moi.id);
  assert.equal(db.prepare('SELECT folder FROM feeds WHERE id = ?').get(fluxAutre).folder, 'Technique');
});

test('l’ordre des sources se fixe, et tient dans la liste', () => {
  assert.equal(store.ordonnerSources([fluxB, flux], moi.id), 2);
  const rangs = db.prepare('SELECT id, position FROM feeds WHERE user_id = ? AND position > 0 ORDER BY position').all(moi.id);
  assert.deepEqual(rangs.map((r) => r.id), [fluxB, flux]);

  const dansLIndex = store.listFeeds(moi.id).filter((f) => f.folder === 'Ailleurs').map((f) => f.id);
  assert.deepEqual(dansLIndex, [fluxB, flux], 'l’index suit l’ordre voulu, pas l’alphabet');

  assert.equal(store.ordonnerSources([fluxAutre], moi.id), 0, 'la source d’un autre ne bouge pas');
});
