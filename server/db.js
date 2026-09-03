import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { urlKey, titleKey } from './dedupe.js';
import { toPlainText } from './html.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.BUBLEE_DATA || path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'bublee.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// En WAL, NORMAL suffit : une coupure de courant peut perdre la derniere
// transaction, jamais corrompre la base, et on fait bien moins de fsync.
db.pragma('synchronous = NORMAL');
// Un autre processus (le script de purge, un outil) qui tient un verrou
// n'a pas a faire echouer une ecriture sur-le-champ.
db.pragma('busy_timeout = 5000');

/* ------------------------------------------------------------------ tables */

db.exec(`
-- L'unicite de l'adresse est par compte, pas globale : deux personnes ont le
-- droit de suivre Le Monde. Elle est donc portee par un index (plus bas), et
-- non par une contrainte de colonne — qu'il faudrait ensuite reecrire la table
-- pour retirer, comme le fait la migration des bases d'avant les comptes.
CREATE TABLE IF NOT EXISTS feeds (
  id             INTEGER PRIMARY KEY,
  url            TEXT NOT NULL,
  site_url       TEXT,
  title          TEXT NOT NULL DEFAULT '',
  custom_title   TEXT,
  description    TEXT,
  folder         TEXT NOT NULL DEFAULT '',
  icon           TEXT,
  etag           TEXT,
  last_modified  TEXT,
  last_fetched_at INTEGER,
  last_error     TEXT,
  error_count    INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS articles (
  id           INTEGER PRIMARY KEY,
  feed_id      INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid         TEXT NOT NULL,
  url          TEXT,
  title        TEXT NOT NULL DEFAULT '',
  author       TEXT,
  summary      TEXT,
  content      TEXT,
  image        TEXT,
  published_at INTEGER NOT NULL,
  fetched_at   INTEGER NOT NULL,
  read_at      INTEGER,
  starred      INTEGER NOT NULL DEFAULT 0,
  word_count   INTEGER NOT NULL DEFAULT 0,
  UNIQUE(feed_id, guid)
);

-- Un compte par personne. Les flux, articles, etiquettes et reglages lui
-- appartiennent et partent avec lui : l'isolation est structurelle, elle ne
-- depend pas d'un WHERE qu'on aurait pu oublier quelque part.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL COLLATE NOCASE UNIQUE,
  nom           TEXT NOT NULL DEFAULT '',
  mot_de_passe  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'editeur',
  actif         INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  agent      TEXT,
  ip         TEXT
);

-- user_id = 0 : les reglages du service, qui n'appartiennent a personne
-- (date du dernier rafraichissement, par exemple).
CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER NOT NULL DEFAULT 0,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- Etiquettes posees a la main sur les articles, pour les retrouver ensuite
-- dans l'interface comme dans l'API.
-- Meme raison que pour les flux : l'unicite du nom est par compte.
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL
);

-- Ce qu'on ne veut plus voir arriver, ou qu'on veut retrouver : un motif, un
-- champ, une action. Un feed_id NUL vaut « partout ».
CREATE TABLE IF NOT EXISTS rules (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feed_id    INTEGER REFERENCES feeds(id) ON DELETE CASCADE,
  champ      TEXT NOT NULL DEFAULT 'titre',
  motif      TEXT NOT NULL,
  action     TEXT NOT NULL,
  valeur     TEXT,
  actif      INTEGER NOT NULL DEFAULT 1,
  touches    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS article_tags (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (article_id, tag_id)
);
`);

/* -------------------------------------------------------------- migrations */

/**
 * Reecrit une table pour lui retirer une contrainte de colonne : SQLite ne
 * sait pas le faire autrement. Seules les colonnes communes aux deux schemas
 * sont recopiees — une base d'avant les comptes n'a pas encore `user_id`, et
 * les colonnes que le nouveau schema ajoute prennent leur valeur par defaut.
 *
 * Ces reecritures passent avant `addColumn`, et non apres : dans l'autre
 * ordre, la table neuve ignorait les colonnes qu'on venait d'ajouter et les
 * effacait aussitot.
 */
