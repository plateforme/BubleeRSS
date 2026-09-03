// L'application Express : toutes les routes, sans ecouter. C'est index.js
// qui ecoute, ouvre le navigateur et lance les taches de fond — separer les
// deux permet de tester chaque route sur un port ephemere, sans serveur.
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from './store.js';
import { importOpml, exportOpml } from './opml.js';
import { urlPubliqueOuNull, httpGet } from './http.js';
import { identifier, exigeCompte, exigeSuper, cors, cookies, jeton, regenererJeton } from './apikey.js';
import * as comptes from './comptes.js';
import { adopterOrphelins, db } from './db.js';
import * as cacheImages from './cache-images.js';
import { entetes } from './entetes.js';
import { gardeConnexion, nettoyer as nettoyerLimiteur } from './limiteur.js';
import { fichiers, lire as lireStatique, servir as servirStatique } from './statique.js';
import { listerRegles, creerRegle, modifierRegle, supprimerRegle } from './regles.js';

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

export const app = express();
app.disable('x-powered-by');
app.use(entetes);
app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: ['application/xml', 'text/xml', 'text/plain', 'application/octet-stream'], limit: '32mb' }));

/** Enveloppe une route async pour que les rejets partent dans le gestionnaire d'erreurs. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.set('trust proxy', 'loopback');
app.use(cookies);
app.use('/api', cors, identifier);

/** Le compte de la requete, une fois pour toutes. */
const moi = (req) => req.compte.id;

/* ---------------------------------------------------------------- vie */

// Sans compte ni jeton : c'est ce qu'un HEALTHCHECK Docker ou une sonde peut
// interroger. Il ne dit rien d'autre que « je reponds ».
app.get('/api/ping', (req, res) => res.json({ ok: true, version: VERSION }));

/* --------------------------------------------------------- mise en route */

/* Tant qu'aucun compte n'existe, l'API n'a personne a qui repondre. La seule
   route ouverte est celle qui cree le premier compte — qui devient super et
   adopte la bibliotheque d'avant les comptes. */
app.get('/api/auth/etat', (req, res) => {
  res.json({
    installe: comptes.nombreDeComptes() > 0,
    compte: req.compte
      ? { id: req.compte.id, email: req.compte.email, nom: req.compte.nom, role: req.compte.role }
      : null
  });
});

app.post('/api/auth/installer', wrap(async (req, res) => {
  if (comptes.nombreDeComptes() > 0) {
    return res.status(409).json({ error: 'Bublee est déjà installé : connecte-toi.' });
  }
  const compte = await comptes.creerCompte({ ...req.body, role: 'super' });
  const repris = adopterOrphelins(compte.id);
  const jetonSession = comptes.ouvrirSession(compte.id, { agent: req.get('user-agent'), ip: req.ip });
  comptes.poserCookie(res, jetonSession, req.secure || req.get('x-forwarded-proto') === 'https');
  res.status(201).json({ compte, repris });
}));

/* ------------------------------------------------------------ connexion */

app.post('/api/auth/login', gardeConnexion, wrap(async (req, res) => {
  const { email, motDePasse } = req.body || {};
  const compte = comptes.compteParEmail(email);

  // Meme message et meme cout dans les deux cas : on ne dit pas si l'adresse
  // existe, et on ne laisse pas le temps de reponse le dire non plus.
  const ok = compte && compte.actif && await comptes.verifierMotDePasse(motDePasse || '', compte.mot_de_passe);
  if (!ok) {
    if (!compte) await comptes.verifierMotDePasse(String(motDePasse || ''), 'scrypt$32768$8$1$AAAA$AAAA');
    req.limiteur.echec();
    return res.status(401).json({ error: 'Adresse ou mot de passe incorrect.' });
  }
  req.limiteur.reussite();

  const jetonSession = comptes.ouvrirSession(compte.id, { agent: req.get('user-agent'), ip: req.ip });
  comptes.poserCookie(res, jetonSession, req.secure || req.get('x-forwarded-proto') === 'https');
  res.json({ compte: comptes.compteParId(compte.id) });
}));

app.post('/api/auth/logout', (req, res) => {
  comptes.fermerSession(comptes.jetonDuCookie(req));
  comptes.retirerCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/moi', exigeCompte, (req, res) => {
  res.json({ compte: req.compte, sessions: comptes.listerSessions(req.compte.id).length });
});

