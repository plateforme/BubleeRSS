// Les regles : ce qu'on ne veut plus voir arriver, et ce qu'on veut retrouver.
//
// Le vrai probleme d'un agregateur est le debit. La priorite par source repond
// au « qui » ; les regles repondent au « quoi » — un mot dans un titre suffit
// a marquer un article comme lu, a l'etiqueter ou a le mettre de cote, avant
// meme qu'il n'apparaisse.
//
// Elles s'appliquent a l'insertion, dans la meme transaction que l'article :
// un article n'existe donc jamais, meme brievement, sans avoir ete passe
// devant elles.
import { db } from './db.js';

export const CHAMPS = new Set(['titre', 'corps', 'auteur', 'partout']);
export const ACTIONS = new Set(['lu', 'favori', 'etiquette']);

/** Compare sans accents ni casse : « resume » trouve « résumé ». */
export const aplatir = (texte) => String(texte ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Un motif est une suite de mots, tous requis, dans n'importe quel ordre.
 * Les guillemets droits en font une expression exacte. Rien de ce qu'on tape
 * ne devient une expression reguliere : c'est un champ de saisie, pas un
 * langage.
 */
export function decouperMotif(motif) {
  const morceaux = String(motif || '').match(/"[^"]+"|\S+/g) || [];
  return morceaux.map((m) => aplatir(m.replace(/^"|"$/g, ''))).filter(Boolean);
}

/** Le texte d'un article sur lequel une regle porte. */
function texteDe(article, champ) {
  if (champ === 'titre') return article.title;
  if (champ === 'auteur') return article.author;
  if (champ === 'corps') return (article.summary || '') + ' ' + (article.content || '');
  return [article.title, article.author, article.summary, article.content].filter(Boolean).join(' ');
}

/** Vrai si tous les mots du motif sont presents. */
export function correspond(article, regle) {
  const mots = regle.mots || decouperMotif(regle.motif);
  if (!mots.length) return false;
  const foin = aplatir(texteDe(article, regle.champ));
  return mots.every((mot) => foin.includes(mot));
}

/* ------------------------------------------------------------- la table */

const CHAMPS_SQL = 'id, feed_id, champ, motif, action, valeur, actif, touches, created_at';

export function listerRegles(userId) {
  return db.prepare(`
    SELECT r.${CHAMPS_SQL.split(', ').join(', r.')},
           COALESCE(NULLIF(f.custom_title, ''), NULLIF(f.title, ''), f.url) AS feed_title
    FROM rules r LEFT JOIN feeds f ON f.id = r.feed_id
    WHERE r.user_id = ? ORDER BY r.created_at DESC
  `).all(userId);
}

/** Les regles actives d'un compte, motifs deja decoupes. */
export function reglesActives(userId) {
  return db.prepare(`SELECT ${CHAMPS_SQL} FROM rules WHERE user_id = ? AND actif = 1`).all(userId)
    .map((r) => ({ ...r, mots: decouperMotif(r.motif) }))
    .filter((r) => r.mots.length);
}

export function creerRegle(userId, { feedId = null, champ = 'titre', motif, action = 'lu', valeur = null }) {
  const propre = String(motif || '').trim().slice(0, 200);
  if (!propre) throw Object.assign(new Error('Le motif est vide.'), { status: 400 });
  if (!CHAMPS.has(champ)) throw Object.assign(new Error('Champ inconnu : ' + champ), { status: 400 });
  if (!ACTIONS.has(action)) throw Object.assign(new Error('Action inconnue : ' + action), { status: 400 });

  const etiquette = action === 'etiquette' ? String(valeur || '').trim().slice(0, 60) : null;
  if (action === 'etiquette' && !etiquette) {
    throw Object.assign(new Error('Une règle qui étiquette a besoin du nom de l’étiquette.'), { status: 400 });
  }
  // Une regle bornee a une source doit porter sur une source qui est la sienne.
  const source = feedId ? Number(feedId) : null;
  if (source && !db.prepare('SELECT 1 FROM feeds WHERE id = ? AND user_id = ?').get(source, userId)) {
    throw Object.assign(new Error('Source introuvable.'), { status: 404 });
  }

  const id = db.prepare(`
    INSERT INTO rules (user_id, feed_id, champ, motif, action, valeur, actif, touches, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)
  `).run(userId, source, champ, propre, action, etiquette, Date.now()).lastInsertRowid;

  return db.prepare(`SELECT ${CHAMPS_SQL} FROM rules WHERE id = ?`).get(Number(id));
}

export function modifierRegle(id, userId, patch) {
  const regle = db.prepare('SELECT * FROM rules WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!regle) throw Object.assign(new Error('Règle introuvable.'), { status: 404 });
  if (patch.actif !== undefined) {
    db.prepare('UPDATE rules SET actif = ? WHERE id = ?').run(patch.actif ? 1 : 0, regle.id);
  }
  return db.prepare(`SELECT ${CHAMPS_SQL} FROM rules WHERE id = ?`).get(regle.id);
}

export const supprimerRegle = (id, userId) =>
  db.prepare('DELETE FROM rules WHERE id = ? AND user_id = ?').run(Number(id), userId).changes > 0;

/* ---------------------------------------------------------- application */

const compter = db.prepare('UPDATE rules SET touches = touches + ? WHERE id = ?');

/**
 * Ce que les regles decident pour un article : lu, en favori, et les
 * etiquettes a poser. Rend `null` si aucune ne s'applique — le cas ordinaire,
 * qu'on veut le moins cher possible.
 */
export function verdict(article, feedId, regles) {
  let lu = false;
  let favori = false;
  let etiquettes = null;
  let touchees = null;

  for (const regle of regles) {
    if (regle.feed_id && regle.feed_id !== feedId) continue;
    if (!correspond(article, regle)) continue;
    if (regle.action === 'lu') lu = true;
    else if (regle.action === 'favori') favori = true;
    else if (regle.valeur) (etiquettes ??= []).push(regle.valeur);
    (touchees ??= []).push(regle.id);
  }

  return touchees ? { lu, favori, etiquettes, touchees } : null;
}

/** Enregistre combien d'articles chaque regle a attrapes. */
export function crediter(touchees) {
  for (const [id, n] of touchees) compter.run(n, id);
}
