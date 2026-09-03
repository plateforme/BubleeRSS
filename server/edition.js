// L'edition du jour.
//
// « Non lus » a un defaut de nature : son fond se derobe. On lit dix articles,
// il en arrive douze, et le compteur monte pendant qu'on travaille. Il n'y a
// pas de fin, donc pas de moment ou l'on a fini — et une pile sans fin finit
// par ne plus appeler du tout.
//
// L'edition est une pile finie : une quinzaine d'articles choisis une fois par
// jour, annonces avec leur duree totale, et qui ne bougent plus jusqu'au
// lendemain. Ce qui n'y est pas n'est pas perdu — tout reste dans « Tout »,
// dans sa source, dans la recherche. Ce qui n'y est pas cesse seulement
// d'appeler.
import { db } from './db.js';

/** Ce qu'on peut lire dans une soiree sans que ce soit une corvee. */
const MINUTES_VISEES = 45;
const ARTICLES_MAX = 15;

/** Au-dela, une source occuperait l'edition a elle seule. */
const PAR_SOURCE_MAX = 2;

/** On ne compose pas une edition avec les nouvelles de la semaine derniere. */
const FRAICHEUR_JOURS = 4;

/** Le jour, en heure locale : une edition se pense a la date du lecteur. */
export function jourDe(date = new Date()) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}

/** Le temps que demande un article : sa duree s'il s'ecoute, sinon sa lecture. */
export function minutesDe(article) {
  if (article.duration) return Math.max(1, Math.round(article.duration / 60));
  return Math.max(1, Math.round((article.word_count || 0) / 230));
}

/**
 * Choisit les articles de l'edition.
 *
 * On tourne d'une source a l'autre plutot que de prendre les plus recents :
 * pris a la file, les quinze articles viendraient des deux sources les plus
 * bavardes, et l'edition ressemblerait a leur sommaire. Chaque tour prend
 * l'article le plus recent de chaque source, jusqu'a la duree visee.
 */
export function composer(candidats, { minutes = MINUTES_VISEES, maximum = ARTICLES_MAX } = {}) {
  const parSource = new Map();
  for (const a of candidats) {
    if (!parSource.has(a.feed_id)) parSource.set(a.feed_id, []);
    parSource.get(a.feed_id).push(a);
  }

  const retenus = [];
  let total = 0;
  for (let tour = 0; tour < PAR_SOURCE_MAX; tour++) {
    for (const liste of parSource.values()) {
      const a = liste[tour];
      if (!a) continue;
      const cout = minutesDe(a);
      // Un long article passe encore si l'edition est presque vide : sinon une
      // enquete de quarante minutes ne serait jamais choisie.
      if (retenus.length >= maximum) break;
      if (total + cout > minutes && retenus.length >= 3) continue;
      retenus.push(a);
      total += cout;
    }
    if (retenus.length >= maximum || total >= minutes) break;
  }

  // Rendue dans l'ordre de publication : une edition se lit comme un journal.
  retenus.sort((a, b) => b.published_at - a.published_at);
  return { articles: retenus, minutes: total };
}

/** Les articles qui peuvent entrer dans l'edition d'aujourd'hui. */
function candidats(userId) {
  return db.prepare(`
    SELECT a.id, a.feed_id, a.published_at, a.word_count, a.duration
    FROM articles a JOIN feeds f ON f.id = a.feed_id
    WHERE f.user_id = ? AND a.read_at IS NULL AND a.dupe_of IS NULL
      AND f.priority = 'suivi' AND a.published_at >= ?
    ORDER BY a.published_at DESC
  `).all(userId, Date.now() - FRAICHEUR_JOURS * 86400000);
}

/**
 * L'edition du jour, composee a la premiere demande et gardee ensuite : elle
 * ne doit pas se recomposer sous les yeux du lecteur a chaque rafraichissement.
 */
export function editionDuJour(userId, { refaire = false } = {}) {
  const jour = jourDe();
  const gardee = refaire ? null : db.prepare('SELECT ids FROM editions WHERE user_id = ? AND jour = ?').get(userId, jour);

  if (gardee) {
    const ids = JSON.parse(gardee.ids);
    return { jour, ids, composee: false };
  }

  const { articles } = composer(candidats(userId));
  const ids = articles.map((a) => a.id);
  db.prepare(`
    INSERT INTO editions (user_id, jour, ids, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, jour) DO UPDATE SET ids = excluded.ids, created_at = excluded.created_at
  `).run(userId, jour, JSON.stringify(ids), Date.now());

  // Les editions d'avant-hier n'interessent plus personne.
  db.prepare('DELETE FROM editions WHERE user_id = ? AND jour < ?')
    .run(userId, jourDe(new Date(Date.now() - 7 * 86400000)));

  return { jour, ids, composee: true };
}

export const _pourLesTests = { MINUTES_VISEES, ARTICLES_MAX, PAR_SOURCE_MAX, FRAICHEUR_JOURS };