app.patch('/api/auth/moi', exigeCompte, wrap(async (req, res) => {
  const { nom, motDePasse, motDePasseActuel } = req.body || {};
  if (motDePasse !== undefined) {
    // Changer son mot de passe exige de connaitre l'ancien : sinon une session
    // volee suffirait a s'approprier le compte pour de bon.
    const complet = comptes.compteParEmail(req.compte.email);
    if (!await comptes.verifierMotDePasse(motDePasseActuel || '', complet.mot_de_passe)) {
      return res.status(403).json({ error: 'Mot de passe actuel incorrect.' });
    }
  }
  res.json({ compte: await comptes.modifierCompte(req.compte.id, { nom, motDePasse }) });
}));

app.post('/api/auth/deconnecter-partout', exigeCompte, (req, res) => {
  const fermees = comptes.fermerToutesLesSessions(req.compte.id);
  comptes.retirerCookie(res);
  res.json({ fermees });
});

/* ------------------------------------------------- administration (super) */

app.get('/api/users', exigeCompte, exigeSuper, (req, res) => res.json({ comptes: comptes.listerComptes() }));

app.post('/api/users', exigeCompte, exigeSuper, wrap(async (req, res) => {
  res.status(201).json({ compte: await comptes.creerCompte(req.body || {}) });
}));

app.patch('/api/users/:id', exigeCompte, exigeSuper, wrap(async (req, res) => {
  const cible = Number(req.params.id);
  const patch = { ...(req.body || {}) };
  // Un super ne peut pas se retirer a lui-meme son role ni son activite : la
  // maladresse couterait l'acces a l'administration.
  if (cible === req.compte.id) { delete patch.role; delete patch.actif; }
  res.json({ compte: await comptes.modifierCompte(cible, patch, { parSuper: true }) });
}));

app.delete('/api/users/:id', exigeCompte, exigeSuper, (req, res) => {
  const cible = Number(req.params.id);
  if (cible === req.compte.id) {
    return res.status(409).json({ error: 'On ne supprime pas son propre compte depuis l’administration.' });
  }
  res.json({ ok: comptes.supprimerCompte(cible) });
});

/* Toutes les routes qui suivent exigent un compte. */
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/etat' || req.path === '/auth/installer' || req.path === '/auth/login') return next();
  exigeCompte(req, res, next);
});

/* ------------------------------------------------------- carte de l'API */

const ROUTES = [
  ['GET',    '/api/ping',                'vie du service, sans compte'],
  ['GET',    '/api/auth/etat',           'installe ? qui suis-je ?'],
  ['POST',   '/api/auth/installer',      'creer le premier compte (super)'],
  ['POST',   '/api/auth/login',          'ouvrir une session { email, motDePasse }'],
  ['POST',   '/api/auth/logout',         'fermer la session'],
  ['GET',    '/api/auth/moi',            'mon compte'],
  ['PATCH',  '/api/auth/moi',            'changer mon nom ou mon mot de passe'],
  ['GET',    '/api/users',               'liste des comptes (super)'],
  ['POST',   '/api/users',               'creer un compte (super) { email, nom, motDePasse, role }'],
  ['PATCH',  '/api/users/:id',           'modifier un compte (super) { nom, role, actif, motDePasse }'],
  ['DELETE', '/api/users/:id',           'supprimer un compte et tout son contenu (super)'],
  ['GET',    '/api',                     'cette liste'],
  ['GET',    '/api/health',              'etat du service'],
  ['GET',    '/api/state',               'flux, dossiers, compteurs et reglages'],
  ['PUT',    '/api/settings',            'modifier les reglages'],
  ['GET',    '/api/feeds',               'liste des sources'],
  ['POST',   '/api/feeds',               'ajouter une source { url, folder?, title? }'],
  ['PATCH',  '/api/feeds/:id',           'renommer, deplacer, ou changer la priorite { suivi | survol | muet }'],
  ['DELETE', '/api/feeds/:id',           'supprimer une source'],
  ['POST',   '/api/feeds/:id/refresh',   'rafraichir une source'],
  ['POST',   '/api/refresh',             'rafraichir toutes les sources'],
  ['POST',   '/api/feeds/repair',        'retrouver l’adresse des sources injoignables'],
  ['POST',   '/api/feeds/:id/repair',    'reparer une source precise'],
  ['GET',    '/api/articles',            'articles ; parametres view, feed, folder, q, tag, limit, before, sort'],
  ['GET',    '/api/articles/:id',        'un article avec son contenu'],
  ['PATCH',  '/api/articles/:id',        'marquer lu / favori { read?, starred? }'],
  ['POST',   '/api/articles/:id/full',   'recuperer le texte complet (?force=1 pour relancer)'],
  ['POST',   '/api/articles/read',       'marquer lu en masse { ids | feedId | folder | all | olderThan }'],
  ['POST',   '/api/articles/unread',     'annuler un marquage en masse { stamp }'],
  ['POST',   '/api/articles/images',     'chercher les illustrations manquantes'],
  ['GET',    '/api/tags',                'etiquettes, couleurs et nombre d’articles'],
  ['POST',   '/api/tags',                'creer une etiquette { name }'],
  ['POST',   '/api/articles/:id/tags',   'etiqueter { add | remove | set }'],
  ['POST',   '/api/articles/:id/color',  'couleurs de l illustration { color }'],
  ['PATCH',  '/api/tags/:id',            'renommer ou reteindre { name?, color? }'],
  ['DELETE', '/api/tags/:id',            'supprimer une etiquette'],
  ['GET',    '/api/rules',               'les regles de filtrage'],
  ['POST',   '/api/rules',               'ajouter une regle { motif, champ?, action?, valeur?, feedId? }'],
  ['POST',   '/api/rules/essai',         'ce qu une regle attraperait, sans rien changer'],
  ['POST',   '/api/rules/rejouer',       'rejouer les regles sur les non-lus { id? }'],
  ['PATCH',  '/api/rules/:id',           'activer ou desactiver une regle { actif }'],
  ['DELETE', '/api/rules/:id',           'supprimer une regle'],
  ['POST',   '/api/dedupe',              'rechercher les doublons deja en base'],
  ['POST',   '/api/opml/import',         'importer un OPML (corps = XML)'],
  ['GET',    '/api/opml/export',         'exporter les sources en OPML'],
  ['GET',    '/api/backup',              'telecharger une copie coherente de la base (super)'],
  ['GET',    '/api/image',               'relais d’images ; parametre url']
];

