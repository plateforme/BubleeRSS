import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as store from './store.js';
import { migrationApplied } from './db.js';
import { importOpml, exportOpml } from './opml.js';
import { urlPubliqueOuNull, USER_AGENT_NAVIGATEUR } from './http.js';
import { controleAcces, jeton, regenererJeton, NIVEAU } from './apikey.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: ['application/xml', 'text/xml', 'text/plain', 'application/octet-stream'], limit: '32mb' }));

/** Enveloppe une route async pour que les rejets partent dans le gestionnaire d'erreurs. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.set('trust proxy', 'loopback');
app.use('/api', controleAcces);

/* ------------------------------------------------------- carte de l'API */

const ROUTES = [
  ['GET',    '/api',                     'cette liste'],
  ['GET',    '/api/health',              'etat du service'],
  ['GET',    '/api/state',               'flux, dossiers, compteurs et reglages'],
  ['PUT',    '/api/settings',            'modifier les reglages'],
  ['GET',    '/api/feeds',               'liste des sources'],
  ['POST',   '/api/feeds',               'ajouter une source { url, folder?, title? }'],
  ['PATCH',  '/api/feeds/:id',           'renommer ou deplacer une source'],
  ['DELETE', '/api/feeds/:id',           'supprimer une source'],
  ['POST',   '/api/feeds/:id/refresh',   'rafraichir une source'],
  ['POST',   '/api/refresh',             'rafraichir toutes les sources'],
  ['POST',   '/api/feeds/repair',        'retrouver l’adresse des sources injoignables'],
  ['POST',   '/api/feeds/:id/repair',    'reparer une source precise'],
  ['GET',    '/api/articles',            'articles ; parametres view, feed, folder, q, tag, limit, before'],
  ['GET',    '/api/articles/:id',        'un article avec son contenu'],
  ['PATCH',  '/api/articles/:id',        'marquer lu / favori { read?, starred? }'],
  ['POST',   '/api/articles/:id/full',   'recuperer le texte complet (?force=1 pour relancer)'],
  ['POST',   '/api/articles/read',       'marquer lu en masse { ids | feedId | folder | all }'],
  ['POST',   '/api/articles/images',     'chercher les illustrations manquantes'],
  ['GET',    '/api/tags',                'etiquettes, couleurs et nombre d’articles'],
  ['POST',   '/api/tags',                'creer une etiquette { name }'],
  ['POST',   '/api/articles/:id/tags',   'etiqueter { add | remove | set }'],
  ['PATCH',  '/api/tags/:id',            'renommer ou reteindre { name?, color? }'],
  ['DELETE', '/api/tags/:id',            'supprimer une etiquette'],
  ['POST',   '/api/dedupe',              'rechercher les doublons deja en base'],
  ['POST',   '/api/opml/import',         'importer un OPML (corps = XML)'],
  ['GET',    '/api/opml/export',         'exporter les sources en OPML'],
  ['GET',    '/api/image',               'relais d’images ; parametre url']
];

app.get('/api', (req, res) => {
  res.json({
    name: 'Bublee',
    version: VERSION,
    auth: {
      mode: NIVEAU,
      header: 'Authorization: Bearer <jeton>',
      note: NIVEAU === 'off'
        ? 'Controle desactive.'
        : NIVEAU === 'lan'
          ? 'Machine locale et reseau prive dispenses de jeton.'
          : 'Seule la machine locale est dispensee de jeton.'
    },
    endpoints: ROUTES.map(([method, path, description]) => ({ method, path, description }))
  });
});

app.get('/api/health', (req, res) => {
  const counts = store.counts();
  res.json({ ok: true, version: VERSION, uptime: Math.round(process.uptime()), ...counts });
});

app.get('/api/token', (req, res) => res.json({ token: jeton(), mode: NIVEAU }));
app.post('/api/token/rotate', (req, res) => res.json({ token: regenererJeton(), mode: NIVEAU }));

// ?rebuild=1 recalcule les cles et refait tout le rapprochement a zero.
app.post('/api/dedupe', (req, res) => {
  const lies = req.query.rebuild === '1' ? store.recalculerDoublons() : store.dedupeExistants();
  res.json({ linked: lies, rebuilt: req.query.rebuild === '1', counts: store.counts() });
});

/* ------------------------------------------------------------------ etat */

