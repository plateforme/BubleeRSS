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

/* ------------------------------------------------------------------ tables */

db.exec(`
CREATE TABLE IF NOT EXISTS feeds (
  id             INTEGER PRIMARY KEY,
  url            TEXT NOT NULL UNIQUE,
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

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Etiquettes posees a la main sur les articles, pour les retrouver ensuite
-- dans l'interface comme dans l'API.
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
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
  addColumn('feeds', 'priority', "TEXT NOT NULL DEFAULT 'suivi'")
].some(Boolean);

db.exec(`
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_feed      ON articles(feed_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_unread    ON articles(read_at, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_starred   ON articles(starred, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_urlkey    ON articles(url_key);
CREATE INDEX IF NOT EXISTS idx_articles_titlekey  ON articles(title_key, published_at);
CREATE INDEX IF NOT EXISTS idx_articles_dupe      ON articles(dupe_of);
CREATE INDEX IF NOT EXISTS idx_article_tags_tag   ON article_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_feeds_priority     ON feeds(priority);
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

/* ---------------------------------------------------------------- reglages */

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}
