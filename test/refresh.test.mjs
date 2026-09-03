// Le rythme du rafraîchissement : une seule passe à la fois, et une source
// en panne qui recule au lieu d'être retéléchargée à chaque tour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'bublee-refresh-'));
process.env.BUBLEE_DATA = dossier;

const store = await import('../server/store.js');
const comptes = await import('../server/comptes.js');
const { retryAfterEnMs } = await import('../server/feed.js');
const { db } = await import('../server/db.js');

const moi = await comptes.creerCompte({ email: 'f@bublee.test', motDePasse: 'dix-caracteres-au-moins', role: 'super' });

/* Un vrai serveur, pour que fetchFeed suive son chemin habituel. Le garde-fou
   SSRF refuse 127.0.0.1 : le flux est donc enregistré avec une adresse
   publique factice, et seul le nombre d'appels compte ici. */
let appels = 0;
const serveur = http.createServer((req, res) => {
  appels++;
  res.writeHead(500, { 'content-type': 'text/plain' });
  res.end('en panne');
});
await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
test.after(() => serveur.close());

const fluxCasse = Number(db.prepare(
  'INSERT INTO feeds (url, title, folder, created_at, user_id) VALUES (?, ?, ?, ?, ?)'
).run('https://source-en-panne.test/rss', 'En panne', '', Date.now(), moi.id).lastInsertRowid);

test('reculApres double à chaque échec, et plafonne à un jour', () => {
  const demi = 30 * 60 * 1000;
  assert.equal(store.reculApres(1), demi);
  assert.equal(store.reculApres(2), 2 * demi);
  assert.equal(store.reculApres(3), 4 * demi);
  assert.equal(store.reculApres(20), 24 * 3600 * 1000);
});

test('retryAfterEnMs lit des secondes comme une date', () => {
  assert.equal(retryAfterEnMs('120'), 120_000);
  assert.equal(retryAfterEnMs(null), null);
  assert.equal(retryAfterEnMs('n’importe quoi'), null);
  const dans = retryAfterEnMs(new Date(Date.now() + 60_000).toUTCString());
  assert.ok(dans > 50_000 && dans <= 60_000);
});

test('une source injoignable recule, et la passe suivante la saute', async () => {
  const premier = await store.refreshFeed(fluxCasse);
  assert.ok(premier.error, 'la source est bien en erreur');

  const apres = db.prepare('SELECT error_count, next_fetch_at FROM feeds WHERE id = ?').get(fluxCasse);
  assert.equal(apres.error_count, 1);
  assert.ok(apres.next_fetch_at > Date.now(), 'elle est reportée');

  // La passe automatique la saute…
  const auto = await store.refreshAll();
  assert.equal(auto.feeds, 0);
  assert.equal(auto.skipped, 1);

  // …mais une demande explicite la reprend, et le recul s'allonge.
  const forcee = await store.refreshAll({ force: true });
  assert.equal(forcee.feeds, 1);
  const encore = db.prepare('SELECT error_count, next_fetch_at FROM feeds WHERE id = ?').get(fluxCasse);
  assert.equal(encore.error_count, 2);
  assert.ok(encore.next_fetch_at - apres.next_fetch_at > 0, 'le report est plus lointain');
});

test('deux rafraîchissements lancés ensemble ne font qu’une passe', async () => {
  db.prepare('UPDATE feeds SET next_fetch_at = NULL WHERE id = ?').run(fluxCasse);
  const avant = db.prepare('SELECT error_count FROM feeds WHERE id = ?').get(fluxCasse).error_count;

  const [a, b] = await Promise.all([store.refreshAll(), store.refreshAll()]);
  assert.equal(a, b, 'la seconde demande reçoit la promesse de la première');

  const apres = db.prepare('SELECT error_count FROM feeds WHERE id = ?').get(fluxCasse).error_count;
  assert.equal(apres, avant + 1, 'la source n’a été essayée qu’une fois');
});
