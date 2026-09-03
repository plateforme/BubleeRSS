// Toutes les operations metier : flux, articles, deduplication, texte complet.
import { db, getSetting, setSetting } from './db.js';
import { fetchFeed, discoverFeeds } from './feed.js';
import { urlKey, titleKey, TITRE_FIABLE, FENETRE_TITRE_MS } from './dedupe.js';
import { extraireTexteComplet, extraireImageDeLaPage, extraireIconeDuSite } from './readable.js';
import { estYouTube } from './youtube.js';
import { purgerSessionsExpirees } from './comptes.js';

const now = () => Date.now();

/**
 * Tout ce qui suit est cloisonne par compte. Un flux appartient a quelqu'un, et
 * ses articles en descendent par cascade : c'est ce qui rend l'isolation
 * structurelle plutot que dependante d'un WHERE qu'on aurait pu oublier.
 *
 * Les fonctions publiques prennent donc le compte en premier argument. Celles
 * qui n'en prennent pas sont les taches du service — rafraichissement, purge —
 * qui traversent legitimement tous les comptes.
 */
function exigeCompte(u) {
  const id = Number(u);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error('Compte manquant : opération refusée.'), { status: 401 });
  }
  return id;
}

/** Le flux, s'il appartient bien a ce compte. */
function fluxDuCompte(id, u) {
  return db.prepare('SELECT * FROM feeds WHERE id = ? AND user_id = ?').get(Number(id), exigeCompte(u));
}

/** L'article, s'il descend d'un flux de ce compte. */
function articleDuCompte(id, u) {
  return db.prepare(
    'SELECT a.id FROM articles a JOIN feeds f ON f.id = a.feed_id WHERE a.id = ? AND f.user_id = ?'
  ).get(Number(id), exigeCompte(u));
}

/* ------------------------------------------------------------------ flux */

/* Les trois sous-requetes correlees ci-dessous ont l'air couteuses — trois
   comptages par source — et on a essaye de les remplacer par un seul
   regroupement joint. Mesure faite sur la vraie bibliotheque (98 sources,
   3 012 articles) : 1,8 ms pour les sous-requetes, 4,5 ms pour le
   regroupement. L'index (feed_id, published_at) fait de chaque comptage un
   parcours d'intervalle, la ou le GROUP BY construit un arbre temporaire.
   On garde donc cette forme-ci ; elle n'est pas naive, elle est mesuree. */
export function listFeeds(u) {
  return db.prepare(`
    SELECT f.id, f.url, f.site_url, f.folder, f.icon, f.description, f.priority,
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
    WHERE f.user_id = ?
    ORDER BY f.folder = '' DESC, f.folder COLLATE NOCASE, title COLLATE NOCASE
  `).all(exigeCompte(u));
}

export function getFeed(id, u) {
  return fluxDuCompte(id, u);
}

/**
 * Les seuls chiffres de l'index : non lus et total par source. Marquer un
 * article comme lu rechargeait tout l'etat — quatre-vingt-dix-huit sources
 * avec leur titre, leur icone et leur description — pour rafraichir deux
 * nombres. Ceci suffit, et tient en trois kilo-octets.
 */
export function compteursSources(u) {
  return db.prepare(`
    SELECT f.id,
           (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id AND a.read_at IS NULL) AS unread,
           (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id) AS total
    FROM feeds f WHERE f.user_id = ?
  `).all(exigeCompte(u));
}

/**
 * L'icone d'une source, cherchee une seule fois : l'avatar d'une chaine
 * YouTube (le favicon de youtube.com ne distingue pas deux chaines), sinon
 * l'icone que le site declare. Autrefois demandee a google.com/s2, ce qui
 * disait a Google quelles sources on lit : plus maintenant.
 */
async function trouverIcone(feed, siteUrl) {
  if (!siteUrl) return null;
  if (estYouTube(feed.url)) return extraireImageDeLaPage(siteUrl).catch(() => null);
  return extraireIconeDuSite(siteUrl).catch(() => null);
}

