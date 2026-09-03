// Recuperation et analyse des flux : RSS 2.0, RSS 1.0 (RDF) et Atom.
import { XMLParser } from 'fast-xml-parser';
import { sanitizeHtml, toPlainText, firstImage, decodeEntities, countWords, absolutize } from './html.js';
import { httpGet, decodeBody, MAX_BYTES } from './http.js';
import { estYouTube, resoudreFluxYouTube, contenuVideo } from './youtube.js';
import { estSpotify, resoudreFluxSpotify } from './spotify.js';
import { fluxDePlateforme } from './plateformes.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  // Les vrais flux depassent vite la limite d'entites par defaut (1000) :
  // on l'ouvre largement tout en gardant un garde-fou anti « billion laughs ».
  processEntities: {
    enabled: true,
    maxEntitySize: 20000,
    maxExpansionDepth: 4,
    maxTotalExpansions: 500000,
    maxExpandedLength: MAX_BYTES,
    maxEntityCount: 4000
  },
  htmlEntities: true,
  // Certains flux collent du HTML mal ferme hors CDATA : la limite par
  // defaut (100) les rejette alors qu'ils restent lisibles.
  maxNestedTags: 500,
  isArray: (name) => ['item', 'entry', 'link', 'category', 'enclosure', 'media:content', 'media:thumbnail'].includes(name)
});

/** Beaucoup de flux mettent leur propre URL en <link> : on retombe sur le domaine. */
function normalizeSiteUrl(siteUrl, feedUrl) {
  if (!siteUrl) return null;
  const ressembleAuFlux = siteUrl === feedUrl || /\.(xml|rss|atom)(\?|$)|\/feed\/?$|\/rss\/?$/i.test(siteUrl);
  if (!ressembleAuFlux) return siteUrl;
  try { return new URL(siteUrl).origin + '/'; } catch { return siteUrl; }
}

/** Extrait une chaine d'un noeud qui peut etre texte, nombre ou objet. */
function text(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === 'object') {
    if ('#text' in node) return text(node['#text']);
    if ('@_href' in node) return String(node['@_href']);
    if ('@_url' in node) return String(node['@_url']);
  }
  return '';
}

function pick(obj, ...keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) {
      const value = text(obj[key]);
      if (value) return value;
    }
  }
  return '';
}

function parseDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  let ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    // Certains flux ecrivent "2024-03-05 10:00:00" ou collent un fuseau exotique.
    ms = Date.parse(raw.replace(' ', 'T').replace(/\s+[A-Z]{3,4}$/, 'Z'));
  }
  if (Number.isNaN(ms)) return null;
  // On refuse les dates absurdes (flux mal configures dans le futur lointain).
  const now = Date.now();
  if (ms > now + 7 * 24 * 3600 * 1000) return now;
  if (ms < Date.parse('1995-01-01')) return null;
  return ms;
}

function atomLink(links, rels = ['alternate']) {
  if (!links) return '';
  const list = Array.isArray(links) ? links : [links];
  for (const rel of rels) {
    const hit = list.find((l) => l && typeof l === 'object' && (l['@_rel'] || 'alternate') === rel && l['@_href']);
    if (hit) return String(hit['@_href']);
  }
  const plain = list.find((l) => typeof l === 'string' && l.trim());
  return plain ? String(plain).trim() : '';
}

