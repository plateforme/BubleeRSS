// Toutes les operations metier : flux, articles, deduplication, texte complet.
import { db, getSetting, setSetting } from './db.js';
import { fetchFeed, discoverFeeds } from './feed.js';
import { urlKey, titleKey, TITRE_FIABLE, FENETRE_TITRE_MS } from './dedupe.js';
import { extraireTexteComplet, extraireImageDeLaPage } from './readable.js';
import { estYouTube } from './youtube.js';

const now = () => Date.now();

/* ------------------------------------------------------------------ flux */

export function listFeeds() {
  return db.prepare(`
    SELECT f.id, f.url, f.site_url, f.folder, f.icon, f.description,
           f.last_fetched_at, f.last_error, f.error_count, f.created_at,
           COALESCE(NULLIF(f.custom_title, ''), NULLIF(f.title, ''), f.url) AS title,
           f.custom_title,
           -- Le type de source porte sa propre marque dans l'index : on ne lit
           -- pas une chaine comme on lit un journal, on ne l'ecoute pas non plus.
           CASE
             WHEN f.url LIKE '%youtube.com/feeds/videos.xml%' THEN 'video'
             WHEN EXISTS (SELECT 1 FROM articles a WHERE a.feed_id = f.id AND a.duration IS NOT NULL) THEN 'podcast'
             ELSE 'article'
           END AS kind,
           (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id AND a.read_at IS NULL) AS unread,
           (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id) AS total
    FROM feeds f
    ORDER BY f.folder = '' DESC, f.folder COLLATE NOCASE, title COLLATE NOCASE
  `).all();
}

export function getFeed(id) {
  return db.prepare('SELECT * FROM feeds WHERE id = ?').get(id);
}

function iconFor(siteUrl) {
  if (!siteUrl) return null;
  try {
    return 'https://www.google.com/s2/favicons?sz=64&domain=' + new URL(siteUrl).hostname;
  } catch {
    return null;
  }
}

