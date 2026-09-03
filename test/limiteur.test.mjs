import test from 'node:test';
import assert from 'node:assert/strict';

import { bloque, echec, reussite, nettoyer, gardeConnexion, _pourLesTests } from '../server/limiteur.js';

const { ECHECS_MAX, BLOCAGE_MS, registre } = _pourLesTests;

test('cinq échecs dans la minute bloquent, la réussite efface', () => {
  registre.clear();
  const t0 = 1_000_000;
  for (let i = 0; i < ECHECS_MAX - 1; i++) echec('ip:1.2.3.4', t0 + i * 1000);
  assert.equal(bloque('ip:1.2.3.4', t0 + 5000), 0);
  echec('ip:1.2.3.4', t0 + 5000);
  assert.ok(bloque('ip:1.2.3.4', t0 + 5001) > 0);
  assert.equal(bloque('ip:1.2.3.4', t0 + 5000 + BLOCAGE_MS + 1), 0);
  reussite('ip:1.2.3.4');
  assert.equal(bloque('ip:1.2.3.4', t0 + 5001), 0);
});

test('des échecs espacés de plus d’une minute ne s’additionnent pas', () => {
  registre.clear();
  for (let i = 0; i < 10; i++) echec('courriel:a@b.co', i * 61_000);
  assert.equal(bloque('courriel:a@b.co', 10 * 61_000), 0);
});

test('nettoyer oublie les entrées mortes', () => {
  registre.clear();
  echec('ip:9.9.9.9', 0);
  nettoyer(120_000);
  assert.equal(registre.size, 0);
});

test('le garde répond 429 avec Retry-After une fois bloqué', () => {
  registre.clear();
  const req = { ip: '5.5.5.5', body: { email: 'X@Y.Z' } };
  const res = { statut: 0, entetes: {}, set(k, v) { this.entetes[k] = v; return this; }, status(s) { this.statut = s; return this; }, json(c) { this.corps = c; return this; } };
  let suite = 0;
  for (let i = 0; i < ECHECS_MAX; i++) {
    gardeConnexion(req, res, () => { suite++; req.limiteur.echec(); });
  }
  assert.equal(suite, ECHECS_MAX);
  gardeConnexion(req, res, () => { suite++; });
  assert.equal(suite, ECHECS_MAX, 'la sixième ne passe pas');
  assert.equal(res.statut, 429);
  assert.ok(Number(res.entetes['retry-after']) > 0);
  // Le courriel est bloqué aussi, même depuis une autre adresse.
  const autre = { ip: '6.6.6.6', body: { email: 'x@y.z' } };
  gardeConnexion(autre, res, () => { suite++; });
  assert.equal(suite, ECHECS_MAX);
});