/** Beaucoup de flux joignent l'image sans dire que c'en est une. */
function ressembleAUneImage(url) {
  return /\.(jpe?g|png|gif|webp|avif|bmp)(\?|#|$)/i.test(String(url || ''));
}

function mediaImage(node) {
  const candidates = [];
  const push = (v) => { if (v) candidates.push(v); };

  for (const key of ['media:content', 'media:thumbnail']) {
    const entries = node[key];
    if (!entries) continue;
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      if (!entry || typeof entry !== 'object') continue;
      const type = String(entry['@_type'] || entry['@_medium'] || '');
      // Type absent : on se fie a l'extension plutot que d'ecarter l'image.
      if (type ? !/^image/i.test(type) : !ressembleAUneImage(entry['@_url'])) continue;
      push(entry['@_url']);
    }
  }

  if (node['media:group']) push(mediaImage(node['media:group']));

  for (const enclosure of Array.isArray(node.enclosure) ? node.enclosure : [node.enclosure].filter(Boolean)) {
    if (!enclosure || typeof enclosure !== 'object') continue;
    const type = String(enclosure['@_type'] || '');
    if (type ? /^image\//i.test(type) : ressembleAUneImage(enclosure['@_url'])) {
      push(enclosure['@_url']);
    }
  }

  if (node['itunes:image'] && node['itunes:image']['@_href']) push(node['itunes:image']['@_href']);
  push(pick(node, 'itunes:image'));

  // <image> dans l'entree, plus rare mais utilise par quelques CMS.
  if (node.image) push(typeof node.image === 'object' ? pick(node.image, 'url', 'href') : node.image);

  return candidates.find(Boolean) || null;
}