function reecrireTable(nom, schema, colonnes) {
  const anciennes = db.prepare(`PRAGMA table_info(${nom})`).all().map((c) => c.name);
  const communes = colonnes.filter((c) => anciennes.includes(c)).join(', ');
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE ${nom}_nouveau (${schema});
    INSERT INTO ${nom}_nouveau (${communes}) SELECT ${communes} FROM ${nom};
    DROP TABLE ${nom};
    ALTER TABLE ${nom}_nouveau RENAME TO ${nom};
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

/* Les reglages d'une base existante n'ont que (key, value) : le CREATE TABLE
   IF NOT EXISTS plus haut ne les a pas touches. Il faut donc reecrire la table
   pour lui donner son proprietaire. Tout ce qui existait va au service
   (user_id = 0) ; `adopterOrphelins` deplacera ensuite vers le premier compte
   ce qui est personnel. */
{
  const colonnes = db.prepare('PRAGMA table_info(settings)').all();
  if (colonnes.length && !colonnes.some((c) => c.name === 'user_id')) {
    db.exec(`
      BEGIN;
      CREATE TABLE settings_nouveau (
        user_id INTEGER NOT NULL DEFAULT 0,
        key     TEXT NOT NULL,
        value   TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
      );
      INSERT INTO settings_nouveau (user_id, key, value) SELECT 0, key, value FROM settings;
      DROP TABLE settings;
      ALTER TABLE settings_nouveau RENAME TO settings;
      COMMIT;
    `);
    console.log('[bublee] reglages : passes par compte.');
  }
}

/* L'adresse d'un flux etait unique globalement : deux personnes ne pouvaient
   pas suivre Le Monde toutes les deux. L'unicite passe au compte, portee par
   un index — il faut donc reecrire la table pour retirer la contrainte. */
{
  const index = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='feeds'").all();
  if (index.some((i) => /sqlite_autoindex_feeds/.test(i.name))) {
    reecrireTable('feeds', `
      id             INTEGER PRIMARY KEY,
      url            TEXT NOT NULL,
      site_url       TEXT,
      title          TEXT NOT NULL DEFAULT '',
      custom_title   TEXT,
      description    TEXT,
      folder         TEXT NOT NULL DEFAULT '',
      icon           TEXT,
      etag           TEXT,
      last_modified  TEXT,
      last_fetched_at INTEGER,
      last_error     TEXT,
      error_count    INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL,
      priority       TEXT NOT NULL DEFAULT 'suivi',
      user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE
    `, ['id', 'url', 'site_url', 'title', 'custom_title', 'description', 'folder', 'icon', 'etag',
      'last_modified', 'last_fetched_at', 'last_error', 'error_count', 'created_at', 'priority', 'user_id']);
    console.log('[bublee] flux : unicite de l adresse passee du global au compte.');
  }
}

/* Une etiquette n'est unique que dans le compte qui la porte : deux personnes
   ont le droit d'avoir chacune une etiquette « veille ». Meme reecriture. */
{
  const index = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tags'").all();
  if (index.some((i) => /sqlite_autoindex_tags/.test(i.name))) {
    reecrireTable('tags', `
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL COLLATE NOCASE,
      created_at INTEGER NOT NULL,
      color      TEXT,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE
    `, ['id', 'name', 'created_at', 'color', 'user_id']);
    console.log('[bublee] etiquettes : unicite passee du global au compte.');
  }
}

/** Ajoute les colonnes apparues apres coup, sans toucher aux donnees en place. */
function addColumn(table, name, definition) {
  const present = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name);
  if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  return !present;
}

