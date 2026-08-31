// Reperage des doublons : deux articles identiques republies dans un meme flux
// (identifiant qui change) ou repris par plusieurs sources a la fois.

/** Parametres de tracking a jeter avant de comparer deux adresses. */
const TRACKING = [
  /^utm_/i, /^ga_/i, /^at_/i, /^pk_/i, /^mtm_/i, /^mc_/i, /^hsa_/i, /^vero_/i,
  /^(fbclid|gclid|dclid|gbraid|wbraid|msclkid|twclid|yclid|igshid|ttclid)$/i,
  /^(ref|ref_src|refsrc|referrer|source|src|cmpid|ncid|spm|xtor|xtref|from)$/i,
  /^(sh|share|shared|s_kwcid|_ga|_gl|__twitter_impression|guccounter|guce_referrer|guce_referrer_sig)$/i,
  /^(amp|outputType|smid|partner|CMP|cmp)$/i
];

const estTracking = (nom) => TRACKING.some((re) => re.test(nom));

/**
 * Reduit une adresse a une cle stable : meme article, meme cle.
 * Ignore le schema, le www, le fragment, les parametres de tracking,
 * les variantes AMP et la barre oblique finale.
 */
export function urlKey(input) {
  if (!input) return null;
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;

  const host = url.hostname.toLowerCase().replace(/^(www|m|amp|mobile)\./, '');

  let path = url.pathname
    .replace(/\/amp\/?$/i, '/')      // .../article/amp
    .replace(/\.amp(\.html?)?$/i, '$1')
    .replace(/\/index\.(html?|php|aspx?)$/i, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
  if (!path) path = '/';

  const params = [...url.searchParams.entries()]
    .filter(([nom]) => !estTracking(nom))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([nom, valeur]) => nom + '=' + valeur);

  // Une adresse sans chemin ni parametre ne designe pas un article : beaucoup de
  // podcasts et de blogs mettent la racine du site en <link> sur chaque episode.
  // La rapprocher d'une autre ferait passer des articles distincts pour des copies.
  if (path === '/' && !params.length) return null;

  return host + path.toLowerCase() + (params.length ? '?' + params.join('&') : '');
}

/**
 * Reduit un titre a une cle comparable : sans accents, sans ponctuation,
 * sans le nom du site souvent colle en fin de titre.
 */
export function titleKey(input) {
  if (!input) return null;
  const nettoye = String(input)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // « Titre de l'article - Le Monde » / « … | Numerama »
    .replace(/\s+[-–—|·]\s+[^-–—|·]{2,30}$/u, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return nettoye ? nettoye.slice(0, 160) : null;
}

/** Un titre trop court ne suffit pas a affirmer que deux articles sont identiques. */
export const TITRE_FIABLE = 30;

/** Fenetre de tolerance quand on rapproche deux articles par leur titre. */
export const FENETRE_TITRE_MS = 36 * 3600 * 1000;