/** Repere la piece jointe audio d'un episode de podcast. */
function audioJoint(node) {
  const estAudio = (type, url) => (type
    ? /^audio\//i.test(type)
    : /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|#|$)/i.test(String(url || '')));

  for (const enclosure of Array.isArray(node.enclosure) ? node.enclosure : [node.enclosure].filter(Boolean)) {
    if (!enclosure || typeof enclosure !== 'object') continue;
    if (estAudio(String(enclosure['@_type'] || ''), enclosure['@_url'])) return String(enclosure['@_url']);
  }

  for (const entree of Array.isArray(node['media:content']) ? node['media:content'] : []) {
    if (!entree || typeof entree !== 'object') continue;
    if (estAudio(String(entree['@_type'] || entree['@_medium'] || ''), entree['@_url'])) return String(entree['@_url']);
  }
  return null;
}

/** « 3600 », « 01:02:03 » ou « 38:12 » — tout finit en secondes. */
function dureeEnSecondes(brut) {
  const texte = String(brut || '').trim();
  if (!texte) return null;
  if (/^\d+$/.test(texte)) return Number(texte) || null;

  const parts = texte.split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  const secondes = parts.reduce((total, p) => total * 60 + p, 0);
  return secondes > 0 ? secondes : null;
}

function itemGuid(node, link, title, publishedAt) {
  const guid = node.guid;
  if (guid && typeof guid === 'object' && guid['#text']) return String(guid['#text']);
  if (typeof guid === 'string' && guid.trim()) return guid.trim();
  const id = pick(node, 'id', 'atom:id');
  if (id) return id;
  if (link) return link;
  return (title || 'sans-titre') + '#' + (publishedAt || 0);
}

function normalizeItem(node, feedUrl, siteUrl) {
  const link = absolutize(
    pick(node, 'link') || atomLink(node.link) || pick(node, 'guid'),
    siteUrl || feedUrl
  );
  const base = link || siteUrl || feedUrl;

  const title = decodeEntities(toPlainText(pick(node, 'title') || '(sans titre)')) || '(sans titre)';
  const publishedAt = parseDate(
    pick(node, 'pubDate', 'published', 'dc:date', 'updated', 'date', 'lastBuildDate')
  );

  // Une video YouTube n'a ni <content> ni <description> : tout est dans
  // <media:group>. On compose le lecteur et la description a la place.
  const videoId = pick(node, 'yt:videoId');
  const groupe = node['media:group'];
  const descriptionVideo = groupe ? pick(groupe, 'media:description') : '';

  const rawContent = videoId
    ? contenuVideo(videoId, descriptionVideo)
    : pick(node, 'content:encoded', 'content', 'description', 'summary', 'subtitle');

  const rawSummary = videoId
    ? descriptionVideo
    : pick(node, 'description', 'summary', 'subtitle') || rawContent;

  // Episode de podcast : le lecteur audio precede le texte de l'episode.
  const audio = videoId ? null : audioJoint(node);
  const lecteurAudio = audio
    ? `<p><audio controls preload="none" src="${absolutize(audio, base) || ''}"></audio></p>`
    : '';

  const content = sanitizeHtml(lecteurAudio + rawContent, base);
  const plain = toPlainText(rawSummary);

  const author = decodeEntities(
    pick(node, 'dc:creator', 'author', 'itunes:author') ||
    (node.author && typeof node.author === 'object' ? pick(node.author, 'name') : '')
  );

  return {
    guid: itemGuid(node, link, title, publishedAt),
    url: link,
    title,
    author: author ? author.slice(0, 160) : null,
    summary: plain.slice(0, 600),
    content,
    image: mediaImage(node) || firstImage(content, base),
    published_at: publishedAt || Date.now(),
    duration: dureeEnSecondes(pick(node, 'itunes:duration', 'duration')),
    word_count: countWords(toPlainText(content) || plain)
  };
}

/** Transforme le XML brut d'un flux en { title, siteUrl, description, items }. */
export function parseFeed(xml, feedUrl) {
  const doc = parser.parse(xml);
  const root = doc.rss || doc['rdf:RDF'] || doc.RDF || doc.feed || doc['atom:feed'];
  if (!root) throw new Error('Format non reconnu : ni RSS, ni Atom.');

  // --- Atom ---
  if (doc.feed || doc['atom:feed']) {
    const feed = doc.feed || doc['atom:feed'];
    const siteUrl = normalizeSiteUrl(absolutize(atomLink(feed.link, ['alternate', 'self']), feedUrl), feedUrl);
    const entries = feed.entry || [];
    return {
      title: decodeEntities(toPlainText(pick(feed, 'title'))) || feedUrl,
      siteUrl,
      description: decodeEntities(toPlainText(pick(feed, 'subtitle', 'tagline'))),
      items: (Array.isArray(entries) ? entries : [entries]).map((e) => normalizeItem(e, feedUrl, siteUrl))
    };
  }

  // --- RSS 2.0 / RDF ---
  const channel = root.channel || root;
  const siteUrl = normalizeSiteUrl(absolutize(pick(channel, 'link') || atomLink(channel.link), feedUrl), feedUrl);
  const items = root.item || channel.item || [];

  return {
    title: decodeEntities(toPlainText(pick(channel, 'title'))) || feedUrl,
    siteUrl,
    description: decodeEntities(toPlainText(pick(channel, 'description', 'subtitle'))),
    items: (Array.isArray(items) ? items : [items]).map((i) => normalizeItem(i, feedUrl, siteUrl))
  };
}

/** Retry-After vaut des secondes ou une date HTTP ; null si absent ou illisible. */
export function retryAfterEnMs(valeur) {
  if (!valeur) return null;
  const brut = String(valeur).trim();
  if (/^\d+$/.test(brut)) return Number(brut) * 1000;
  const date = Date.parse(brut);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

const ACCEPT_FLUX =
  'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5';

const getFlux = (url, headers = {}, timeout) =>
  httpGet(url, { headers: { accept: ACCEPT_FLUX, ...headers }, ...(timeout ? { timeout } : {}) });

/**
 * Telecharge un flux en respectant ETag / Last-Modified.
 * Retourne { notModified } ou { parsed, etag, lastModified, finalUrl }.
 */
export async function fetchFeed(url, { etag, lastModified } = {}) {
  const headers = {};
  if (etag) headers['if-none-match'] = etag;
  if (lastModified) headers['if-modified-since'] = lastModified;

  const { res, buffer } = await getFlux(url, headers);
  if (res.status === 304) return { notModified: true };
  if (!res.ok) {
    const erreur = new Error('HTTP ' + res.status + ' ' + res.statusText);
    // « Reviens dans N secondes » : on le respecte, c'est le serveur qui parle.
    if (res.status === 429 || res.status === 503) erreur.retryAfterMs = retryAfterEnMs(res.headers.get('retry-after'));
    throw erreur;
  }

  const body = decodeBody(buffer, res.headers.get('content-type'));
  const parsed = parseFeed(body, res.url || url);

  return {
    parsed,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    finalUrl: res.url || url
  };
}

const COMMON_PATHS = [
  '/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml',
  '/feeds/posts/default', '/blog/feed', '/en/feed', '/fr/feed', '/?feed=rss2'
];

function looksLikeFeed(body) {
  return /<(rss|feed|rdf:RDF)[\s>]/i.test(body.slice(0, 2000));
}

/**
 * A partir d'une URL quelconque (page d'accueil ou flux), retourne la liste
 * des flux trouves : [{ url, title }]. Les doublons sont ecartes.
 */
export async function discoverFeeds(input) {
  let url = String(input).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  /** Un candidat deduit n'est retenu que s'il repond vraiment. */
  const verifier = async (candidat) => {
    if (!candidat) return null;
    try {
      const { res, buffer } = await getFlux(candidat);
      if (!res.ok) return null;
      const parsed = parseFeed(decodeBody(buffer, res.headers.get('content-type')), candidat);
      return parsed.items?.length ? [{ url: candidat, title: parsed.title }] : null;
    } catch {
      return null;   // on retombe sur la decouverte classique
    }
  };

  // YouTube n'annonce pas son flux dans la page : on le deduit de l'adresse.
  if (estYouTube(url)) {
    const trouve = await verifier(await resoudreFluxYouTube(url).catch(() => null));
    if (trouve) return trouve;
  }

  // Spotify n'heberge aucun flux : on remonte du lien au vrai RSS du podcast,
  // celui que Spotify lui-meme reprend. Une exclusivite, elle, n'en a nulle
  // part — on retombe alors sur la decouverte ordinaire plutot que d'inventer.
  if (estSpotify(url)) {
    const trouve = await verifier(await resoudreFluxSpotify(url).catch(() => null));
    if (trouve) return trouve;
  }

  // Mastodon, Bluesky, Reddit, GitHub : meme silence, meme deduction.
  const dePlateforme = await verifier(fluxDePlateforme(input));
  if (dePlateforme) return dePlateforme;

  const found = new Map();

  let body = '';
  let finalUrl = url;
  try {
    const { res, buffer } = await getFlux(url, {}, 10000);
    if (res.ok) {
      body = decodeBody(buffer, res.headers.get('content-type'));
      finalUrl = res.url || url;
    }
  } catch {
    // On tentera quand meme les chemins classiques ci-dessous.
  }

  if (body && looksLikeFeed(body)) {
    try {
      const parsed = parseFeed(body, finalUrl);
      found.set(finalUrl, { url: finalUrl, title: parsed.title });
      return [...found.values()];
    } catch { /* on continue en mode page HTML */ }
  }

  if (body) {
    const linkRe = /<link\b[^>]*>/gi;
    let m;
    while ((m = linkRe.exec(body))) {
      const tag = m[0];
      if (!/rel\s*=\s*["']?[^"'>]*alternate/i.test(tag)) continue;
      if (!/type\s*=\s*["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
      const href = /href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(tag);
      if (!href) continue;
      const abs = absolutize(href[1].replace(/^["']|["']$/g, ''), finalUrl);
      if (!abs || found.has(abs)) continue;
      const titleMatch = /title\s*=\s*("[^"]*"|'[^']*')/i.exec(tag);
      found.set(abs, {
        url: abs,
        title: titleMatch ? decodeEntities(titleMatch[1].slice(1, -1)) : ''
      });
    }
  }

  if (found.size === 0) {
    const origin = new URL(finalUrl).origin;
    const essayer = async (path) => {
      const candidate = origin + path;
      const { res, buffer } = await getFlux(candidate, {}, 6000);
      if (!res.ok) return null;
      const text = decodeBody(buffer, res.headers.get('content-type'));
      if (!looksLikeFeed(text)) return null;
      return { url: candidate, title: parseFeed(text, candidate).title };
    };
    // Par vagues de quatre plutot qu'un a un : en serie, onze chemins a six
    // secondes faisaient attendre plus d'une minute un site sans flux. L'ordre
    // des chemins reste celui de la liste a l'interieur d'une vague.
    for (let i = 0; i < COMMON_PATHS.length && found.size === 0; i += VAGUE) {
      const vague = await Promise.allSettled(COMMON_PATHS.slice(i, i + VAGUE).map(essayer));
      const trouve = vague.find((r) => r.status === 'fulfilled' && r.value)?.value;
      if (trouve) found.set(trouve.url, trouve);
    }
  }

  return [...found.values()];
}

const VAGUE = 4;