app.get('/api', (req, res) => {
  res.json({
    name: 'Bublee',
    version: VERSION,
    auth: {
      modes: ['session (cookie)', 'jeton personnel'],
      header: 'Authorization: Bearer <jeton>',
      note: 'Chaque compte a son jeton, visible dans ses réglages. Aucune adresse IP n’est dispensée.'
    },
    compte: { id: req.compte.id, email: req.compte.email, role: req.compte.role },
    endpoints: ROUTES.map(([method, path, description]) => ({ method, path, description }))
  });
});

app.get('/api/health', wrap(async (req, res) => {
  const counts = store.counts(moi(req));
  res.json({
    ok: true, version: VERSION, uptime: Math.round(process.uptime()),
    ...counts,
    cacheImages: await cacheImages.etat()
  });
}));

// Le jeton est personnel : chacun le sien, revocable sans toucher aux autres.
app.get('/api/token', (req, res) => res.json({ token: jeton(moi(req)) }));
app.post('/api/token/rotate', (req, res) => res.json({ token: regenererJeton(moi(req)) }));

// ?rebuild=1 recalcule les cles et refait tout le rapprochement a zero.
app.post('/api/dedupe', (req, res) => {
  const lies = req.query.rebuild === '1' ? store.recalculerDoublons(moi(req)) : store.dedupeExistants(moi(req));
  res.json({ linked: lies, rebuilt: req.query.rebuild === '1', counts: store.counts(moi(req)) });
});

/* ------------------------------------------------------------------ etat */

