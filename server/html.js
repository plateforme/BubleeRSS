// Nettoyage du HTML des articles : liste blanche de balises/attributs,
// suppression des scripts, resolution des URLs relatives.

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'kbd', 'samp',
  'em', 'strong', 'i', 'b', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'a', 'img', 'figure', 'figcaption', 'picture', 'source', 'video', 'audio',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'span', 'div', 'section', 'article', 'cite', 'time', 'abbr', 'iframe'
]);

const ALLOWED_ATTRS = {
  a: ['href', 'title'],
  img: ['src', 'srcset', 'sizes', 'alt', 'title', 'width', 'height'],
  source: ['src', 'srcset', 'sizes', 'type', 'media'],
  video: ['src', 'poster', 'controls', 'width', 'height'],
  audio: ['src', 'controls'],
  iframe: ['src', 'width', 'height', 'allow', 'allowfullscreen', 'title'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  time: ['datetime'],
  abbr: ['title'],
  blockquote: ['cite']
};

const VOID_TAGS = new Set(['br', 'hr', 'img', 'source', 'input', 'meta', 'link', 'wbr']);

// Seuls ces hotes peuvent rester en <iframe> (lecteurs video / audio).
const EMBED_HOSTS = [
  'youtube.com', 'youtube-nocookie.com', 'youtu.be', 'player.vimeo.com', 'vimeo.com',
  'dailymotion.com', 'w.soundcloud.com', 'bandcamp.com', 'open.spotify.com',
  'anchor.fm', 'podcasters.spotify.com', 'archive.org'
];

const DROPPED_WITH_CONTENT = /<(script|style|noscript|template|form|svg|object|embed|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const DROPPED_SELF = /<\/?(script|style|noscript|template|form|svg|object|embed|canvas)\b[^>]*>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function isEmbeddable(url) {
  const host = hostOf(url);
  return EMBED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

export function absolutize(url, base) {
  if (!url) return null;
  const raw = String(url).trim();
  if (/^(javascript|data|vbscript|file):/i.test(raw)) {
    // On tolere les petites images inline, rien d'autre.
    return /^data:image\//i.test(raw) && raw.length < 200000 ? raw : null;
  }
  if (!base) return /^https?:\/\//i.test(raw) ? raw : null;
  try { return new URL(raw, base).href; } catch { return null; }
}

function cleanSrcset(value, base) {
  return value
    .split(',')
    .map((part) => {
      const bits = part.trim().split(/\s+/);
      const src = absolutize(bits[0], base);
      return src ? [src, ...bits.slice(1)].join(' ') : null;
    })
    .filter(Boolean)
    .join(', ');
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let m;
  while ((m = re.exec(raw))) {
    const value = m[2] ? m[2].replace(/^["']|["']$/g, '') : '';
    attrs[m[1].toLowerCase()] = value;
  }
  return attrs;
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Nettoie un fragment HTML issu d'un flux. `base` sert a resoudre les liens relatifs. */
export function sanitizeHtml(input, base = null) {
  if (!input) return '';
  const html = String(input)
    .replace(COMMENTS, '')
    .replace(DROPPED_WITH_CONTENT, '')
    .replace(DROPPED_SELF, '');

  const open = [];
  let out = '';
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;
  let cursor = 0;
  let m;

  while ((m = tagRe.exec(html))) {
    out += html.slice(cursor, m.index);
    cursor = m.index + m[0].length;

    const tag = m[1].toLowerCase();
    const closing = m[0].startsWith('</');

    if (!ALLOWED_TAGS.has(tag)) continue;

    if (closing) {
      const idx = open.lastIndexOf(tag);
      if (idx === -1) continue;
      // On ferme aussi les balises restees ouvertes a l'interieur.
      for (let i = open.length - 1; i >= idx; i--) out += '</' + open[i] + '>';
      open.length = idx;
      continue;
    }

    const attrs = parseAttrs(m[2] || '');
    const allowed = ALLOWED_ATTRS[tag] || [];
    const kept = [];
    let dropTag = false;

    for (const name of allowed) {
      let value = attrs[name];
      if (value === undefined) continue;

      if (name === 'src' || name === 'href' || name === 'poster' || name === 'cite') {
        value = absolutize(value, base);
        if (!value) { dropTag = true; break; }
      } else if (name === 'srcset') {
        value = cleanSrcset(value, base);
        if (!value) continue;
      }
      kept.push(value === '' ? name : name + '="' + escapeAttr(value) + '"');
    }

    if (dropTag) continue;

    if (tag === 'a') {
      if (!kept.some((a) => a.startsWith('href='))) continue;
      kept.push('target="_blank"', 'rel="noopener noreferrer external"');
    }
    if (tag === 'img') {
      if (!kept.some((a) => a.startsWith('src='))) continue;
      kept.push('loading="lazy"', 'referrerpolicy="no-referrer"');
    }
    if (tag === 'iframe') {
      const src = attrs.src ? absolutize(attrs.src, base) : null;
      if (!src || !isEmbeddable(src)) continue;
    }

    const attrStr = kept.length ? ' ' + kept.join(' ') : '';
    if (VOID_TAGS.has(tag)) {
      out += '<' + tag + attrStr + '>';
    } else {
      open.push(tag);
      out += '<' + tag + attrStr + '>';
    }
  }

  out += html.slice(cursor);
  while (open.length) out += '</' + open.pop() + '>';

  return out.replace(/(\s*<p>\s*(?:<br\s*\/?>)?\s*<\/p>\s*)+/gi, '\n').trim();
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', laquo: '«', raquo: '»',
  hellip: '…', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç',
  ugrave: 'ù', ecirc: 'ê', acirc: 'â', icirc: 'î', ocirc: 'ô',
  ucirc: 'û', euml: 'ë', iuml: 'ï', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', euro: '€',
  copy: '©', reg: '®', trade: '™', deg: '°', middot: '·',
  bull: '•', times: '×', frac12: '½', prime: '′'
};

export function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, code) => {
    if (code[0] === '#') {
      const num = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(num) && num > 0 ? String.fromCodePoint(num) : full;
    }
    const key = code.toLowerCase();
    return key in ENTITIES ? ENTITIES[key] : full;
  });
}

export function toPlainText(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(DROPPED_WITH_CONTENT, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
  ).replace(/\s+/g, ' ').trim();
}

export function firstImage(html, base = null) {
  if (!html) return null;
  const re = /<img\b[^>]*?\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = absolutize(m[1].replace(/^["']|["']$/g, ''), base);
    // On saute les pixels de tracking et les puces decoratives.
    if (src && !/\b(pixel|spacer|blank|1x1|tracking|feedburner|gravatar)\b/i.test(src)) return src;
  }
  return null;
}

export function countWords(text) {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}