export const migrationApplied = [
  addColumn('articles', 'url_key', 'TEXT'),
  addColumn('articles', 'title_key', 'TEXT'),
  addColumn('articles', 'dupe_of', 'INTEGER REFERENCES articles(id) ON DELETE SET NULL'),
  addColumn('articles', 'full_content', 'TEXT'),
  addColumn('articles', 'full_fetched_at', 'INTEGER'),
  addColumn('articles', 'full_error', 'TEXT'),
  addColumn('articles', 'image_checked', 'INTEGER'),
  addColumn('articles', 'duration', 'INTEGER'),
  addColumn('tags', 'color', 'TEXT'),
  // Toutes les sources ne se lisent pas pareil : certaines se lisent en entier,
  // d'autres se survolent, d'autres ne doivent plus remonter d'elles-memes.
  addColumn('feeds', 'priority', "TEXT NOT NULL DEFAULT 'suivi'"),
  // Deux couleurs moyennes de l'illustration, « #rrggbb,#rrggbb » : elles
  // tiennent la place pendant que l'image arrive.
  addColumn('articles', 'image_color', 'TEXT'),
  // Le proprietaire d'un flux. NULL le temps de la migration ci-dessous, qui
  // rattache l'existant au premier compte cree.
  addColumn('feeds', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE'),
  addColumn('tags', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE'),
  // Date de la recherche d'icone, trouvee ou non : on ne la refait pas.
  addColumn('feeds', 'icon_checked', 'INTEGER'),
  // Avant cette date, le rafraichissement automatique passe son tour : recul
  // apres une erreur, ou Retry-After demande par le serveur.
  addColumn('feeds', 'next_fetch_at', 'INTEGER'),
  // Le texte complet, source par source : auto (le seuil de mots decide),
  // toujours (on va le chercher des l'arrivee), jamais (le flux suffit).
  addColumn('feeds', 'fulltext', "TEXT NOT NULL DEFAULT 'auto'"),
  // L'ordre voulu dans l'index. Zero partout au depart : les sources restent
  // alors rangees par titre, et seul un dossier qu'on a ordonne a la main
  // s'ecarte de l'alphabet.
  addColumn('feeds', 'position', 'INTEGER NOT NULL DEFAULT 0')
].some(Boolean);

/* Les icones demandees a Google disaient a Google quelles sources on lit.
   On les oublie : le prochain rafraichissement ira lire celle du site. */
{
  const n = db.prepare("UPDATE feeds SET icon = NULL, icon_checked = NULL WHERE icon LIKE '%google.com/s2/favicons%'").run().changes;
  if (n) console.log(`[bublee] ${n} icone(s) Google oubliee(s) : elles seront relues sur les sites.`);
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_feed      ON articles(feed_id, published_at DESC);
-- La vue « Non lus » trie par (published_at, id) : l'index doit porter les
-- deux, sinon SQLite retrie en memoire le dernier terme a chaque page.
DROP INDEX IF EXISTS idx_articles_unread;
CREATE INDEX IF NOT EXISTS idx_articles_lecture   ON articles(read_at, published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_articles_starred   ON articles(starred, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_urlkey    ON articles(url_key);
CREATE INDEX IF NOT EXISTS idx_articles_titlekey  ON articles(title_key, published_at);
CREATE INDEX IF NOT EXISTS idx_articles_dupe      ON articles(dupe_of);
CREATE INDEX IF NOT EXISTS idx_article_tags_tag   ON article_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_feeds_priority     ON feeds(priority);
CREATE INDEX IF NOT EXISTS idx_feeds_user         ON feeds(user_id);
CREATE INDEX IF NOT EXISTS idx_tags_user          ON tags(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user      ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expire    ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_rules_user         ON rules(user_id, actif);
-- L'unicite qui compte : une adresse par compte, un nom d'etiquette par compte.
CREATE UNIQUE INDEX IF NOT EXISTS idx_feeds_url_par_compte ON feeds(user_id, url);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_nom_par_compte  ON tags(user_id, name);
`);

/* ------------------------------------------------------------- recherche */

/* La recherche portait sur le titre, le resume et l'auteur — pas sur le corps
   des articles. FTS5 indexe le texte entier, sans accents et par prefixe.

   Le corps est nettoye de son balisage avant d'etre indexe : sans ca, `<img>`
   et `<span>` deviendraient des mots, et chercher « src » remonterait la
   moitie de la bibliotheque. D'ou cette fonction SQL, appelee par les
   declencheurs — c'est ce qui garantit que l'index ne peut pas deriver de la
   table, quel que soit le chemin d'ecriture. */
db.function('texte_brut', (html) => toPlainText(html || ''));

db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title, summary, author, body,
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS articles_fts_insere AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts (rowid, title, summary, author, body)
  VALUES (new.id, new.title, new.summary, new.author,
          texte_brut(COALESCE(new.full_content, new.content)));
END;

CREATE TRIGGER IF NOT EXISTS articles_fts_supprime AFTER DELETE ON articles BEGIN
  DELETE FROM articles_fts WHERE rowid = old.id;
END;

-- Sur les seules colonnes indexees : marquer un article comme lu ne doit pas
-- couter une reindexation de tout son texte.
CREATE TRIGGER IF NOT EXISTS articles_fts_modifie
AFTER UPDATE OF title, summary, author, content, full_content ON articles BEGIN
  DELETE FROM articles_fts WHERE rowid = old.id;
  INSERT INTO articles_fts (rowid, title, summary, author, body)
  VALUES (new.id, new.title, new.summary, new.author,
          texte_brut(COALESCE(new.full_content, new.content)));
END;
`);

/** Indexe les articles arrives avant la recherche plein texte. */
function backfillRecherche() {
  const restants = db.prepare(
    'SELECT COUNT(*) n FROM articles WHERE id NOT IN (SELECT rowid FROM articles_fts)'
  ).get().n;
  if (!restants) return 0;

  db.exec(`
    INSERT INTO articles_fts (rowid, title, summary, author, body)
    SELECT a.id, a.title, a.summary, a.author, texte_brut(COALESCE(a.full_content, a.content))
    FROM articles a WHERE a.id NOT IN (SELECT rowid FROM articles_fts)
  `);
  return restants;
}

/** Renseigne les cles de comparaison sur les articles deja stockes. */
function backfillKeys() {
  const restants = db.prepare(
    'SELECT id, url, title FROM articles WHERE url_key IS NULL AND title_key IS NULL'
  ).all();
  if (!restants.length) return 0;

  const maj = db.prepare('UPDATE articles SET url_key = ?, title_key = ? WHERE id = ?');
  db.transaction(() => {
    for (const row of restants) maj.run(urlKey(row.url), titleKey(row.title), row.id);
  })();
  return restants.length;
}

if (migrationApplied) {
  const n = backfillKeys();
  if (n) console.log(`[bublee] cles de deduplication calculees pour ${n} article(s).`);
}

{
  const n = backfillRecherche();
  if (n) console.log(`[bublee] ${n} article(s) ajoute(s) a l'index de recherche.`);
}

/**
 * Rattache au premier compte tout ce qui existait avant les comptes. Sans ca,
 * la bibliotheque d'origine n'appartiendrait a personne et resterait invisible.
 */
export function adopterOrphelins(userId) {
  const flux = db.prepare('UPDATE feeds SET user_id = ? WHERE user_id IS NULL').run(userId).changes;
  const etiquettes = db.prepare('UPDATE tags SET user_id = ? WHERE user_id IS NULL').run(userId).changes;
  const reglages = db.prepare(
    "UPDATE settings SET user_id = ? WHERE user_id = 0 AND key NOT IN ('last_refresh_at')"
  ).run(userId).changes;
  return { flux, etiquettes, reglages };
}

export const orphelinsEnAttente = () =>
  db.prepare('SELECT COUNT(*) n FROM feeds WHERE user_id IS NULL').get().n;

/* ---------------------------------------------------------------- reglages */

/* Les reglages sont par compte. `user_id = 0` est reserve au service lui-meme,
   pour ce qui n'appartient a personne — la date du dernier rafraichissement. */
export const REGLAGES_SERVICE = 0;

export function getSetting(key, fallback = null, userId = REGLAGES_SERVICE) {
  const row = db.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?').get(userId, key);
  return row ? row.value : fallback;
}

export function setSetting(key, value, userId = REGLAGES_SERVICE) {
  db.prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `).run(userId, key, String(value));
}