app.get('/api/state', (req, res) => {
  res.json({
    feeds: store.listFeeds(),
    folders: store.listFolders(),
    counts: store.counts(),
    tags: store.listTags(),
    palette: store.PALETTE_TAGS,
    accents: store.PALETTE_ACCENT,
    settings: {
      refreshMinutes: Number(store.getSetting('refresh_minutes', '30')),
      retentionDays: Number(store.getSetting('retention_days', '90')),
      theme: store.getSetting('theme', 'auto'),
      accent: store.getSetting('accent', store.PALETTE_ACCENT[0].valeur),
      layout: store.getSetting('layout', 'magazine'),
      fulltext: store.getSetting('fulltext', 'auto'),
      fulltextMinWords: Number(store.getSetting('fulltext_min_words', '250'))
    }
  });
});

app.put('/api/settings', (req, res) => {
  const map = {
    refreshMinutes: 'refresh_minutes',
    retentionDays: 'retention_days',
    theme: 'theme',
    accent: 'accent',
    layout: 'layout',
    fulltext: 'fulltext',
    fulltextMinWords: 'fulltext_min_words'
  };
  for (const [key, column] of Object.entries(map)) {
    if (req.body[key] !== undefined) store.setSetting(column, req.body[key]);
  }
  scheduleRefresh();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ flux */

app.get('/api/feeds', (req, res) => res.json(store.listFeeds()));

app.post('/api/feeds', wrap(async (req, res) => {
  const { url, folder = '', title = '' } = req.body || {};
  if (!url || !String(url).trim()) return res.status(400).json({ error: 'Adresse manquante.' });
  const result = await store.addFeed(String(url).trim(), folder, title);
  res.status(201).json(result);
}));

app.patch('/api/feeds/:id', (req, res) => {
  res.json(store.updateFeed(Number(req.params.id), req.body || {}));
});

app.delete('/api/feeds/:id', (req, res) => {
  const ok = store.deleteFeed(Number(req.params.id));
  res.status(ok ? 200 : 404).json({ ok });
});

app.post('/api/feeds/:id/refresh', wrap(async (req, res) => {
  res.json(await store.refreshFeed(Number(req.params.id)));
}));

app.post('/api/refresh', wrap(async (req, res) => {
  const resultat = await store.refreshAll();
  res.json(resultat);
  // Les illustrations manquantes se cherchent apres coup, sans faire attendre.
  store.completerImages().catch(() => {});
}));

// Retrouve l'adresse actuelle des flux devenus injoignables.
app.post('/api/feeds/repair', wrap(async (req, res) => {
  res.json(await store.reparerSourcesCassees());
}));

// Sans corps : on cherche. Avec { url } : on applique la proposition retenue.
app.post('/api/feeds/:id/repair', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const url = req.body?.url;
  res.json(url ? await store.accepterReparation(id, String(url)) : await store.reparerFlux(id));
}));

// Va chercher l'illustration sur la page des articles qui n'en ont pas.
app.post('/api/articles/images', wrap(async (req, res) => {
  res.json(await store.completerImages({ limite: Number(req.body?.limit) || 60 }));
}));

/* -------------------------------------------------------------- articles */

app.get('/api/articles', (req, res) => {
  res.json(store.queryArticles({
    view: req.query.view,
    feedId: req.query.feed,
    folder: req.query.folder,
    q: req.query.q,
    tag: req.query.tag,
    limit: req.query.limit,
    before: req.query.before
  }));
});

/* ------------------------------------------------------------ etiquettes */

app.get('/api/tags', (req, res) => res.json({ tags: store.listTags(), palette: store.PALETTE_TAGS }));

app.post('/api/tags', (req, res) => res.status(201).json(store.createTag(req.body?.name)));

// { add: [...] } | { remove: [...] } | { set: [...] } — noms d'étiquettes.
app.post('/api/articles/:id/tags', (req, res) => {
  const corps = req.body || {};
  const liste = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
  res.json(store.tagArticle(Number(req.params.id), {
    add: liste(corps.add),
    remove: liste(corps.remove),
    ...(corps.set !== undefined ? { set: liste(corps.set) } : {})
  }));
});

// { name } renomme (fusionne si le nom existe deja), { color } reteinte.
app.patch('/api/tags/:id', (req, res) => {
  res.json(store.updateTag(Number(req.params.id), req.body || {}));
});

app.delete('/api/tags/:id', (req, res) => {
  const ok = store.deleteTag(Number(req.params.id));
  res.status(ok ? 200 : 404).json({ ok });
});