app.get('/api/state', (req, res) => {
  res.json({
    feeds: store.listFeeds(moi(req)),
    folders: store.listFolders(moi(req)),
    counts: store.counts(moi(req)),
    tags: store.listTags(moi(req)),
    palette: store.PALETTE_TAGS,
    accents: store.PALETTE_ACCENT,
    settings: {
      refreshMinutes: Number(store.getSetting('refresh_minutes', '30', moi(req))),
      retentionDays: Number(store.getSetting('retention_days', '90', moi(req))),
      theme: store.getSetting('theme', 'auto', moi(req)),
      accent: store.getSetting('accent', store.PALETTE_ACCENT[0].valeur, moi(req)),
      layout: store.getSetting('layout', 'magazine', moi(req)),
      fulltext: store.getSetting('fulltext', 'auto', moi(req)),
      fulltextMinWords: Number(store.getSetting('fulltext_min_words', '250', moi(req)))
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
    if (req.body[key] !== undefined) store.setSetting(column, req.body[key], moi(req));
  }
  scheduleRefresh();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ flux */

app.get('/api/feeds', (req, res) => res.json(store.listFeeds(moi(req))));

app.post('/api/feeds', wrap(async (req, res) => {
  const { url, folder = '', title = '' } = req.body || {};
  if (!url || !String(url).trim()) return res.status(400).json({ error: 'Adresse manquante.' });
  const result = await store.addFeed(moi(req), String(url).trim(), folder, title);
  res.status(201).json(result);
}));

app.patch('/api/feeds/:id', (req, res) => {
  res.json(store.updateFeed(Number(req.params.id), req.body || {}, moi(req)));
});

app.delete('/api/feeds/:id', (req, res) => {
  const ok = store.deleteFeed(Number(req.params.id), moi(req));
  res.status(ok ? 200 : 404).json({ ok });
});

app.post('/api/feeds/:id/refresh', wrap(async (req, res) => {
  if (!store.getFeed(Number(req.params.id), moi(req))) return res.status(404).json({ error: 'Flux introuvable.' });
  res.json(await store.refreshFeed(Number(req.params.id)));
}));

app.post('/api/refresh', wrap(async (req, res) => {
  // Demande a la main : on reessaie meme les sources qui ont reculé.
  const resultat = await store.refreshAll({ force: true });
  res.json(resultat);
  // Les illustrations manquantes se cherchent apres coup, sans faire attendre.
  store.completerImages({}, moi(req)).catch(() => {});
}));

// Retrouve l'adresse actuelle des flux devenus injoignables.
app.post('/api/feeds/repair', wrap(async (req, res) => {
  res.json(await store.reparerSourcesCassees(moi(req)));
}));

// Sans corps : on cherche. Avec { url } : on applique la proposition retenue.
app.post('/api/feeds/:id/repair', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const url = req.body?.url;
  res.json(url ? await store.accepterReparation(id, String(url), moi(req)) : await store.reparerFlux(id, moi(req)));
}));

// Va chercher l'illustration sur la page des articles qui n'en ont pas.
app.post('/api/articles/images', wrap(async (req, res) => {
  res.json(await store.completerImages({ limite: Number(req.body?.limit) || 60 }, moi(req)));
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
    before: req.query.before,
    sort: req.query.sort
  }, moi(req)));
});

/* ------------------------------------------------------------ etiquettes */

app.get('/api/tags', (req, res) => res.json({ tags: store.listTags(moi(req)), palette: store.PALETTE_TAGS }));

app.post('/api/tags', (req, res) => res.status(201).json(store.createTag(req.body?.name, moi(req))));

// { add: [...] } | { remove: [...] } | { set: [...] } — noms d'étiquettes.
app.post('/api/articles/:id/tags', (req, res) => {
  const corps = req.body || {};
  const liste = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
  const article = store.tagArticle(Number(req.params.id), {
    add: liste(corps.add),
    remove: liste(corps.remove),
    ...(corps.set !== undefined ? { set: liste(corps.set) } : {})
  }, moi(req));
  // Les etiquettes suivent : leur nombre d'articles vient de changer.
  res.json({ ...avecCompteurs(req, article), tags_liste: store.listTags(moi(req)) });
});

// Les couleurs sont calculees par le navigateur : le format est verifie ici.
app.post('/api/articles/:id/color', (req, res) => {
  res.json(store.enregistrerCouleurImage(Number(req.params.id), (req.body || {}).color, moi(req)));
});

// { name } renomme (fusionne si le nom existe deja), { color } reteinte.
app.patch('/api/tags/:id', (req, res) => {
  res.json(store.updateTag(Number(req.params.id), req.body || {}, moi(req)));
});

app.delete('/api/tags/:id', (req, res) => {
  const ok = store.deleteTag(Number(req.params.id), moi(req));
  res.status(ok ? 200 : 404).json({ ok });
});

app.get('/api/articles/:id', (req, res) => {
  const article = store.getArticle(Number(req.params.id), moi(req));
  if (!article) return res.status(404).json({ error: 'Article introuvable.' });
  res.json(article);
});

/* La reponse porte les compteurs a jour : sans eux, le navigateur redemandait
   tout l'etat — sources, dossiers, etiquettes, reglages — apres chaque
   article ouvert, chaque favori et chaque etiquette posee. */
const avecCompteurs = (req, article) => ({
  ...article,
  counts: store.counts(moi(req)),
  feeds: store.compteursSources(moi(req))
});