/** Ajoute un flux depuis une URL (page d'accueil acceptee : on cherche le flux). */
export async function addFeed(u, input, folder = '', title = '') {
  const compte = exigeCompte(u);
  const candidates = await discoverFeeds(input);
  if (!candidates.length) {
    throw Object.assign(new Error('Aucun flux RSS ou Atom trouve a cette adresse.'), { status: 422 });
  }

  const chosen = candidates[0];
  const existing = db.prepare('SELECT id FROM feeds WHERE url = ? AND user_id = ?').get(chosen.url, compte);
  if (existing) {
    throw Object.assign(new Error('Ce flux est deja dans ta bibliotheque.'), { status: 409, feedId: existing.id });
  }

  const info = db.prepare(`
    INSERT INTO feeds (url, title, custom_title, folder, created_at, user_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(chosen.url, chosen.title || '', title || null, folder || '', now(), compte);

  const feedId = Number(info.lastInsertRowid);
  const result = await refreshFeed(feedId);
  return { feed: getFeed(feedId, compte), ...result, alternatives: candidates.slice(1) };
}

/** Suivi : on lit tout. Survol : hors des non-lus, mais consultable. Muet :
    archive seulement, on n'y va que par la source, l'etiquette ou la recherche. */
export const PRIORITES = new Set(['suivi', 'survol', 'muet']);

export function updateFeed(id, patch, u) {
  const feed = fluxDuCompte(id, u);
  if (!feed) throw Object.assign(new Error('Flux introuvable.'), { status: 404 });

  const fields = [];
  const values = [];
  if (patch.priority !== undefined) {
    if (!PRIORITES.has(patch.priority)) {
      throw Object.assign(new Error('Priorite inconnue : ' + patch.priority), { status: 400 });
    }
    fields.push('priority = ?');
    values.push(patch.priority);
  }
  for (const key of ['custom_title', 'folder', 'url']) {
    if (patch[key] !== undefined) {
      fields.push(key + ' = ?');
      values.push(patch[key] === '' && key === 'custom_title' ? null : patch[key]);
    }
  }
  // Une nouvelle adresse repart de zero : l'ETag de l'ancienne ne vaut rien
  // chez le nouveau serveur, et pourrait lui faire repondre 304 a tort.
  if (patch.url !== undefined && patch.url !== feed.url) {
    fields.push('etag = NULL', 'last_modified = NULL');
  }
  if (!fields.length) return feed;
  values.push(id, feed.user_id);
  db.prepare('UPDATE feeds SET ' + fields.join(', ') + ' WHERE id = ? AND user_id = ?').run(...values);
  return fluxDuCompte(id, feed.user_id);
}

export function deleteFeed(id, u) {
  const compte = exigeCompte(u);
  const supprime = db.prepare('DELETE FROM feeds WHERE id = ? AND user_id = ?').run(Number(id), compte).changes > 0;
  // Les doublons orphelins redeviennent des articles a part entiere.
  if (supprime) reconcilierDoublons(compte);
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
export async function reparerFlux(id, u) {
  const feed = fluxDuCompte(id, u);
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
    if (db.prepare('SELECT 1 FROM feeds WHERE url = ? AND id <> ? AND user_id = ?')
      .get(candidat.url, id, feed.user_id)) {
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
export async function accepterReparation(id, url, u) {
  const compte = exigeCompte(u);
  const feed = fluxDuCompte(id, compte);
  if (!feed) throw Object.assign(new Error('Flux introuvable.'), { status: 404 });
  if (db.prepare('SELECT 1 FROM feeds WHERE url = ? AND id <> ? AND user_id = ?').get(url, id, compte)) {
    throw Object.assign(new Error('Ce flux est déjà dans ta bibliothèque.'), { status: 409 });
  }

  const ancienne = feed.url;
  appliquerAdresse(id, url, { figerNom: true });
  const refresh = await refreshFeed(id);
  if (refresh.error) {
    appliquerAdresse(id, ancienne);
    throw Object.assign(new Error(refresh.error), { status: 502 });
  }
  dedupeExistants(compte);
  return { feed: fluxDuCompte(id, compte), added: refresh.added };
}

/** Passe en revue toutes les sources en erreur. */
export async function reparerSourcesCassees(u, concurrency = 5) {
  const compte = exigeCompte(u);
  const ids = db.prepare('SELECT id FROM feeds WHERE last_error IS NOT NULL AND user_id = ? ORDER BY id')
    .all(compte).map((r) => r.id);
  const resultats = [];
  let curseur = 0;

  async function worker() {
    while (curseur < ids.length) {
      const id = ids[curseur++];
      try {
        resultats.push(await reparerFlux(id, compte));
      } catch (error) {
        resultats.push({ feedId: id, status: 'echec', error: String(error.message) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  if (resultats.some((r) => r.status === 'repare')) {
    dedupeExistants(compte);
    setSetting('last_refresh_at', now());
  }

  return {
    checked: ids.length,
    repaired: resultats.filter((r) => r.status === 'repare').length,
    proposed: resultats.filter((r) => r.status === 'propose').length,
    results: resultats
  };
}

export function listFolders(u) {
  return db.prepare(`
    SELECT folder AS name, COUNT(*) AS feeds
    FROM feeds WHERE folder <> '' AND user_id = ? GROUP BY folder ORDER BY folder COLLATE NOCASE
  `).all(exigeCompte(u));
}

/* ------------------------------------------------------------ doublons */

/* Ces deux recherches sont bornees au compte : sans ca, l'article d'une
   personne pourrait etre rattache comme doublon a celui d'une autre, et l'etat
   de lecture se propagerait d'un compte a l'autre. */
const chercheParUrl = db.prepare(`
  SELECT a.id, a.feed_id, a.read_at, a.starred, a.title_key
  FROM articles a JOIN feeds f ON f.id = a.feed_id
  WHERE a.url_key = ? AND a.dupe_of IS NULL AND f.user_id = ?
  ORDER BY a.id LIMIT 1
`);

const chercheParTitre = db.prepare(`
  SELECT a.id, a.feed_id, a.read_at, a.starred, a.title_key
  FROM articles a JOIN feeds f ON f.id = a.feed_id
  WHERE a.title_key = ? AND a.dupe_of IS NULL AND ABS(a.published_at - ?) <= ? AND f.user_id = ?
  ORDER BY a.id LIMIT 1
`);

/**
 * Cherche un article deja stocke qui raconte la meme chose.
 * L'adresse normalisee prime ; le titre ne sert de secours que s'il est
 * assez long et que les deux publications sont proches dans le temps.
 */
function trouverOriginal(cleUrl, cleTitre, publieLe, compte) {
  if (cleUrl) {
    const parUrl = chercheParUrl.get(cleUrl, compte);
    if (parUrl) return parUrl;
  }
  if (cleTitre && cleTitre.length >= TITRE_FIABLE) {
    return chercheParTitre.get(cleTitre, publieLe, FENETRE_TITRE_MS, compte) || null;
  }
  return null;
}

/**
 * Aligne l'etat « lu » a l'interieur de chaque groupe de doublons, dans les
 * deux sens : lire une copie suffit a marquer toute l'histoire comme lue.
 */
/* La deduplication se fait a l'interieur d'un compte : deux personnes qui
   suivent Le Monde ont chacune leur exemplaire de la meme depeche, et ce ne
   sont pas des doublons l'un de l'autre. */
const ARTICLES_DU_COMPTE =
  '(SELECT a2.id FROM articles a2 JOIN feeds f2 ON f2.id = a2.feed_id WHERE f2.user_id = ?)';

export function reconcilierDoublons(u) {
  const compte = exigeCompte(u);
  const stamp = now();
  db.prepare(`
    UPDATE articles SET read_at = ?
    WHERE read_at IS NULL
      AND id IN ${ARTICLES_DU_COMPTE}
      AND id IN (SELECT dupe_of FROM articles WHERE dupe_of IS NOT NULL AND read_at IS NOT NULL)
  `).run(stamp, compte);
  db.prepare(`
    UPDATE articles SET read_at = ?
    WHERE read_at IS NULL
      AND id IN ${ARTICLES_DU_COMPTE}
      AND dupe_of IN (SELECT id FROM articles WHERE read_at IS NOT NULL)
  `).run(stamp, compte);
}

/**
 * Repasse sur les articles deja stockes pour rattacher ceux qui font doublon.
 * Indispensable apres un import OPML : les histoires reprises par plusieurs
 * sources sont deja en base, personne ne les a encore comparees.
 * Le plus ancien identifiant gagne et devient l'exemplaire de reference.
 */
export function dedupeExistants(u) {
  const compte = exigeCompte(u);
  const lignes = db.prepare(`
    SELECT a.id, a.feed_id, a.url_key, a.title_key, a.published_at
    FROM articles a JOIN feeds f ON f.id = a.feed_id
    WHERE a.dupe_of IS NULL AND f.user_id = ? ORDER BY a.id
  `).all(compte);

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
    reconcilierDoublons(compte);
  }

  return aRattacher.length;
}

/**
 * Recalcule les cles de comparaison de toute la base et refait le
 * rapprochement a zero. A lancer quand les regles de detection changent.
 */
export function recalculerDoublons(u) {
  const compte = exigeCompte(u);
  const lignes = db.prepare(
    'SELECT a.id, a.url, a.title FROM articles a JOIN feeds f ON f.id = a.feed_id WHERE f.user_id = ?'
  ).all(compte);
  const maj = db.prepare('UPDATE articles SET url_key = ?, title_key = ?, dupe_of = NULL WHERE id = ?');
  db.transaction(() => {
    for (const ligne of lignes) maj.run(urlKey(ligne.url), titleKey(ligne.title), ligne.id);
  })();
  return dedupeExistants(compte);
}

/** Le canonique et toutes ses copies. */
function groupe(id) {
  // Les doublons sont deja calcules a l'interieur d'un compte : le groupe ne
  // peut donc pas traverser une frontiere de compte.
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
/* `proprietaire` : le compte auquel appartient le flux. Il borne la recherche
   de doublons — sans lui, l'article d'une personne pourrait etre rattache a
   celui d'une autre. */
export const saveItems = db.transaction((feedId, items, proprietaire) => {
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

    let original = trouverOriginal(cleUrl, cleTitre, item.published_at, proprietaire);

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

/**
 * Le recul apres une erreur : trente minutes, doublees a chaque echec, une
 * journee au plus. Une source en panne depuis six mois etait retelechargee
 * toutes les demi-heures comme les autres, alors que error_count comptait
 * ses echecs sans que personne ne les lise.
 */
const RECUL_BASE_MS = 30 * 60 * 1000;
const RECUL_MAX_MS = 24 * 3600 * 1000;

export function reculApres(echecs) {
  return Math.min(RECUL_MAX_MS, RECUL_BASE_MS * Math.pow(2, Math.max(0, echecs - 1)));
}

/* Tache du service : elle rafraichit un flux quel que soit son proprietaire,
   et lit celui-ci dans la ligne plutot que de l'exiger de l'appelant. */
export async function refreshFeed(id) {
  const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get(Number(id));
  if (!feed) throw Object.assign(new Error('Flux introuvable.'), { status: 404 });

  try {
    const result = await fetchFeed(feed.url, { etag: feed.etag, lastModified: feed.last_modified });

    if (result.notModified) {
      // Une source deja a jour peut encore attendre son icone.
      if (!feed.icon && !feed.icon_checked) {
        const icone = await trouverIcone(feed, feed.site_url);
        db.prepare('UPDATE feeds SET icon = COALESCE(?, icon), icon_checked = ? WHERE id = ?').run(icone, now(), id);
      }
      db.prepare('UPDATE feeds SET last_fetched_at = ?, last_error = NULL, error_count = 0, next_fetch_at = NULL WHERE id = ?')
        .run(now(), id);
      return { feedId: id, added: 0, duplicates: 0, notModified: true };
    }

    const { ajoutes, doublons } = saveItems(id, result.parsed.items, feed.user_id);

    // L'icone se cherche une fois, au premier rafraichissement reussi : la
    // colonne icon_checked retient qu'on a essaye, trouve ou pas.
    let icone = null;
    let cherchee = feed.icon_checked;
    if (!feed.icon && !feed.icon_checked) {
      icone = await trouverIcone(feed, result.parsed.siteUrl || feed.site_url);
      cherchee = now();
    }

    db.prepare(`
      UPDATE feeds SET
        title = CASE WHEN ? <> '' THEN ? ELSE title END,
        site_url = COALESCE(?, site_url),
        description = COALESCE(NULLIF(?, ''), description),
        icon = COALESCE(?, icon), icon_checked = ?,
        etag = ?, last_modified = ?, last_fetched_at = ?,
        last_error = NULL, error_count = 0, next_fetch_at = NULL
      WHERE id = ?
    `).run(
      result.parsed.title, result.parsed.title,
      result.parsed.siteUrl,
      result.parsed.description || '',
      icone, cherchee,
      result.etag, result.lastModified, now(), id
    );

    return { feedId: id, added: ajoutes, duplicates: doublons };
  } catch (error) {
    // Le serveur qui dit « reviens dans N secondes » a le dernier mot ;
    // sinon on recule tout seul, de plus en plus loin.
    const echecs = feed.error_count + 1;
    const attente = error.retryAfterMs ?? reculApres(echecs);
    db.prepare(`
      UPDATE feeds SET last_fetched_at = ?, last_error = ?, error_count = ?, next_fetch_at = ? WHERE id = ?
    `).run(now(), String(error.message).slice(0, 300), echecs, now() + attente, id);
    return { feedId: id, added: 0, duplicates: 0, error: String(error.message) };
  }
}

/* Une seule passe a la fois. Le minuteur, la touche R, un import OPML et
   chaque compte pouvaient la lancer : deux passes simultanees telechargeaient
   les memes flux et se disputaient les memes lignes. Celui qui arrive pendant
   qu'une passe tourne attend son resultat plutot que d'en lancer une autre. */
let passeEnCours = null;

/**
 * Rafraichit les flux, six a la fois.
 * `force` ignore le recul : c'est ce que fait un rafraichissement demande a
 * la main, qui doit reessayer meme une source en panne.
 */
export function refreshAll({ concurrency = 6, force = false } = {}) {
  if (passeEnCours) return passeEnCours;
  passeEnCours = passe(concurrency, force).finally(() => { passeEnCours = null; });
  return passeEnCours;
}

async function passe(concurrency, force) {
  // Une source qui a recule n'est pas reprise avant son heure — sauf demande
  // explicite. Les plus anciennement vues passent les premieres.
  const ids = db.prepare(`
    SELECT id FROM feeds
    WHERE ? OR next_fetch_at IS NULL OR next_fetch_at <= ?
    ORDER BY COALESCE(last_fetched_at, 0)
  `).all(force ? 1 : 0, now()).map((r) => r.id);

  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      results.push(await refreshFeed(id));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  for (const { id } of db.prepare('SELECT id FROM users').all()) reconcilierDoublons(id);
  setSetting('last_refresh_at', now());
  pruneArticles();
  // Meme rythme pour les sessions : sans ca, une session n'etait effacee que
  // si son porteur revenait apres l'expiration, et la table grossissait sans fin.
  purgerSessionsExpirees();

  const reportes = db.prepare('SELECT COUNT(*) n FROM feeds WHERE next_fetch_at > ?').get(now()).n;
  return {
    feeds: ids.length,
    skipped: reportes,
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
export async function completerImages({ limite = 40, concurrency = 4 } = {}, u) {
  const lignes = db.prepare(`
    SELECT a.id, a.url FROM articles a JOIN feeds f ON f.id = a.feed_id
    WHERE a.image IS NULL AND a.image_checked IS NULL AND a.url LIKE 'http%' AND f.user_id = ?
    ORDER BY a.published_at DESC LIMIT ?
  `).all(exigeCompte(u), limite);
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

/**
 * Supprime les articles lus et anciens ; garde toujours les non-lus, les
 * favoris et les articles etiquetes — poser une etiquette, c'est vouloir
 * retrouver l'article, et la retention n'a pas a defaire ce choix.
 *
 * Tache du service : elle traverse les comptes, mais la duree de retention est
 * propre a chacun — on purge donc compte par compte, avec son reglage a lui.
 */
export function pruneArticles() {
  const comptes = db.prepare('SELECT id FROM users').all().map((r) => r.id);
  let supprimes = 0;
  for (const compte of comptes) {
    const jours = Number(getSetting('retention_days', '90', compte));
    if (!Number.isFinite(jours) || jours <= 0) continue;
    supprimes += db.prepare(`
      DELETE FROM articles
      WHERE starred = 0 AND read_at IS NOT NULL AND published_at < ?
        AND feed_id IN (SELECT id FROM feeds WHERE user_id = ?)
        AND id NOT IN (SELECT article_id FROM article_tags)
    `).run(now() - jours * 24 * 3600 * 1000, compte).changes;
  }
  return supprimes;
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
function couleurLibre(u) {
  const prises = db.prepare(
    'SELECT color, COUNT(*) n FROM tags WHERE color IS NOT NULL AND user_id = ? GROUP BY color'
  ).all(u).reduce((acc, r) => ({ ...acc, [r.color]: r.n }), {});
  return PALETTE_TAGS.reduce((meilleure, c) => ((prises[c] || 0) < (prises[meilleure] || 0) ? c : meilleure), PALETTE_TAGS[0]);
}

/** Toutes les etiquettes, avec le nombre d'articles distincts qu'elles portent. */
export function listTags(u) {
  return db.prepare(`
    SELECT t.id, t.name, t.color, t.created_at,
           COUNT(DISTINCT COALESCE(a.dupe_of, a.id)) AS count
    FROM tags t
    LEFT JOIN article_tags at ON at.tag_id = t.id
    LEFT JOIN articles a ON a.id = at.article_id
    WHERE t.user_id = ?
    GROUP BY t.id
    ORDER BY count DESC, t.name COLLATE NOCASE
  `).all(exigeCompte(u));
}

/** Cree une etiquette vide, depuis le gestionnaire. */
export function createTag(nom, u) {
  const compte = exigeCompte(u);
  const propre = normaliserTag(nom);
  if (!propre) throw Object.assign(new Error('Nom d’étiquette vide.'), { status: 400 });
  const connu = db.prepare('SELECT id, name, color FROM tags WHERE name = ? AND user_id = ?').get(propre, compte);
  if (connu) return connu;

  const id = Number(db.prepare('INSERT INTO tags (name, color, created_at, user_id) VALUES (?, ?, ?, ?)')
    .run(propre, couleurLibre(compte), now(), compte).lastInsertRowid);
  return db.prepare('SELECT id, name, color FROM tags WHERE id = ?').get(id);
}

function idDuTag(nom, u, creer = true) {
  const propre = normaliserTag(nom);
  if (!propre) return null;
  const connu = db.prepare('SELECT id FROM tags WHERE name = ? AND user_id = ?').get(propre, u);
  if (connu) return connu.id;
  if (!creer) return null;
  return Number(db.prepare('INSERT INTO tags (name, color, created_at, user_id) VALUES (?, ?, ?, ?)')
    .run(propre, couleurLibre(u), now(), u).lastInsertRowid);
}

/**
 * Pose ou retire des etiquettes. Comme la lecture et les favoris, elles
 * s'appliquent au groupe de doublons : la meme histoire reste retrouvable
 * quelle que soit la source par laquelle on l'a lue.
 */
export function tagArticle(id, { add = [], remove = [], set } = {}, u) {
  const compte = exigeCompte(u);
  if (!articleDuCompte(id, compte)) {
    throw Object.assign(new Error('Article introuvable.'), { status: 404 });
  }
  const ids = groupe(id);
  const marque = db.prepare('INSERT INTO article_tags (article_id, tag_id, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
  const enleve = db.prepare('DELETE FROM article_tags WHERE article_id = ? AND tag_id = ?');

  db.transaction(() => {
    if (Array.isArray(set)) {
      const voulus = set.map((n) => idDuTag(n, compte)).filter(Boolean);
      for (const article of ids) {
        db.prepare('DELETE FROM article_tags WHERE article_id = ?').run(article);
        for (const tag of voulus) marque.run(article, tag, now());
      }
      return;
    }
    for (const nom of add) {
      const tag = idDuTag(nom, compte);
      if (tag) for (const article of ids) marque.run(article, tag, now());
    }
    for (const nom of remove) {
      const tag = idDuTag(nom, compte, false);
      if (tag) for (const article of ids) enleve.run(article, tag);
    }
  })();

  return getArticle(id, compte);
}

export function updateTag(id, { name, color } = {}, u) {
  const compte = exigeCompte(u);
  if (!db.prepare('SELECT 1 FROM tags WHERE id = ? AND user_id = ?').get(Number(id), compte)) {
    throw Object.assign(new Error('Étiquette introuvable.'), { status: 404 });
  }
  if (color !== undefined) {
    const teinte = PALETTE_TAGS.includes(color) ? color : null;
    db.prepare('UPDATE tags SET color = ? WHERE id = ?').run(teinte, id);
  }
  if (name === undefined) return db.prepare('SELECT id, name, color FROM tags WHERE id = ?').get(id);

  const propre = normaliserTag(name);
  if (!propre) throw Object.assign(new Error('Nom d’étiquette vide.'), { status: 400 });

  const collision = db.prepare('SELECT id FROM tags WHERE name = ? AND id <> ? AND user_id = ?')
    .get(propre, id, compte);
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

export function deleteTag(id, u) {
  return db.prepare('DELETE FROM tags WHERE id = ? AND user_id = ?').run(Number(id), exigeCompte(u)).changes > 0;
}

/* -------------------------------------------------------------- articles */

const ARTICLE_COLUMNS = `
  a.id, a.feed_id, a.url, a.title, a.author, a.summary, a.image, a.image_color,
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
/**
 * Traduit ce qui est tape dans la barre en expression FTS5. On n'extrait que
 * des lettres et des chiffres : l'utilisateur n'a pas a connaitre la syntaxe de
 * FTS, et rien de ce qu'il tape ne peut en devenir un operateur.
 *
 * Le dernier mot est cherche par prefixe, pour que la liste se resserre pendant
 * la frappe plutot qu'au dernier caractere.
 */
export function expressionFts(q) {
  const mots = String(q ?? '').match(/[\p{L}\p{N}]+/gu) || [];
  if (!mots.length) return null;
  return mots.map((m, i) => (i === mots.length - 1 ? `"${m}"*` : `"${m}"`)).join(' AND ');
}

export function queryArticles({ view = 'unread', feedId, folder, q, tag, limit = 30, before } = {}, u) {
  // Le cloisonnement passe avant tout le reste : aucune vue ne peut le lever.
  const where = ['f.user_id = @compte'];
  const params = { compte: exigeCompte(u) };

  // `tag` accepte une etiquette, plusieurs separees par une virgule, ou un
  // tableau. Toutes doivent etre presentes : on cherche a restreindre.
  const etiquettes = (Array.isArray(tag) ? tag : String(tag ?? '').split(','))
    .map((t) => String(t).trim())
    .filter(Boolean);

  etiquettes.forEach((nom, i) => {
    params['tag' + i] = nom;
    where.push(`EXISTS (
      SELECT 1 FROM article_tags at JOIN tags t ON t.id = at.tag_id
      WHERE at.article_id = a.id AND t.name = @tag${i} AND t.user_id = @compte
    )`);
  });

  // Hors d'un flux precis, on n'affiche qu'un exemplaire de chaque histoire.
  if (!feedId) where.push('a.dupe_of IS NULL');

  if (view === 'unread') where.push('a.read_at IS NULL');
  if (view === 'starred') where.push('a.starred = 1');
  if (view === 'survol') { where.push('a.read_at IS NULL'); where.push("f.priority = 'survol'"); }
  if (feedId) { where.push('a.feed_id = @feedId'); params.feedId = Number(feedId); }
  if (folder) { where.push('f.folder = @folder'); params.folder = folder; }

  // La priorite d'une source ne joue que sur les vues d'ensemble. Demander un
  // flux, un dossier, une etiquette ou une recherche, c'est demander
  // explicitement : on ne cache rien a quelqu'un qui est alle chercher.
  const ensemble = !feedId && !folder && !etiquettes.length && !q;
  if (ensemble && view === 'unread') where.push("f.priority = 'suivi'");
  if (ensemble && view === 'all') where.push("f.priority <> 'muet'");

  if (q) {
    const expr = expressionFts(q);
    if (expr) {
      where.push('a.id IN (SELECT rowid FROM articles_fts WHERE articles_fts MATCH @fts)');
      params.fts = expr;
    } else {
      // Une recherche qui ne contient aucun mot (de la ponctuation seule) n'a
      // rien a donner a FTS : on retombe sur la comparaison litterale.
      where.push('(a.title LIKE @q OR a.summary LIKE @q OR a.author LIKE @q)');
      params.q = '%' + q + '%';
    }
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
function estTronque(row, u) {
  if (row.has_full) return false;
  // Une video est courte par nature : son "texte" est le lecteur.
  if (estYouTube(row.url)) return false;
  // Un episode de podcast non plus : son contenu, c'est l'audio.
  if (row.duration || /<audio/i.test(row.content || '')) return false;
  const seuil = Number(getSetting('fulltext_min_words', '250', u));
  return row.word_count < (Number.isFinite(seuil) ? seuil : 250);
}

/** Deux teintes hexadecimales separees d'une virgule, rien d'autre. */
const COULEURS_VALIDES = /^#[0-9a-f]{6},#[0-9a-f]{6}$/i;

/**
 * Enregistre les couleurs moyennes d'une illustration. Elles sont calculees par
 * le navigateur au premier affichage — le serveur n'a pas de decodeur d'image —
 * puis servies a tout le monde ensuite. Comme elles viennent du client, le
 * format est verifie avant d'entrer en base.
 */
export function enregistrerCouleurImage(id, couleurs, u) {
  const compte = exigeCompte(u);
  const valeur = String(couleurs || '').toLowerCase();
  if (!COULEURS_VALIDES.test(valeur)) {
    throw Object.assign(new Error('Couleurs attendues au format « #rrggbb,#rrggbb ».'), { status: 400 });
  }
  if (!articleDuCompte(id, compte)) return { ok: false, image_color: valeur };
  const fait = db.prepare('UPDATE articles SET image_color = ? WHERE id = ? AND image IS NOT NULL')
    .run(valeur, Number(id)).changes > 0;
  return { ok: fait, image_color: valeur };
}

export function getArticle(id, u) {
  const compte = exigeCompte(u);
  const row = db.prepare(`
    SELECT ${ARTICLE_COLUMNS}, a.content, a.full_content, a.full_error, a.full_fetched_at,
           f.site_url AS feed_site_url
    FROM articles a JOIN feeds f ON f.id = a.feed_id
    WHERE a.id = ? AND f.user_id = ?
  `).get(id, compte);
  if (!row) return null;

  const { full_content, ...reste } = avecTags(row);
  const tronque = estTronque(row, compte);
  const actif = getSetting('fulltext', 'auto', compte) !== 'off';

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
export async function fetchFullText(id, { force = false } = {}, u) {
  const compte = exigeCompte(u);
  const row = db.prepare(`
    SELECT a.id, a.url, a.full_content FROM articles a JOIN feeds f ON f.id = a.feed_id
    WHERE a.id = ? AND f.user_id = ?
  `).get(id, compte);
  if (!row) throw Object.assign(new Error('Article introuvable.'), { status: 404 });
  if (row.full_content && !force) return getArticle(id, compte);
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
    return getArticle(id, compte);
  } catch (error) {
    db.prepare('UPDATE articles SET full_error = ?, full_fetched_at = ? WHERE id = ?')
      .run(String(error.message).slice(0, 300), now(), id);
    throw Object.assign(error, { status: error.status || 502 });
  }
}

export function setRead(id, read, u) {
  const compte = exigeCompte(u);
  if (!articleDuCompte(id, compte)) throw Object.assign(new Error('Article introuvable.'), { status: 404 });
  const ids = groupe(id);
  const stamp = read ? now() : null;
  db.prepare(`UPDATE articles SET read_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`)
    .run(stamp, ...ids);
  return getArticle(id, compte);
}

export function setStarred(id, starred, u) {
  const compte = exigeCompte(u);
  if (!articleDuCompte(id, compte)) throw Object.assign(new Error('Article introuvable.'), { status: 404 });
  const ids = groupe(id);
  db.prepare(`UPDATE articles SET starred = ? WHERE id IN (${ids.map(() => '?').join(',')})`)
    .run(starred ? 1 : 0, ...ids);
  return getArticle(id, compte);
}

/** Marque comme lu : une liste d'ids, ou tout un flux / dossier / la totalite. */
export function markRead({ ids, feedId, folder, all, olderThan } = {}, u) {
  const compte = exigeCompte(u);
  const stamp = now();
  // Quelle que soit la selection, elle est bornee aux articles du compte.
  const where = ['read_at IS NULL', `id IN ${ARTICLES_DU_COMPTE}`];
  const params = [stamp, compte];

  if (Array.isArray(ids) && ids.length) {
    where.push(`id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  } else {
    if (feedId) { where.push('feed_id = ?'); params.push(Number(feedId)); }
    if (folder) {
      where.push('feed_id IN (SELECT id FROM feeds WHERE folder = ? AND user_id = ?)');
      params.push(folder, compte);
    }
    if (olderThan) { where.push('published_at < ?'); params.push(Number(olderThan)); }
    if (!feedId && !folder && !all && !olderThan) return 0;
  }

  const changed = db.prepare('UPDATE articles SET read_at = ? WHERE ' + where.join(' AND ')).run(...params).changes;

  // Les copies de la meme histoire suivent, dans les autres flux aussi.
  if (changed) reconcilierDoublons(compte);
  // L'horodatage est le meme pour tout le lot : c'est ce qui rend l'annulation
  // possible sans tenir la liste des identifiants.
  return { changed, stamp };
}

/**
 * Annule un marquage en masse. Tous les articles d'un lot portent le meme
 * `read_at` a la milliseconde : il suffit de le rendre a NULL. Un article lu
 * a un autre moment, avant ou apres, n'est pas touche.
 */
export function annulerLecture(stamp, u) {
  const compte = exigeCompte(u);
  const quand = Number(stamp);
  if (!Number.isFinite(quand)) return 0;
  return db.prepare(`
    UPDATE articles SET read_at = NULL
    WHERE read_at = ? AND id IN ${ARTICLES_DU_COMPTE}
  `).run(quand, compte).changes;
}

export function counts(u) {
  const compte = exigeCompte(u);
  // Les compteurs suivent ce que les vues montrent vraiment : « Non lus » ne
  // compte que les sources suivies, « Tout » laisse de cote les sources muettes.
  const nonLus = (priorite) => `
    (SELECT COUNT(*) FROM articles a JOIN feeds f ON f.id = a.feed_id
     WHERE a.read_at IS NULL AND a.dupe_of IS NULL AND f.user_id = @compte
       AND f.priority = '${priorite}')`;

  const global = db.prepare(`
    SELECT
      ${nonLus('suivi')}  AS unread,
      ${nonLus('survol')} AS survol,
      ${nonLus('muet')}   AS muet,
      (SELECT COUNT(*) FROM articles a JOIN feeds f ON f.id = a.feed_id
       WHERE a.starred = 1 AND a.dupe_of IS NULL AND f.user_id = @compte)   AS starred,
      (SELECT COUNT(*) FROM articles a JOIN feeds f ON f.id = a.feed_id
       WHERE a.dupe_of IS NULL AND f.user_id = @compte
         AND f.priority <> 'muet')                                          AS total,
      (SELECT COUNT(*) FROM articles a JOIN feeds f ON f.id = a.feed_id
       WHERE a.dupe_of IS NOT NULL AND f.user_id = @compte)                 AS duplicates
  `).get({ compte });

  const byFolder = db.prepare(`
    SELECT f.folder AS name, COUNT(a.id) AS unread
    FROM feeds f LEFT JOIN articles a ON a.feed_id = f.id AND a.read_at IS NULL
    WHERE f.user_id = ?
    GROUP BY f.folder
  `).all(compte);

  return { ...global, byFolder, lastRefreshAt: Number(getSetting('last_refresh_at', 0)) || null };
}

export { getSetting, setSetting };
