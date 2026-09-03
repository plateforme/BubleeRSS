// Le rapprochement des doublons.
//
// C'est le point qui pose probleme sur Feedly : la meme histoire revient trois
// fois parce que trois sources la relaient, ou parce que l'editeur a republie
// son article avec un nouvel identifiant.
//
// Tout se joue a l'interieur d'un compte : deux personnes qui suivent Le Monde
// ont chacune leur exemplaire de la meme depeche, et ce ne sont pas des
// doublons l'un de l'autre.
import { db } from './db.js';
import { urlKey, titleKey, TITRE_FIABLE, FENETRE_TITRE_MS } from './dedupe.js';
import { exigeCompte, now } from './garde.js';

/** Les articles d'un compte, pour borner une mise a jour en masse. */
export const ARTICLES_DU_COMPTE =
  '(SELECT a2.id FROM articles a2 JOIN feeds f2 ON f2.id = a2.feed_id WHERE f2.user_id = ?)';


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
export function trouverOriginal(cleUrl, cleTitre, publieLe, compte) {
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
export function groupe(id) {
  // Les doublons sont deja calcules a l'interieur d'un compte : le groupe ne
  // peut donc pas traverser une frontiere de compte.
  return db.prepare(`
    SELECT a.id FROM articles a, (SELECT COALESCE(dupe_of, id) AS racine FROM articles WHERE id = ?) g
    WHERE a.id = g.racine OR a.dupe_of = g.racine
  `).all(id).map((r) => r.id);
}

/** Les autres sources qui publient le meme article. */
export function autresSources(id) {
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