app.patch('/api/articles/:id', (req, res) => {
  const id = Number(req.params.id);
  let article = store.getArticle(id, moi(req));
  if (!article) return res.status(404).json({ error: 'Article introuvable.' });
  if (req.body.read !== undefined) article = store.setRead(id, Boolean(req.body.read), moi(req));
  if (req.body.starred !== undefined) article = store.setStarred(id, Boolean(req.body.starred), moi(req));
  res.json(avecCompteurs(req, article));
});

// Recuperation du texte complet d'un article tronque (resultat mis en cache).
app.post('/api/articles/:id/full', wrap(async (req, res) => {
  const article = await store.fetchFullText(Number(req.params.id), { force: req.query.force === '1' }, moi(req));
  res.json(article);
}));

app.post('/api/articles/read', (req, res) => {
  const { changed, stamp } = store.markRead(req.body || {}, moi(req));
  res.json({ changed, stamp, counts: store.counts(moi(req)), feeds: store.compteursSources(moi(req)) });
});

// Annule un marquage en masse : tout le lot porte le meme horodatage.
app.post('/api/articles/unread', (req, res) => {
  const changed = store.annulerLecture(req.body?.stamp, moi(req));
  res.json({ changed, counts: store.counts(moi(req)), feeds: store.compteursSources(moi(req)) });
});

/* ------------------------------------------------------------------ OPML */

app.post('/api/opml/import', wrap(async (req, res) => {
  const xml = typeof req.body === 'string' ? req.body : req.body?.opml;
  if (!xml) return res.status(400).json({ error: 'Fichier OPML vide.' });

  const result = importOpml(xml, { defaultFolder: req.query.folder || '' }, moi(req));
  res.json(result);

  // Le premier telechargement peut durer : on le lance apres avoir repondu.
  store.refreshAll().catch((error) => console.error('[bublee] refresh apres import :', error.message));
}));

app.get('/api/opml/export', (req, res) => {
  res.type('application/xml').set(
    'Content-Disposition',
    'attachment; filename="bublee-' + new Date().toISOString().slice(0, 10) + '.opml"'
  ).send(exportOpml(moi(req)));
});

/* -------------------------------------------------------------- regles */

app.get('/api/rules', (req, res) => res.json({ rules: listerRegles(moi(req)) }));

app.post('/api/rules', (req, res) => {
  const regle = creerRegle(moi(req), req.body || {});
  // On rejoue tout de suite sur la pile : une règle écrite aujourd'hui doit
  // pouvoir nettoyer les non-lus d'hier.
  const rejoue = req.query.rejouer === '0' ? null : store.rejouerRegles(moi(req), { regleId: regle.id });
  res.status(201).json({ rule: regle, rejoue, counts: store.counts(moi(req)), feeds: store.compteursSources(moi(req)) });
});

// Ce qu'une regle attraperait, sans rien changer.
app.post('/api/rules/essai', (req, res) => res.json(store.essayerRegle(moi(req), req.body || {})));

app.patch('/api/rules/:id', (req, res) => res.json({ rule: modifierRegle(req.params.id, moi(req), req.body || {}) }));

app.delete('/api/rules/:id', (req, res) => {
  const ok = supprimerRegle(req.params.id, moi(req));
  res.status(ok ? 200 : 404).json({ ok });
});

app.post('/api/rules/rejouer', (req, res) => {
  const rejoue = store.rejouerRegles(moi(req), { regleId: req.body?.id ?? null });
  res.json({ ...rejoue, counts: store.counts(moi(req)), feeds: store.compteursSources(moi(req)) });
});

/* ---------------------------------------------------------- sauvegarde */

/**
 * La base est « le seul fichier a sauvegarder » : encore faut-il pouvoir la
 * prendre. Une copie a chaud pendant un rafraichissement donnerait un fichier
 * incoherent ; l'API de sauvegarde de SQLite, elle, rend une base valide meme
 * si des ecritures ont lieu pendant la copie.
 *
 * Reserve au super : la base porte tous les comptes, pas seulement le sien.
 */
app.get('/api/backup', exigeSuper, wrap(async (req, res) => {
  const nom = 'bublee-' + new Date().toISOString().slice(0, 10) + '.db';
  const copie = path.join(os.tmpdir(), `bublee-sauvegarde-${process.pid}-${Date.now()}.db`);
  try {
    await db.backup(copie);
    res.set('content-disposition', `attachment; filename="${nom}"`);
    res.set('content-type', 'application/vnd.sqlite3');
    res.set('content-length', String(fs.statSync(copie).size));
    await new Promise((fini, rate) => {
      const flot = fs.createReadStream(copie);
      flot.on('error', rate);
      res.on('finish', fini);
      res.on('close', fini);
      flot.pipe(res);
    });
  } finally {
    fs.promises.unlink(copie).catch(() => {});
  }
}));

