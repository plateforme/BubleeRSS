// Import / export OPML (le format d'export de Feedly, Inoreader, NetNewsWire...).
import { XMLParser } from 'fast-xml-parser';
import { db } from './db.js';
import { listFeeds } from './store.js';
import { decodeEntities } from './html.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: { enabled: true, maxExpansionDepth: 4, maxTotalExpansions: 500000, maxEntityCount: 8000 },
  isArray: (name) => name === 'outline'
});

/** Aplatit l'arbre OPML en [{ url, title, folder }]. */
export function parseOpml(xml) {
  const doc = parser.parse(xml);
  const body = doc?.opml?.body;
  if (!body) throw Object.assign(new Error('Fichier OPML illisible.'), { status: 422 });

  const feeds = [];

  function walk(outlines, folder) {
    for (const node of outlines || []) {
      if (!node) continue;
      const label = decodeEntities(String(node['@_title'] || node['@_text'] || '').trim());
      const url = String(node['@_xmlUrl'] || node['@_xmlurl'] || '').trim();

      if (url) {
        feeds.push({ url, title: label, folder });
      } else if (node.outline) {
        // Un outline sans xmlUrl mais avec des enfants : c'est un dossier.
        walk(node.outline, label || folder);
      }
      if (url && node.outline) walk(node.outline, folder);
    }
  }

  walk(body.outline, '');
  return feeds;
}

/** Insere les flux d'un OPML sans les telecharger (le rafraichissement suit). */
export function importOpml(xml, { defaultFolder = '' } = {}) {
  const entries = parseOpml(xml);
  const insert = db.prepare(`
    INSERT INTO feeds (url, title, folder, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(url) DO NOTHING
  `);

  let added = 0;
  let skipped = 0;
  const stamp = Date.now();

  const run = db.transaction(() => {
    for (const entry of entries) {
      if (!/^https?:\/\//i.test(entry.url)) { skipped++; continue; }
      const info = insert.run(entry.url, entry.title || '', entry.folder || defaultFolder, stamp);
      if (info.changes) added++; else skipped++;
    }
  });
  run();

  return { found: entries.length, added, skipped };
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function exportOpml() {
  const feeds = listFeeds();
  const byFolder = new Map();
  for (const feed of feeds) {
    const key = feed.folder || '';
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(feed);
  }

  const line = (feed, indent) =>
    `${indent}<outline type="rss" text="${esc(feed.title)}" title="${esc(feed.title)}" ` +
    `xmlUrl="${esc(feed.url)}"${feed.site_url ? ` htmlUrl="${esc(feed.site_url)}"` : ''}/>`;

  const parts = [];
  for (const [folder, items] of [...byFolder].sort(([a], [b]) => a.localeCompare(b))) {
    if (!folder) {
      parts.push(...items.map((f) => line(f, '    ')));
    } else {
      parts.push(`    <outline text="${esc(folder)}" title="${esc(folder)}">`);
      parts.push(...items.map((f) => line(f, '      ')));
      parts.push('    </outline>');
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Bublee</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${parts.join('\n')}
  </body>
</opml>
`;
}