app.get('/api/articles/:id', (req, res) => {
  const article = store.getArticle(Number(req.params.id));
  if (!article) return res.status(404).json({ error: 'Article introuvable.' });
  res.json(article);
});

app.patch('/api/articles/:id', (req, res) => {
  const id = Number(req.params.id);
  let article = store.getArticle(id);
  if (!article) return res.status(404).json({ error: 'Article introuvable.' });
  if (req.body.read !== undefined) article = store.setRead(id, Boolean(req.body.read));
  if (req.body.starred !== undefined) article = store.setStarred(id, Boolean(req.body.starred));
  res.json(article);
});

// Recuperation du texte complet d'un article tronque (resultat mis en cache).
app.post('/api/articles/:id/full', wrap(async (req, res) => {
  const article = await store.fetchFullText(Number(req.params.id), { force: req.query.force === '1' });
  res.json(article);
}));

app.post('/api/articles/read', (req, res) => {
  const changed = store.markRead(req.body || {});
  res.json({ changed, counts: store.counts() });
});

/* ------------------------------------------------------------------ OPML */

app.post('/api/opml/import', wrap(async (req, res) => {
  const xml = typeof req.body === 'string' ? req.body : req.body?.opml;
  if (!xml) return res.status(400).json({ error: 'Fichier OPML vide.' });

  const result = importOpml(xml, { defaultFolder: req.query.folder || '' });
  res.json(result);

  // Le premier telechargement peut durer : on le lance apres avoir repondu.
  store.refreshAll().catch((error) => console.error('[bublee] refresh apres import :', error.message));
}));

app.get('/api/opml/export', (req, res) => {
  res.type('application/xml').set(
    'Content-Disposition',
    'attachment; filename="bublee-' + new Date().toISOString().slice(0, 10) + '.opml"'
  ).send(exportOpml());
});

/* ------------------------------------------- relais d'images (anti hotlink) */

app.get('/api/image', wrap(async (req, res) => {
  const parsed = urlPubliqueOuNull(req.query.url || '');
  if (!parsed) return res.status(400).end();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const upstream = await fetch(parsed.href, {
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT_NAVIGATEUR, accept: 'image/*,*/*;q=0.8', referer: parsed.origin + '/' }
    });
    if (!upstream.ok) return res.status(upstream.status).end();

    const type = upstream.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(type)) return res.status(415).end();

    res.set('content-type', type).set('cache-control', 'public, max-age=604800');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(504).end();
  } finally {
    clearTimeout(timer);
  }
}));

/* --------------------------------------------------------------- statique */

app.use(express.static(path.join(root, 'public'), { maxAge: 0, etag: true, index: 'index.html' }));
app.get('*', (req, res) => res.sendFile(path.join(root, 'public', 'index.html')));

app.use((error, req, res, next) => {
  const status = error.status || 500;
  if (status >= 500) console.error('[bublee]', error);
  res.status(status).json({ error: error.message || 'Erreur interne.', ...(error.feedId ? { feedId: error.feedId } : {}) });
});

/* ------------------------------------------------ rafraichissement auto */

let refreshTimer = null;

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const minutes = Number(store.getSetting('refresh_minutes', '30'));
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  refreshTimer = setInterval(() => {
    store.refreshAll()
      .then((r) => {
        if (r.added) console.log(`[bublee] ${r.added} nouvel(s) article(s).`);
        return store.completerImages();
      })
      .catch((error) => console.error('[bublee] refresh auto :', error.message));
  }, minutes * 60 * 1000);
  refreshTimer.unref?.();
}

function openBrowser(url) {
  if (process.env.BUBLEE_NO_OPEN) return;
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* tant pis */ }
}

app.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`\n  Bublee    →  ${url}`);
  console.log(`  API       →  ${url}/api`);
  if (NIVEAU !== 'off') console.log(`  jeton API →  ${jeton()}   (portée : ${NIVEAU})`);
  console.log('');

  // Base existante : on rattache les doublons deja stockes (import OPML, notamment).
  if (migrationApplied) {
    const lies = store.dedupeExistants();
    if (lies) console.log(`[bublee] ${lies} doublon(s) rattaché(s) dans la base existante.`);
  }

  scheduleRefresh();
  openBrowser(url);
  // Un rafraichissement au demarrage, en tache de fond.
  setTimeout(() => store.refreshAll().then(() => store.completerImages()).catch(() => {}), 2000);
});