/* ------------------------------------------- relais d'images (anti hotlink) */

/** Au-dela, ce n'est plus une illustration d'article. */
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

app.get('/api/image', wrap(async (req, res) => {
  const parsed = urlPubliqueOuNull(req.query.url || '');
  if (!parsed) return res.status(400).end();

  // Deja vue : on la sert du disque, sans repartir chez l'editeur.
  const gardee = await cacheImages.lire(parsed.href);
  if (gardee) {
    return res.set('content-type', gardee.type)
      .set('cache-control', 'public, max-age=604800')
      .set('x-bublee-cache', 'disque')
      .send(gardee.corps);
  }

  try {
    // Meme couche que les flux : adresse resolue verifiee, redirections
    // revues une a une, et le telechargement coupe au-dela du plafond.
    const { res: upstream, buffer: corps } = await httpGet(parsed.href, {
      navigateur: true, timeout: 15000, maxBytes: IMAGE_MAX_BYTES,
      headers: { accept: 'image/*,*/*;q=0.8', referer: parsed.origin + '/' }
    });
    if (!upstream.ok) return res.status(upstream.status).end();

    const type = upstream.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(type)) return res.status(415).end();

    res.set('content-type', type).set('cache-control', 'public, max-age=604800')
      .set('x-bublee-cache', 'reseau').send(corps);

    // Rangee apres l'envoi : le cache ne doit jamais retarder l'affichage.
    cacheImages.ranger(parsed.href, type, corps).catch(() => {});
  } catch (error) {
    res.status(error.status || 504).end();
  }
}));

/* --------------------------------------------------------------- statique */

// Une route d'API inconnue est une erreur, pas une page : l'application ne
// doit pas repondre index.html a un script qui s'est trompe d'adresse.
app.all('/api/*', (req, res) => res.status(404).json({ error: 'Route inconnue : ' + req.method + ' ' + req.path }));

const PUBLIC = path.join(root, 'public');
app.use(fichiers(PUBLIC));

// Toute autre adresse est une vue de l'application : c'est l'index qui repond,
// et le routage se fait dans le navigateur.
app.get('*', (req, res, suite) => {
  const index = lireStatique(path.join(PUBLIC, 'index.html'));
  if (!index) return suite();
  servirStatique(req, res, index, 'no-cache');
});

 
app.use((error, req, res, next) => {
  const status = error.status || 500;
  if (status >= 500) console.error('[bublee]', error);
  // Un message d'erreur interne — SQL, pile, chemin — ne regarde pas le client.
  const message = status >= 500 ? 'Erreur interne.' : error.message || 'Erreur.';
  res.status(status).json({ error: message, ...(error.feedId ? { feedId: error.feedId } : {}) });
});

/* ------------------------------------------------ rafraichissement auto */

let refreshTimer = null;

/**
 * Arme (ou re-arme) le rafraichissement periodique au rythme du premier super.
 *
 * Un setTimeout rechaine plutot qu'un setInterval : l'intervalle comptait a
 * partir du depart de la passe, si bien qu'une passe plus longue que le
 * rythme faisait empiler les suivantes. Ici le delai part de l'arrivee.
 */
export function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  // Le rythme du service : celui du premier super, a defaut trente minutes.
  const patron = comptes.listerComptes().find((c) => c.role === 'super');
  const minutes = Number(store.getSetting('refresh_minutes', '30', patron?.id ?? 0));
  if (!Number.isFinite(minutes) || minutes <= 0) return;

  const tour = async () => {
    try {
      nettoyerLimiteur();
      const r = await store.refreshAll();
      if (r.added) console.log(`[bublee] ${r.added} nouvel(s) article(s).`);
      // Tache du service : elle passe sur chaque compte a son tour.
      for (const c of comptes.listerComptes()) await store.completerImages({}, c.id).catch(() => {});
    } catch (error) {
      console.error('[bublee] refresh auto :', error.message);
    }
    if (refreshTimer !== null) armer();
  };

  const armer = () => {
    refreshTimer = setTimeout(tour, minutes * 60 * 1000);
    refreshTimer.unref?.();
  };
  armer();
}

/** Desarme le rafraichissement, pour un arret propre ou un test. */
export function stopRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}
