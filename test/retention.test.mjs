import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'bublee-retention-'));
process.env.BUBLEE_DATA = dossier;

const store = await import('../server/store.js');
const comptes = await import('../server/comptes.js');
const { db } = await import('../server/db.js');

const moi = await comptes.creerCompte({ email: 'r@bublee.test', motDePasse: 'dix-caracteres-au-moins', role: 'super' });
const flux = Number(db.prepare(
  'INSERT INTO feeds (url, title, folder, created_at, user_id) VALUES (?, ?, ?, ?, ?)'
).run('https://presse.test/rss', 'Presse', '', Date.now(), moi.id).lastInsertRowid);

store.setSetting('retention_days', '30', moi.id);

const ilYA = (jours) => Date.now() - jours * 86400000;
let n = 0;
const article = (surcharge = {}) => ({
  guid: 'g' + ++n, url: 'https://presse.test/a' + n,
  title: 'Un titre suffisamment long pour compter, numéro ' + n,
  author: null, summary: '', content: '<p>corps</p>', image: null,
  published_at: ilYA(90), duration: null, word_count: 10, ...surcharge
});

store.saveItems(flux, [article(), article(), article(), article(), article({ published_at: ilYA(2) })], moi.id);
const [vieuxLu, vieuxEtiquete, vieuxFavori, vieuxNonLu, recentLu] =
  db.prepare('SELECT id FROM articles ORDER BY id').all().map((r) => r.id);

db.prepare('UPDATE articles SET read_at = ? WHERE id IN (?, ?, ?, ?)').run(ilYA(40), vieuxLu, vieuxEtiquete, vieuxFavori, recentLu);
store.setStarred(vieuxFavori, true, moi.id);
store.tagArticle(vieuxEtiquete, { add: ['à citer'] }, moi.id);

test('la rétention ne purge que les vieux articles lus, ni étiquetés ni favoris', () => {
  const supprimes = store.pruneArticles();
  assert.equal(supprimes, 1);
  const restants = new Set(db.prepare('SELECT id FROM articles').all().map((r) => r.id));
  assert.ok(!restants.has(vieuxLu), 'le vieux lu part');
  assert.ok(restants.has(vieuxEtiquete), 'l’étiqueté reste');
  assert.ok(restants.has(vieuxFavori), 'le favori reste');
  assert.ok(restants.has(vieuxNonLu), 'le non-lu reste');
  assert.ok(restants.has(recentLu), 'le récent reste');
  assert.deepEqual(store.getArticle(vieuxEtiquete, moi.id).tags, ['à citer']);
});

test('les sessions se listent, et les expirées se purgent', () => {
  comptes.ouvrirSession(moi.id, { agent: 'test', ip: '127.0.0.1' });
  const vivantes = comptes.listerSessions(moi.id);
  assert.equal(vivantes.length, 1);
  assert.ok(vivantes[0].expires_at > Date.now());

  db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1000, moi.id);
  assert.equal(comptes.purgerSessionsExpirees(), 1);
  assert.equal(comptes.listerSessions(moi.id).length, 0);
});
