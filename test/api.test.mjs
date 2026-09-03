// Les routes, de bout en bout : l'application ecoute sur un port ephemere et
// on lui parle en HTTP, comme le navigateur ou un script le feraient.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'bublee-api-'));
process.env.BUBLEE_DATA = dossier;

const { app, stopRefresh } = await import('../server/app.js');
const { db } = await import('../server/db.js');
const store = await import('../server/store.js');
const limiteur = await import('../server/limiteur.js');

const serveur = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${serveur.address().port}`;
test.after(() => { stopRefresh(); serveur.close(); });

/** fetch sur l'app, corps JSON decode, cookie et jeton en option. */
async function appel(methode, chemin, { corps, cookie, jeton, entetes = {} } = {}) {
  const res = await fetch(base + chemin, {
    method: methode,
    headers: {
      ...(corps !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(jeton ? { authorization: 'Bearer ' + jeton } : {}),
      ...entetes
    },
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
    redirect: 'manual'
  });
  const type = res.headers.get('content-type') || '';
  const json = type.includes('json') ? await res.json() : await res.text();
  return { statut: res.status, json, entetes: res.headers };
}

const cookieDe = (r) => (r.entetes.get('set-cookie') || '').split(';')[0];

let cookieGreg = '';
let cookieAlice = '';

test('/api/ping répond sans compte, /api/state exige un compte', async () => {
  const ping = await appel('GET', '/api/ping');
  assert.equal(ping.statut, 200);
  assert.equal(ping.json.ok, true);
  assert.equal((await appel('GET', '/api/state')).statut, 401);
});

test('les en-têtes de sécurité sont posés partout', async () => {
  const r = await appel('GET', '/api/ping');
  assert.match(r.entetes.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.entetes.get('x-content-type-options'), 'nosniff');
  assert.equal(r.entetes.get('referrer-policy'), 'no-referrer');
  assert.equal(r.entetes.get('x-powered-by'), null);
});

test('installation : le premier compte devient super, le second est refusé', async () => {
  const etat = await appel('GET', '/api/auth/etat');
  assert.equal(etat.json.installe, false);

  const r = await appel('POST', '/api/auth/installer', { corps: { email: 'Greg@Bublee.test', nom: 'Greg', motDePasse: 'un-mot-de-passe-long' } });
  assert.equal(r.statut, 201);
  assert.equal(r.json.compte.role, 'super');
  cookieGreg = cookieDe(r);
  assert.match(cookieGreg, /^bublee_session=/);
  assert.match(r.entetes.get('set-cookie'), /HttpOnly/);

  const encore = await appel('POST', '/api/auth/installer', { corps: { email: 'x@y.z', motDePasse: 'encore-un-long-mdp' } });
  assert.equal(encore.statut, 409);
});

test('/api/auth/moi répond avec le nombre de sessions', async () => {
  const r = await appel('GET', '/api/auth/moi', { cookie: cookieGreg });
  assert.equal(r.statut, 200);
  assert.equal(r.json.compte.email, 'greg@bublee.test');
  assert.equal(r.json.sessions, 1);
});

test('une route d’API inconnue répond 404 en JSON, pas index.html (401 sans compte)', async () => {
  assert.equal((await appel('GET', '/api/nulle-part')).statut, 401);
  const r = await appel('GET', '/api/nulle-part', { cookie: cookieGreg });
  assert.equal(r.statut, 404);
  assert.match(r.json.error, /Route inconnue/);
});

test('connexion : mauvais mot de passe 401, cinq échecs puis 429 avec Retry-After', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await appel('POST', '/api/auth/login', { corps: { email: 'greg@bublee.test', motDePasse: 'faux' } });
    assert.equal(r.statut, 401, 'tentative ' + (i + 1));
  }
  const bloque = await appel('POST', '/api/auth/login', { corps: { email: 'greg@bublee.test', motDePasse: 'un-mot-de-passe-long' } });
  assert.equal(bloque.statut, 429);
  assert.ok(Number(bloque.entetes.get('retry-after')) > 0);
  // Le blocage vaut aussi pour un autre courriel depuis la même adresse.
  assert.equal((await appel('POST', '/api/auth/login', { corps: { email: 'autre@bublee.test', motDePasse: 'x' } })).statut, 429);
  // On rend la main à la suite des tests : tout vient de 127.0.0.1.
  limiteur._pourLesTests.registre.clear();
});

test('un super crée un compte éditeur, qui se connecte', async () => {
  const r = await appel('POST', '/api/users', { cookie: cookieGreg, corps: { email: 'alice@bublee.test', nom: 'Alice', motDePasse: 'le-mot-de-passe-alice' } });
  assert.equal(r.statut, 201);
  assert.equal(r.json.compte.role, 'editeur');

  const login = await appel('POST', '/api/auth/login', { corps: { email: 'alice@bublee.test', motDePasse: 'le-mot-de-passe-alice' } });
  assert.equal(login.statut, 200);
  cookieAlice = cookieDe(login);

  // Un éditeur n'administre pas.
  assert.equal((await appel('GET', '/api/users', { cookie: cookieAlice })).statut, 403);
});

/* Deux comptes, la même source, un article chacun : seule la propriété peut
   les distinguer. */
let articleGreg, articleAlice;

test('cloisonnement : chacun ne voit que ses sources et ses articles', async () => {
  const [greg, alice] = db.prepare('SELECT id FROM users ORDER BY id').all().map((r) => r.id);
  const flux = (u) => Number(db.prepare(
    'INSERT INTO feeds (url, title, folder, created_at, user_id) VALUES (?, ?, ?, ?, ?)'
  ).run('https://presse.test/rss', 'Presse', '', Date.now(), u).lastInsertRowid);
  const fluxGreg = flux(greg);
  const fluxAlice = flux(alice);
  const article = (n) => ({
    guid: 'g' + n, url: 'https://presse.test/a' + n, title: 'Un titre assez long pour être comparable, numéro ' + n,
    author: null, summary: '', content: '<p>corps</p>', image: null, published_at: Date.now() - n * 1000, duration: null, word_count: 5
  });
  store.saveItems(fluxGreg, [article(1)], greg);
  store.saveItems(fluxAlice, [article(2)], alice);
  articleGreg = db.prepare('SELECT id FROM articles WHERE feed_id = ?').get(fluxGreg).id;
  articleAlice = db.prepare('SELECT id FROM articles WHERE feed_id = ?').get(fluxAlice).id;

  const sourcesGreg = await appel('GET', '/api/feeds', { cookie: cookieGreg });
  assert.deepEqual(sourcesGreg.json.map((f) => f.id), [fluxGreg]);

  const articlesAlice = await appel('GET', '/api/articles?view=all', { cookie: cookieAlice });
  assert.deepEqual(articlesAlice.json.articles.map((a) => a.id), [articleAlice]);

  // L'article de l'autre : introuvable, ni en lecture, ni en écriture, ni en étiquette.
  assert.equal((await appel('GET', '/api/articles/' + articleGreg, { cookie: cookieAlice })).statut, 404);
  assert.equal((await appel('PATCH', '/api/articles/' + articleGreg, { cookie: cookieAlice, corps: { read: true } })).statut, 404);
  assert.equal((await appel('POST', `/api/articles/${articleGreg}/tags`, { cookie: cookieAlice, corps: { add: ['vol'] } })).statut, 404);
  assert.equal((await appel('DELETE', '/api/feeds/' + fluxGreg, { cookie: cookieAlice })).statut, 404);
  assert.equal((await appel('POST', `/api/feeds/${fluxGreg}/refresh`, { cookie: cookieAlice })).statut, 404);
  assert.equal(db.prepare('SELECT read_at FROM articles WHERE id = ?').get(articleGreg).read_at, null);
});

test('marquer lu et étiqueter chez soi fonctionne, et « tout lire » reste borné au compte', async () => {
  const lu = await appel('PATCH', '/api/articles/' + articleGreg, { cookie: cookieGreg, corps: { read: true } });
  assert.equal(lu.statut, 200);
  assert.ok(lu.json.read_at);

  const etiq = await appel('POST', `/api/articles/${articleAlice}/tags`, { cookie: cookieAlice, corps: { add: ['veille'] } });
  assert.deepEqual(etiq.json.tags, ['veille']);

  const tout = await appel('POST', '/api/articles/read', { cookie: cookieAlice, corps: { all: true } });
  assert.equal(tout.json.changed, 1);
  assert.equal(tout.json.counts.unread, 0);
});

test('le jeton personnel vaut la session ; en query string il ne vaut plus rien', async () => {
  const jeton = (await appel('GET', '/api/token', { cookie: cookieGreg })).json.token;
  assert.ok(jeton);
  const parJeton = await appel('GET', '/api/auth/moi', { jeton });
  assert.equal(parJeton.statut, 200);
  assert.equal(parJeton.json.compte.email, 'greg@bublee.test');
  assert.equal((await appel('GET', '/api/auth/moi?token=' + jeton)).statut, 401);
});

test('CORS : reflété pour un jeton seulement, jamais avec le cookie', async () => {
  const jeton = (await appel('GET', '/api/token', { cookie: cookieGreg })).json.token;
  const origine = { origin: 'https://ailleurs.example' };

  const parJeton = await appel('GET', '/api/state', { jeton, entetes: origine });
  assert.equal(parJeton.statut, 200);
  assert.equal(parJeton.entetes.get('access-control-allow-origin'), 'https://ailleurs.example');
  assert.equal(parJeton.entetes.get('access-control-allow-credentials'), null);

  const parCookie = await appel('GET', '/api/state', { cookie: cookieGreg, entetes: origine });
  assert.equal(parCookie.statut, 401, 'le cookie ne vaut rien depuis une autre origine');
  assert.equal(parCookie.entetes.get('access-control-allow-origin'), null);

  // Même origine annoncée : le cookie passe.
  const chezSoi = await appel('GET', '/api/state', { cookie: cookieGreg, entetes: { origin: base } });
  assert.equal(chezSoi.statut, 200);

  const preflight = await fetch(base + '/api/state', {
    method: 'OPTIONS',
    headers: { origin: 'https://ailleurs.example', 'access-control-request-headers': 'authorization' }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://ailleurs.example');
});

test('le relais d’images refuse une adresse locale et une adresse non-http', async () => {
  assert.equal((await appel('GET', '/api/image?url=' + encodeURIComponent('http://127.0.0.1/x.png'), { cookie: cookieGreg })).statut, 400);
  assert.equal((await appel('GET', '/api/image?url=' + encodeURIComponent('file:///etc/passwd'), { cookie: cookieGreg })).statut, 400);
});

test('les garde-fous des comptes : dernier super, suppression de soi-même', async () => {
  const [greg] = db.prepare('SELECT id FROM users ORDER BY id').all().map((r) => r.id);
  assert.equal((await appel('DELETE', '/api/users/' + greg, { cookie: cookieGreg })).statut, 409);
  const retro = await appel('PATCH', '/api/users/' + greg, { cookie: cookieGreg, corps: { role: 'editeur' } });
  assert.equal(retro.json.compte.role, 'super', 'un super ne se rétrograde pas lui-même');
});

test('déconnexion : le cookie ne vaut plus rien', async () => {
  const r = await appel('POST', '/api/auth/logout', { cookie: cookieAlice });
  assert.equal(r.statut, 200);
  assert.equal((await appel('GET', '/api/auth/moi', { cookie: cookieAlice })).statut, 401);
});

/* ------------------------------------------------------------- statique */

test('les fichiers de l’interface sont compressés, avec ETag et 304', async () => {
  const brut = await fetch(base + '/js/app.js', { headers: { 'accept-encoding': 'identity' } });
  const compresse = await fetch(base + '/js/app.js', { headers: { 'accept-encoding': 'br, gzip' } });
  assert.equal(brut.status, 200);
  assert.match(brut.headers.get('content-type'), /javascript/);
  assert.equal(compresse.headers.get('content-encoding'), 'br');
  const gagne = Number(brut.headers.get('content-length')) / Number(compresse.headers.get('content-length'));
  assert.ok(gagne > 3, `la compression doit diviser par plus de trois (ici ${gagne.toFixed(1)})`);

  const etag = brut.headers.get('etag');
  assert.ok(etag);
  const revisite = await fetch(base + '/js/app.js', { headers: { 'if-none-match': etag } });
  assert.equal(revisite.status, 304);
});

test('les polices sont mises en cache pour longtemps, et ne sont pas recompressées', async () => {
  const r = await fetch(base + '/fonts/newsreader-normal-300-700-latin.woff2');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'font/woff2');
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.equal(r.headers.get('content-encoding'), null);
});

test('une adresse de vue rend l’index, et rien ne sort du dossier public', async () => {
  const vue = await fetch(base + '/reglages');
  assert.equal(vue.status, 200);
  assert.match(vue.headers.get('content-type'), /text\/html/);

  // Une remontée de dossier ne doit jamais servir un fichier du projet.
  const dehors = await fetch(base + '/../package.json');
  const corps = await dehors.text();
  assert.ok(!corps.includes('"better-sqlite3"'), 'le package.json ne doit pas être servi');
});

/* ------------------------------------------------- compteurs et annulation */

/* Le test de déconnexion plus haut a fermé la session d'Alice : on rouvre. */
test('Alice se reconnecte', async () => {
  const r = await appel('POST', '/api/auth/login', { corps: { email: 'alice@bublee.test', motDePasse: 'le-mot-de-passe-alice' } });
  assert.equal(r.statut, 200);
  cookieAlice = cookieDe(r);
});

test('les écritures renvoient les compteurs, sans redemander tout l’état', async () => {
  const r = await appel('PATCH', '/api/articles/' + articleAlice, { cookie: cookieAlice, corps: { starred: true } });
  assert.equal(r.statut, 200);
  assert.ok(r.json.counts, 'les compteurs suivent la réponse');
  assert.equal(r.json.counts.starred, 1);
  assert.ok(Array.isArray(r.json.feeds), 'et les chiffres de chaque source');
  assert.ok(r.json.feeds.every((f) => 'unread' in f && 'total' in f));

  const etiq = await appel('POST', `/api/articles/${articleAlice}/tags`, { cookie: cookieAlice, corps: { add: ['relire'] } });
  assert.ok(etiq.json.tags_liste.some((t) => t.name === 'relire'), 'les étiquettes aussi');
});

test('marquer lu en masse s’annule : tout le lot porte le même horodatage', async () => {
  // On remet les deux articles d'Alice à non lus pour partir au propre.
  const [, alice] = db.prepare('SELECT id FROM users ORDER BY id').all().map((r) => r.id);
  db.prepare('UPDATE articles SET read_at = NULL WHERE feed_id IN (SELECT id FROM feeds WHERE user_id = ?)').run(alice);

  const lu = await appel('POST', '/api/articles/read', { cookie: cookieAlice, corps: { all: true } });
  assert.equal(lu.json.changed, 1);
  assert.ok(lu.json.stamp, 'l’horodatage du lot revient');
  assert.equal(lu.json.counts.unread, 0);

  const annule = await appel('POST', '/api/articles/unread', { cookie: cookieAlice, corps: { stamp: lu.json.stamp } });
  assert.equal(annule.json.changed, 1);
  assert.equal(annule.json.counts.unread, 1, 'l’article est revenu dans les non-lus');

  // Un horodatage inconnu ne touche à rien.
  assert.equal((await appel('POST', '/api/articles/unread', { cookie: cookieAlice, corps: { stamp: 1 } })).json.changed, 0);
});

test('« olderThan » ne marque que ce qui a vieilli', async () => {
  const [, alice] = db.prepare('SELECT id FROM users ORDER BY id').all().map((r) => r.id);
  const fluxAlice = db.prepare('SELECT id FROM feeds WHERE user_id = ?').get(alice).id;
  store.saveItems(fluxAlice, [{
    guid: 'vieux', url: 'https://presse.test/vieux', title: 'Un article publié il y a bien longtemps déjà',
    author: null, summary: '', content: '<p>x</p>', image: null,
    published_at: Date.now() - 40 * 86400000, duration: null, word_count: 5
  }], alice);

  const r = await appel('POST', '/api/articles/read', {
    cookie: cookieAlice, corps: { all: true, olderThan: Date.now() - 7 * 86400000 }
  });
  assert.equal(r.json.changed, 1, 'seul le vieil article est marqué');
  assert.equal(r.json.counts.unread, 1, 'le récent reste non lu');
});