/** Ajoute un flux depuis une URL (page d'accueil acceptee : on cherche le flux). */
export async function addFeed(input, folder = '', title = '') {
  const candidates = await discoverFeeds(input);
  if (!candidates.length) {
    throw Object.assign(new Error('Aucun flux RSS ou Atom trouve a cette adresse.'), { status: 422 });
  }

  const chosen = candidates[0];
  const existing = db.prepare('SELECT id FROM feeds WHERE url = ?').get(chosen.url);
  if (existing) {
    throw Object.assign(new Error('Ce flux est deja dans ta bibliotheque.'), { status: 409, feedId: existing.id });
  }

  const info = db.prepare(`
    INSERT INTO feeds (url, title, custom_title, folder, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(chosen.url, chosen.title || '', title || null, folder || '', now());

  const feedId = Number(info.lastInsertRowid);
  const result = await refreshFeed(feedId);
  return { feed: getFeed(feedId), ...result, alternatives: candidates.slice(1) };
}

export function updateFeed(id, patch) {
  const feed = getFeed(id);
  if (!feed) throw Object.assign(new Error('Flux introuvable.'), { status: 404 });

  const fields = [];
  const values = [];
  for (const key of ['custom_title', 'folder', 'url']) {
    if (patch[key] !== undefined) {
      fields.push(key + ' = ?');
      values.push(patch[key] === '' && key === 'custom_title' ? null : patch[key]);
    }
  }
  if (!fields.length) return feed;
  values.push(id);
  db.prepare('UPDATE feeds SET ' + fields.join(', ') + ' WHERE id = ?').run(...values);
  return getFeed(id);
}

export function deleteFeed(id) {
  const supprime = db.prepare('DELETE FROM feeds WHERE id = ?').run(id).changes > 0;
  // Les doublons orphelins redeviennent des articles a part entiere.
  if (supprime) reconcilierDoublons();
  return supprime;
}

/* ------------------------------------------------ reparation des sources */

/** Mots significatifs d'un titre, pour comparer un candidat a l'ancien flux. */
function motsClefs(titre) {
  return new Set((titleKey(titre) || '').split(' ').filter((m) => m.length > 3));
}

/**
 * Ressemblance entre le titre du flux casse et celui d'un candidat, entre 0 et 1.
 * On regarde dans les deux sens : « Le Monde : Technologies » et
 * « Le Monde : à la une » partagent un mot, mais chacun en a d'autres —
 * ce sont deux rubriques differentes, pas le meme flux qui a demenage.
 */
function ressemblance(titreCandidat, feed) {
  const anciens = motsClefs(feed.custom_title || feed.title);
  const nouveaux = motsClefs(titreCandidat);
  if (!anciens.size || !nouveaux.size) return 0;

  let communs = 0;
  for (const mot of anciens) if (nouveaux.has(mot)) communs++;
  return Math.min(communs / anciens.size, communs / nouveaux.size);
}

/** Au-dela, on considere que c'est le meme flux qui a change d'adresse. */
const SEUIL_CERTITUDE = 0.75;

/**
 * Change l'adresse d'un flux en figeant son nom actuel comme libelle.
 * Sans cela le titre du nouveau flux ecraserait celui d'origine, et une
 * seconde reparation comparerait le candidat a lui-meme.
 */
function appliquerAdresse(id, url, { figerNom = false } = {}) {
  if (figerNom) {
    db.prepare(`
      UPDATE feeds SET
        url = ?, etag = NULL, last_modified = NULL,
        custom_title = COALESCE(NULLIF(custom_title, ''), NULLIF(title, ''))
      WHERE id = ?
    `).run(url, id);
    return;
  }
  db.prepare('UPDATE feeds SET url = ?, etag = NULL, last_modified = NULL WHERE id = ?').run(url, id);
}

/**
 * Cherche l'adresse actuelle d'un flux devenu injoignable : on interroge la
 * page du site, puis le domaine, puis l'ancienne adresse (qui redirige
 * parfois, ou renvoie du HTML au lieu du flux).
 *
 * Le candidat est verifie par un telechargement reel, mais la base n'est
 * modifiee que si le titre concorde vraiment. Sinon on se contente de
 * proposer : remplacer en silence « Best New Tracks » par le flux general
 * de Pitchfork serait pire que de laisser la source cassee.
 */
export async function reparerFlux(id) {
  const feed = getFeed(id);
  if (!feed) throw Object.assign(new Error('Flux introuvable.'), { status: 404 });

  const base = { feedId: id, title: feed.title, from: feed.url };
  let origine = null;
  try { origine = new URL(feed.url).origin; } catch { /* adresse illisible */ }

  const pistes = [...new Set([feed.site_url, origine, feed.url].filter(Boolean))];

  let candidats = [];
  for (const piste of pistes) {
    try {
      candidats = await discoverFeeds(piste);
    } catch { candidats = []; }
    if (candidats.length) break;
  }

  candidats = candidats.filter((c) => c.url !== feed.url);
  if (!candidats.length) return { ...base, status: 'introuvable' };

  const propositions = [];

  for (const candidat of candidats) {
    if (db.prepare('SELECT 1 FROM feeds WHERE url = ? AND id <> ?').get(candidat.url, id)) {
      propositions.push({ url: candidat.url, title: candidat.title, deja: true });
      continue;
    }

    let parsed;
    try {
      const essai = await fetchFeed(candidat.url);
      if (essai.notModified || !essai.parsed?.items?.length) continue;
      parsed = essai.parsed;
    } catch {
      continue; // candidat injoignable : suivant
    }

    const titre = parsed.title || candidat.title || '';
    const confiance = ressemblance(titre, feed);

    if (confiance >= SEUIL_CERTITUDE) {
      appliquerAdresse(id, candidat.url, { figerNom: true });
      const refresh = await refreshFeed(id);
      if (!refresh.error) {
        return { ...base, status: 'repare', to: candidat.url, toTitle: titre, added: refresh.added };
      }
      appliquerAdresse(id, feed.url);
    }

    propositions.push({ url: candidat.url, title: titre, confiance: Math.round(confiance * 100) });
  }

  const utiles = propositions.filter((p) => !p.deja).sort((a, b) => b.confiance - a.confiance);
  if (utiles.length) return { ...base, status: 'propose', candidates: utiles.slice(0, 4) };
  return { ...base, status: propositions.length ? 'doublon' : 'introuvable' };
}

/** Applique une proposition validee par l'utilisateur. */
export async function accepterReparation(id, url) {
  const feed = getFeed(id);
  if (!feed) throw Object.assign(new Error('Flux introuvable.'), { status: 404 });
  if (db.prepare('SELECT 1 FROM feeds WHERE url = ? AND id <> ?').get(url, id)) {
    throw Object.assign(new Error('Ce flux est déjà dans ta bibliothèque.'), { status: 409 });
  }

  const ancienne = feed.url;
  appliquerAdresse(id, url, { figerNom: true });
  const refresh = await refreshFeed(id);
  if (refresh.error) {
    appliquerAdresse(id, ancienne);
    throw Object.assign(new Error(refresh.error), { status: 502 });
  }
  dedupeExistants();
  return { feed: getFeed(id), added: refresh.added };
}

/** Passe en revue toutes les sources en erreur. */
export async function reparerSourcesCassees(concurrency = 5) {
  const ids = db.prepare('SELECT id FROM feeds WHERE last_error IS NOT NULL ORDER BY id').all().map((r) => r.id);
  const resultats = [];
  let curseur = 0;

  async function worker() {
    while (curseur < ids.length) {
      const id = ids[curseur++];
      try {
        resultats.push(await reparerFlux(id));
      } catch (error) {
        resultats.push({ feedId: id, status: 'echec', error: String(error.message) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  if (resultats.some((r) => r.status === 'repare')) {
    dedupeExistants();
    setSetting('last_refresh_at', now());
  }

  return {
    checked: ids.length,
    repaired: resultats.filter((r) => r.status === 'repare').length,
    proposed: resultats.filter((r) => r.status === 'propose').length,
    results: resultats
  };
}

export function listFolders() {
  return db.prepare(`
    SELECT folder AS name, COUNT(*) AS feeds
    FROM feeds WHERE folder <> '' GROUP BY folder ORDER BY folder COLLATE NOCASE
  `).all();
}

/* ------------------------------------------------------------ doublons */

const chercheParUrl = db.prepare(`
  SELECT id, feed_id, read_at, starred, title_key FROM articles
  WHERE url_key = ? AND dupe_of IS NULL
  ORDER BY id LIMIT 1
`);

const chercheParTitre = db.prepare(`
  SELECT id, feed_id, read_at, starred, title_key FROM articles
  WHERE title_key = ? AND dupe_of IS NULL AND ABS(published_at - ?) <= ?
  ORDER BY id LIMIT 1
`);

/**
 * Cherche un article deja stocke qui raconte la meme chose.
 * L'adresse normalisee prime ; le titre ne sert de secours que s'il est
 * assez long et que les deux publications sont proches dans le temps.
 */
function trouverOriginal(cleUrl, cleTitre, publieLe) {
  if (cleUrl) {
    const parUrl = chercheParUrl.get(cleUrl);
    if (parUrl) return parUrl;
  }
  if (cleTitre && cleTitre.length >= TITRE_FIABLE) {
    return chercheParTitre.get(cleTitre, publieLe, FENETRE_TITRE_MS) || null;
  }
  return null;
}

/**
 * Aligne l'etat « lu » a l'interieur de chaque groupe de doublons, dans les
 * deux sens : lire une copie suffit a marquer toute l'histoire comme lue.
 */
export function reconcilierDoublons() {
  const stamp = now();
  db.prepare(`
    UPDATE articles SET read_at = ?
    WHERE read_at IS NULL
      AND id IN (SELECT dupe_of FROM articles WHERE dupe_of IS NOT NULL AND read_at IS NOT NULL)
  `).run(stamp);
  db.prepare(`
    UPDATE articles SET read_at = ?
    WHERE read_at IS NULL
      AND dupe_of IN (SELECT id FROM articles WHERE read_at IS NOT NULL)
  `).run(stamp);
}

/**
 * Repasse sur les articles deja stockes pour rattacher ceux qui font doublon.
 * Indispensable apres un import OPML : les histoires reprises par plusieurs
 * sources sont deja en base, personne ne les a encore comparees.
 * Le plus ancien identifiant gagne et devient l'exemplaire de reference.
 */
export function dedupeExistants() {
  const lignes = db.prepare(`
    SELECT id, feed_id, url_key, title_key, published_at
    FROM articles WHERE dupe_of IS NULL ORDER BY id
  `).all();

  const parUrl = new Map();
  const parTitre = new Map();
  const aRattacher = [];

  for (const ligne of lignes) {
    let original = null;

    if (ligne.url_key) {
      const candidat = parUrl.get(ligne.url_key);
      // Meme garde qu'a l'insertion : dans un meme flux, l'adresse ne suffit pas.
      const suspect = candidat && candidat.feed_id === ligne.feed_id
        && ligne.title_key && candidat.title_key && ligne.title_key !== candidat.title_key;
      if (candidat && !suspect) original = candidat.id;
    }

    if (!original && ligne.title_key && ligne.title_key.length >= TITRE_FIABLE) {
      const candidats = parTitre.get(ligne.title_key);
      const proche = candidats?.find(
        (c) => Math.abs(c.published_at - ligne.published_at) <= FENETRE_TITRE_MS
      );
      if (proche) original = proche.id;
    }

    if (original) {
      aRattacher.push([original, ligne.id]);
      continue;
    }

    if (ligne.url_key && !parUrl.has(ligne.url_key)) parUrl.set(ligne.url_key, ligne);
    if (ligne.title_key) {
      if (!parTitre.has(ligne.title_key)) parTitre.set(ligne.title_key, []);
      parTitre.get(ligne.title_key).push({ id: ligne.id, published_at: ligne.published_at });
    }
  }

  if (aRattacher.length) {
    const maj = db.prepare('UPDATE articles SET dupe_of = ? WHERE id = ?');
    db.transaction(() => { for (const [original, copie] of aRattacher) maj.run(original, copie); })();
    reconcilierDoublons();
  }

  return aRattacher.length;
}

/**
 * Recalcule les cles de comparaison de toute la base et refait le
 * rapprochement a zero. A lancer quand les regles de detection changent.
 */
export function recalculerDoublons() {
  const lignes = db.prepare('SELECT id, url, title FROM articles').all();
  const maj = db.prepare('UPDATE articles SET url_key = ?, title_key = ?, dupe_of = NULL WHERE id = ?');
  db.transaction(() => {
    for (const ligne of lignes) maj.run(urlKey(ligne.url), titleKey(ligne.title), ligne.id);
  })();
  return dedupeExistants();
}

/** Le canonique et toutes ses copies. */
function groupe(id) {
  return db.prepare(`
    SELECT a.id FROM articles a, (SELECT COALESCE(dupe_of, id) AS racine FROM articles WHERE id = ?) g
    WHERE a.id = g.racine OR a.dupe_of = g.racine
  `).all(id).map((r) => r.id);
}

/** Les autres sources qui publient le meme article. */
function autresSources(id) {
  return db.prepare(`
    SELECT a.id, a.url, a.feed_id,
           COALESCE(NULLIF(f.custom_title, ''), NULLIF(f.title, ''), f.url) AS feed_title
    FROM articles a
    JOIN feeds f ON f.id = a.feed_id,
         (SELECT COALESCE(dupe_of, id) AS racine FROM articles WHERE id = ?) g
    WHERE (a.id = g.racine OR a.dupe_of = g.racine) AND a.id <> ?
    ORDER BY feed_title COLLATE NOCASE
  `).all(id, id);
}

/* -------------------------------------------------------- rafraichissement */

const majArticle = db.prepare(`
  UPDATE articles SET title = @title, summary = @summary, content = @content,
    image = COALESCE(@image, image), word_count = @word_count,
    duration = COALESCE(@duration, duration),
    url_key = @url_key, title_key = @title_key
  WHERE id = @id AND read_at IS NULL AND content <> @content
`);

const insertArticle = db.prepare(`
  INSERT INTO articles
    (feed_id, guid, url, title, author, summary, content, image, published_at, fetched_at,
     word_count, duration, url_key, title_key, dupe_of, read_at, starred)
  VALUES
    (@feed_id, @guid, @url, @title, @author, @summary, @content, @image, @published_at, @fetched_at,
     @word_count, @duration, @url_key, @title_key, @dupe_of, @read_at, @starred)
`);

const parGuid = db.prepare('SELECT id FROM articles WHERE feed_id = ? AND guid = ?');

/**
 * Enregistre les entrees d'un flux en ecartant les doublons.
 * Retourne { ajoutes, doublons }. Exporte pour les tests.
 */
export const saveItems = db.transaction((feedId, items) => {
  let ajoutes = 0;
  let doublons = 0;

  for (const item of items) {
    const guid = String(item.guid).slice(0, 512);
    const cleUrl = urlKey(item.url);
    const cleTitre = titleKey(item.title);

    const commun = {
      title: item.title,
      summary: item.summary,
      content: item.content,
      image: item.image,
      word_count: item.word_count,
      duration: item.duration ?? null,
      url_key: cleUrl,
      title_key: cleTitre
    };

    // 1. Deja connu sous ce guid : simple mise a jour du contenu.
    const connu = parGuid.get(feedId, guid);
    if (connu) {
      majArticle.run({ ...commun, id: connu.id });
      continue;
    }

    let original = trouverOriginal(cleUrl, cleTitre, item.published_at);

    // 2. Meme flux, guid different : republication seulement si le titre concorde.
    //    Sinon c'est un lien generique partage par plusieurs entrees du flux
    //    (podcasts qui pointent tous vers la racine du site, par exemple).
    if (original && original.feed_id === feedId) {
      const memeTitre = !cleTitre || !original.title_key || cleTitre === original.title_key;
      if (memeTitre) { doublons++; continue; }
      original = null;
    }

    // 3. Autre flux : on garde la ligne (le flux reste complet) mais elle est
    //    rattachee a l'original et reprend son etat de lecture.
    insertArticle.run({
      feed_id: feedId,
      guid,
      url: item.url,
      author: item.author,
      published_at: item.published_at,
      fetched_at: now(),
      dupe_of: original ? original.id : null,
      read_at: original ? original.read_at : null,
      starred: original ? original.starred : 0,
      ...commun
    });

    if (original) doublons++; else ajoutes++;
  }

  return { ajoutes, doublons };
});

export async function refreshFeed(id) {
  const feed = getFeed(id);
  if (!feed) throw Object.assign(new Error('Flux introuvable.'), { status: 404 });

  try {
    const result = await fetchFeed(feed.url, { etag: feed.etag, lastModified: feed.last_modified });

    if (result.notModified) {
      db.prepare('UPDATE feeds SET last_fetched_at = ?, last_error = NULL, error_count = 0 WHERE id = ?')
        .run(now(), id);
      return { feedId: id, added: 0, duplicates: 0, notModified: true };
    }

    const { ajoutes, doublons } = saveItems(id, result.parsed.items);

    // L'avatar d'une chaine YouTube vaut mieux que le logo generique du site.
    // Une seule fois : ensuite la colonne icon est renseignee.
    // Le logo generique de youtube.com ne distingue pas deux chaines : on le
    // remplace des qu'on peut par l'avatar de la chaine elle-meme.
    let avatar = null;
    const iconeGenerique = !feed.icon || /s2\/favicons/.test(feed.icon);
    if (iconeGenerique && estYouTube(feed.url) && result.parsed.siteUrl) {
      avatar = await extraireImageDeLaPage(result.parsed.siteUrl).catch(() => null);
    }

    db.prepare(`
      UPDATE feeds SET
        title = CASE WHEN ? <> '' THEN ? ELSE title END,
        site_url = COALESCE(?, site_url),
        description = COALESCE(NULLIF(?, ''), description),
        -- l'avatar trouvé gagne ; sinon on garde l'icône en place ; sinon le favicon
        icon = COALESCE(?, icon, ?),
        etag = ?, last_modified = ?, last_fetched_at = ?,
        last_error = NULL, error_count = 0
      WHERE id = ?
    `).run(
      result.parsed.title, result.parsed.title,
      result.parsed.siteUrl,
      result.parsed.description || '',
      avatar, iconFor(result.parsed.siteUrl || feed.url),
      result.etag, result.lastModified, now(), id
    );

    return { feedId: id, added: ajoutes, duplicates: doublons };
  } catch (error) {
    db.prepare(`
      UPDATE feeds SET last_fetched_at = ?, last_error = ?, error_count = error_count + 1 WHERE id = ?
    `).run(now(), String(error.message).slice(0, 300), id);
    return { feedId: id, added: 0, duplicates: 0, error: String(error.message) };
  }
}

/** Rafraichit tous les flux, six a la fois. */
export async function refreshAll(concurrency = 6) {
  const ids = db.prepare('SELECT id FROM feeds ORDER BY COALESCE(last_fetched_at, 0)').all().map((r) => r.id);
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      results.push(await refreshFeed(id));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  reconcilierDoublons();
  setSetting('last_refresh_at', now());
  pruneArticles();

  return {
    feeds: ids.length,
    added: results.reduce((sum, r) => sum + r.added, 0),
    duplicates: results.reduce((sum, r) => sum + r.duplicates, 0),
    errors: results.filter((r) => r.error).map((r) => ({ feedId: r.feedId, error: r.error }))
  };
}

/**
 * Certains flux (NYT, Google Actualites, agregateurs) ne joignent aucune
 * illustration. On va chercher l'image de partage sur la page de l'article,
 * par petits paquets pour ne pas marteler les sites. Chaque article n'est
 * essaye qu'une fois.
 */
export async function completerImages({ limite = 40, concurrency = 4 } = {}) {
  const lignes = db.prepare(`
    SELECT id, url FROM articles
    WHERE image IS NULL AND image_checked IS NULL AND url LIKE 'http%'
    ORDER BY published_at DESC LIMIT ?
  `).all(limite);
  if (!lignes.length) return { checked: 0, found: 0 };

  const marque = db.prepare('UPDATE articles SET image = ?, image_checked = ? WHERE id = ?');
  let trouvees = 0;
  let curseur = 0;

  async function worker() {
    while (curseur < lignes.length) {
      const ligne = lignes[curseur++];
      let image = null;
      try {
        image = await extraireImageDeLaPage(ligne.url);
      } catch { /* page injoignable : on marque quand meme pour ne pas boucler */ }
      marque.run(image, now(), ligne.id);
      if (image) trouvees++;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, lignes.length) }, worker));
  return { checked: lignes.length, found: trouvees };
}

/** Supprime les articles lus et anciens ; garde toujours les non-lus et les favoris. */
export function pruneArticles() {
  const days = Number(getSetting('retention_days', '90'));
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = now() - days * 24 * 3600 * 1000;
  return db.prepare(`
    DELETE FROM articles
    WHERE starred = 0 AND read_at IS NOT NULL AND published_at < ?
  `).run(cutoff).changes;
}

/* ------------------------------------------------------------ etiquettes */

/** Une etiquette se compare sans casse ni espaces superflus. */
function normaliserTag(nom) {
  const propre = String(nom || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return propre || null;
}

/**
 * Teintes des etiquettes. Choisies pour tenir dans les deux ambiances et
 * rester lisibles a la taille d'une pastille.
 */
/** Accents proposes dans les reglages. Le vert foret est la valeur par defaut. */
export const PALETTE_ACCENT = [
  { nom: 'Forêt',    valeur: '#10604a' },
  { nom: 'Vermillon', valeur: '#e2452a' },
  { nom: 'Klein',     valeur: '#1b3fd8' },
  { nom: 'Magenta',   valeur: '#d81e73' }
];

export const PALETTE_TAGS = [
  '#b23a25', // vermillon
  '#a8842c', // or
  '#4a7c59', // vert
  '#2f6690', // bleu
  '#7d4a72', // prune
  '#8a5a3b', // terre
  '#55606b', // ardoise
  '#6b7a3a'  // olive
];

/** La couleur la moins utilisee, pour que deux etiquettes voisines diffèrent. */
function couleurLibre() {
  const prises = db.prepare('SELECT color, COUNT(*) n FROM tags WHERE color IS NOT NULL GROUP BY color')
    .all().reduce((acc, r) => ({ ...acc, [r.color]: r.n }), {});
  return PALETTE_TAGS.reduce((meilleure, c) => ((prises[c] || 0) < (prises[meilleure] || 0) ? c : meilleure), PALETTE_TAGS[0]);
}

/** Toutes les etiquettes, avec le nombre d'articles distincts qu'elles portent. */
export function listTags() {
  return db.prepare(`
    SELECT t.id, t.name, t.color, t.created_at,
           COUNT(DISTINCT COALESCE(a.dupe_of, a.id)) AS count
    FROM tags t
    LEFT JOIN article_tags at ON at.tag_id = t.id
    LEFT JOIN articles a ON a.id = at.article_id
    GROUP BY t.id
    ORDER BY count DESC, t.name COLLATE NOCASE
  `).all();
}

/** Cree une etiquette vide, depuis le gestionnaire. */
export function createTag(nom) {
  const propre = normaliserTag(nom);
  if (!propre) throw Object.assign(new Error('Nom d’étiquette vide.'), { status: 400 });
  const connu = db.prepare('SELECT id, name, color FROM tags WHERE name = ?').get(propre);
  if (connu) return connu;

  const id = Number(db.prepare('INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)')
    .run(propre, couleurLibre(), now()).lastInsertRowid);
  return db.prepare('SELECT id, name, color FROM tags WHERE id = ?').get(id);
}

function tagsDe(articleId) {
  return db.prepare(`
    SELECT t.name FROM tags t
    JOIN article_tags at ON at.tag_id = t.id
    WHERE at.article_id = ?
    ORDER BY t.name COLLATE NOCASE
  `).all(articleId).map((r) => r.name);
}

function idDuTag(nom, creer = true) {
  const propre = normaliserTag(nom);
  if (!propre) return null;
  const connu = db.prepare('SELECT id FROM tags WHERE name = ?').get(propre);
  if (connu) return connu.id;
  if (!creer) return null;
  return Number(db.prepare('INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)')
    .run(propre, couleurLibre(), now()).lastInsertRowid);
}

/**
 * Pose ou retire des etiquettes. Comme la lecture et les favoris, elles
 * s'appliquent au groupe de doublons : la meme histoire reste retrouvable
 * quelle que soit la source par laquelle on l'a lue.
 */
export function tagArticle(id, { add = [], remove = [], set } = {}) {
  if (!db.prepare('SELECT 1 FROM articles WHERE id = ?').get(id)) {
    throw Object.assign(new Error('Article introuvable.'), { status: 404 });
  }
  const ids = groupe(id);
  const marque = db.prepare('INSERT INTO article_tags (article_id, tag_id, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
  const enleve = db.prepare('DELETE FROM article_tags WHERE article_id = ? AND tag_id = ?');

  db.transaction(() => {
    if (Array.isArray(set)) {
      const voulus = set.map((n) => idDuTag(n)).filter(Boolean);
      for (const article of ids) {
        db.prepare('DELETE FROM article_tags WHERE article_id = ?').run(article);
        for (const tag of voulus) marque.run(article, tag, now());
      }
      return;
    }
    for (const nom of add) {
      const tag = idDuTag(nom);
      if (tag) for (const article of ids) marque.run(article, tag, now());
    }
    for (const nom of remove) {
      const tag = idDuTag(nom, false);
      if (tag) for (const article of ids) enleve.run(article, tag);
    }
  })();

  return getArticle(id);
}

export function updateTag(id, { name, color } = {}) {
  if (color !== undefined) {
    const teinte = PALETTE_TAGS.includes(color) ? color : null;
    db.prepare('UPDATE tags SET color = ? WHERE id = ?').run(teinte, id);
  }
  if (name === undefined) return db.prepare('SELECT id, name, color FROM tags WHERE id = ?').get(id);

  const propre = normaliserTag(name);
  if (!propre) throw Object.assign(new Error('Nom d’étiquette vide.'), { status: 400 });

  const collision = db.prepare('SELECT id FROM tags WHERE name = ? AND id <> ?').get(propre, id);
  if (collision) {
    // Fusion : les articles de l'ancienne rejoignent la nouvelle.
    db.transaction(() => {
      db.prepare(`
        INSERT INTO article_tags (article_id, tag_id, added_at)
        SELECT article_id, ?, added_at FROM article_tags WHERE tag_id = ?
        ON CONFLICT DO NOTHING
      `).run(collision.id, id);
      db.prepare('DELETE FROM tags WHERE id = ?').run(id);
    })();
    return db.prepare('SELECT id, name, color FROM tags WHERE id = ?').get(collision.id);
  }

  db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(propre, id);
  return db.prepare('SELECT id, name, color FROM tags WHERE id = ?').get(id);
}

export function deleteTag(id) {
  return db.prepare('DELETE FROM tags WHERE id = ?').run(id).changes > 0;
}

/* -------------------------------------------------------------- articles */

const ARTICLE_COLUMNS = `
  a.id, a.feed_id, a.url, a.title, a.author, a.summary, a.image,
  a.published_at, a.read_at, a.starred, a.word_count, a.duration, a.dupe_of,
  (a.full_content IS NOT NULL) AS has_full,
  (SELECT GROUP_CONCAT(t.name, CHAR(31)) FROM article_tags at
     JOIN tags t ON t.id = at.tag_id WHERE at.article_id = a.id) AS tag_list,
  COALESCE(NULLIF(f.custom_title, ''), NULLIF(f.title, ''), f.url) AS feed_title,
  f.folder AS feed_folder, f.icon AS feed_icon
`;

// GROUP_CONCAT assemble les etiquettes en une seule chaine : on separe avec
// un caractere de controle, qu'un nom d'etiquette ne contiendra jamais.
const SEPARATEUR_TAGS = String.fromCharCode(31);

/** Redonne les etiquettes sous forme de tableau trie. */
function avecTags(row) {
  if (!row) return row;
  const { tag_list, ...reste } = row;
  return { ...reste, tags: tag_list ? tag_list.split(SEPARATEUR_TAGS).sort((a, b) => a.localeCompare(b, 'fr')) : [] };
}

/** view: all | unread | starred ; pagination par curseur (before = "publie,id"). */
export function queryArticles({ view = 'unread', feedId, folder, q, tag, limit = 30, before } = {}) {
  const where = [];
  const params = {};

  // `tag` accepte une etiquette, plusieurs separees par une virgule, ou un
  // tableau. Toutes doivent etre presentes : on cherche a restreindre.
  const etiquettes = (Array.isArray(tag) ? tag : String(tag ?? '').split(','))
    .map((t) => String(t).trim())
    .filter(Boolean);

  etiquettes.forEach((nom, i) => {
    params['tag' + i] = nom;
    where.push(`EXISTS (
      SELECT 1 FROM article_tags at JOIN tags t ON t.id = at.tag_id
      WHERE at.article_id = a.id AND t.name = @tag${i}
    )`);
  });

  // Hors d'un flux precis, on n'affiche qu'un exemplaire de chaque histoire.
  if (!feedId) where.push('a.dupe_of IS NULL');

  if (view === 'unread') where.push('a.read_at IS NULL');
  if (view === 'starred') where.push('a.starred = 1');
  if (feedId) { where.push('a.feed_id = @feedId'); params.feedId = Number(feedId); }
  if (folder) { where.push('f.folder = @folder'); params.folder = folder; }
  if (q) {
    where.push('(a.title LIKE @q OR a.summary LIKE @q OR a.author LIKE @q)');
    params.q = '%' + q + '%';
  }
  if (before) {
    const [ts, id] = String(before).split(',').map(Number);
    if (Number.isFinite(ts) && Number.isFinite(id)) {
      where.push('(a.published_at < @beforeTs OR (a.published_at = @beforeTs AND a.id < @beforeId))');
      params.beforeTs = ts;
      params.beforeId = id;
    }
  }

  params.limit = Math.min(Number(limit) || 30, 200);

  const rows = db.prepare(`
    SELECT ${ARTICLE_COLUMNS}
    FROM articles a JOIN feeds f ON f.id = a.feed_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.published_at DESC, a.id DESC
    LIMIT @limit
  `).all(params);

  const last = rows[rows.length - 1];
  return {
    articles: rows.map(avecTags),
    nextCursor: rows.length === params.limit && last ? last.published_at + ',' + last.id : null
  };
}

/** Un article est juge tronque quand le flux n'en livre qu'un aperçu. */
function estTronque(row) {
  if (row.has_full) return false;
  // Une video est courte par nature : son "texte" est le lecteur.
  if (estYouTube(row.url)) return false;
  // Un episode de podcast non plus : son contenu, c'est l'audio.
  if (row.duration || /<audio/i.test(row.content || '')) return false;
  const seuil = Number(getSetting('fulltext_min_words', '250'));
  return row.word_count < (Number.isFinite(seuil) ? seuil : 250);
}

export function getArticle(id) {
  const row = db.prepare(`
    SELECT ${ARTICLE_COLUMNS}, a.content, a.full_content, a.full_error, a.full_fetched_at,
           f.site_url AS feed_site_url
    FROM articles a JOIN feeds f ON f.id = a.feed_id
    WHERE a.id = ?
  `).get(id);
  if (!row) return null;

  const { full_content, ...reste } = avecTags(row);
  const tronque = estTronque(row);
  const actif = getSetting('fulltext', 'auto') !== 'off';

  // Un echec recent ne doit pas relancer un telechargement a chaque ouverture ;
  // au bout d'un jour, le site a pu redevenir lisible, on retente.
  const echecRecent = Boolean(row.full_error) && row.full_fetched_at > now() - 24 * 3600 * 1000;

  return {
    ...reste,
    content: full_content || row.content,
    has_full: Boolean(row.has_full),
    truncated: tronque,
    fulltext_enabled: actif,
    should_fetch_full: Boolean(tronque && actif && row.url && !echecRecent),
    also_in: autresSources(id)
  };
}

/**
 * Telecharge la page d'origine et en extrait le texte complet.
 * Le resultat est garde en base : la fois suivante, c'est instantane.
 */
export async function fetchFullText(id, { force = false } = {}) {
  const row = db.prepare('SELECT id, url, full_content FROM articles WHERE id = ?').get(id);
  if (!row) throw Object.assign(new Error('Article introuvable.'), { status: 404 });
  if (row.full_content && !force) return getArticle(id);
  if (!row.url) throw Object.assign(new Error('Cet article n’a pas de lien vers sa source.'), { status: 422 });

  try {
    const extrait = await extraireTexteComplet(row.url);
    db.prepare(`
      UPDATE articles SET
        full_content = ?, full_fetched_at = ?, full_error = NULL,
        word_count = MAX(word_count, ?),
        image = COALESCE(image, ?),
        summary = CASE WHEN COALESCE(summary, '') = '' THEN ? ELSE summary END,
        author = COALESCE(author, ?)
      WHERE id = ?
    `).run(extrait.content, now(), extrait.wordCount, extrait.image, extrait.excerpt, extrait.byline, id);
    return getArticle(id);
  } catch (error) {
    db.prepare('UPDATE articles SET full_error = ?, full_fetched_at = ? WHERE id = ?')
      .run(String(error.message).slice(0, 300), now(), id);
    throw Object.assign(error, { status: error.status || 502 });
  }
}

export function setRead(id, read) {
  const ids = groupe(id);
  const stamp = read ? now() : null;
  db.prepare(`UPDATE articles SET read_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`)
    .run(stamp, ...ids);
  return getArticle(id);
}

export function setStarred(id, starred) {
  const ids = groupe(id);
  db.prepare(`UPDATE articles SET starred = ? WHERE id IN (${ids.map(() => '?').join(',')})`)
    .run(starred ? 1 : 0, ...ids);
  return getArticle(id);
}

/** Marque comme lu : une liste d'ids, ou tout un flux / dossier / la totalite. */
export function markRead({ ids, feedId, folder, all, olderThan } = {}) {
  const stamp = now();
  let changed = 0;

  if (Array.isArray(ids) && ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    changed = db.prepare(`UPDATE articles SET read_at = ? WHERE read_at IS NULL AND id IN (${placeholders})`)
      .run(stamp, ...ids).changes;
  } else {
    const where = ['read_at IS NULL'];
    const params = [stamp];

    if (feedId) { where.push('feed_id = ?'); params.push(Number(feedId)); }
    if (folder) { where.push('feed_id IN (SELECT id FROM feeds WHERE folder = ?)'); params.push(folder); }
    if (olderThan) { where.push('published_at < ?'); params.push(Number(olderThan)); }
    if (!feedId && !folder && !all && !olderThan) return 0;

    changed = db.prepare('UPDATE articles SET read_at = ? WHERE ' + where.join(' AND ')).run(...params).changes;
  }

  // Les copies de la meme histoire suivent, dans les autres flux aussi.
  if (changed) reconcilierDoublons();
  return changed;
}

export function counts() {
  const global = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM articles WHERE read_at IS NULL AND dupe_of IS NULL) AS unread,
      (SELECT COUNT(*) FROM articles WHERE starred = 1 AND dupe_of IS NULL)     AS starred,
      (SELECT COUNT(*) FROM articles WHERE dupe_of IS NULL)                     AS total,
      (SELECT COUNT(*) FROM articles WHERE dupe_of IS NOT NULL)                 AS duplicates
  `).get();

  const byFolder = db.prepare(`
    SELECT f.folder AS name, COUNT(a.id) AS unread
    FROM feeds f LEFT JOIN articles a ON a.feed_id = f.id AND a.read_at IS NULL
    GROUP BY f.folder
  `).all();

  return { ...global, byFolder, lastRefreshAt: Number(getSetting('last_refresh_at', 0)) || null };
}

export { getSetting, setSetting };
