import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { urlKey, titleKey } from './dedupe.js';

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
  addColumn('articles', 'image_checked', 'INTEGER')
].some(Boolean);

db.exec(`
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_feed      ON articles(feed_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_unread    ON articles(read_at, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_starred   ON articles(starred, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_urlkey    ON articles(url_key);
CREATE INDEX IF NOT EXISTS idx_articles_titlekey  ON articles(title_key, published_at);
CREATE INDEX IF NOT EXISTS idx_articles_dupe      ON articles(dupe_of);
`);

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
