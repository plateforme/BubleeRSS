// Couche reseau commune : garde-fous, delais, decodage des jeux de caracteres.

export const USER_AGENT = 'Bublee/1.0 (+lecteur personnel)';

// Un vrai navigateur passe mieux les protections des sites d'actualite.
export const USER_AGENT_NAVIGATEUR =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export const MAX_BYTES = 12 * 1024 * 1024;

const HOTE_PRIVE = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|0\.|.*\.local$|.*\.internal$)/i;

/** Refuse ce qui n'est pas du http(s) public : evite qu'un flux nous fasse sonder le reseau local. */
export function urlPubliqueOuNull(input) {
  let url;
  try { url = new URL(String(input)); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (HOTE_PRIVE.test(url.hostname)) return null;
  return url;
}

/** Devine l'encodage a partir de l'en-tete HTTP puis de la declaration XML/HTML. */
export function decodeBody(buffer, contentType) {
  const head = Buffer.from(buffer.subarray(0, 1024)).toString('latin1');
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || '');
  const fromDoc = /(?:encoding|charset)\s*=\s*["']?([\w-]+)/i.exec(head);
  let charset = (fromHeader?.[1] || fromDoc?.[1] || 'utf-8').toLowerCase();
  if (charset === 'iso-8859-1' || charset === 'latin1') charset = 'windows-1252';
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}

/** GET avec delai maximal et plafond de taille. Retourne { res, buffer }. */
export async function httpGet(url, { headers = {}, timeout = 20000, navigateur = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': navigateur ? USER_AGENT_NAVIGATEUR : USER_AGENT,
        'accept-language': 'fr,fr-FR;q=0.9,en;q=0.7',
        ...headers
      }
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_BYTES) throw new Error('Reponse trop volumineuse.');
    return { res, buffer };
  } finally {
    clearTimeout(timer);
  }
}
