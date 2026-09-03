// Couche reseau commune : garde-fous, delais, decodage des jeux de caracteres.
//
// Tout ce que Bublee telecharge — flux, pages, images, icones — passe ici.
// C'est donc ici que se joue la protection contre le SSRF : un flux, une
// adresse de source ou une image ne doivent jamais faire sonder le reseau
// local par le serveur. Le controle porte sur l'adresse *resolue*, en IPv4 et
// en IPv6, et il est refait a chaque redirection.
import dns from 'node:dns/promises';
import net from 'node:net';

export const USER_AGENT = 'Bublee/1.0 (+lecteur personnel)';

// Un vrai navigateur passe mieux les protections des sites d'actualite.
export const USER_AGENT_NAVIGATEUR =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export const MAX_BYTES = 12 * 1024 * 1024;

// Les flux, eux, ont droit a plus. Un podcast au long cours publie tout son
// catalogue dans un seul fichier : « Generation Do It Yourself » fait quinze
// mega-octets une fois decompresse — un mega et demi sur le fil, ce qui passe
// le controle de taille annoncee et n'echoue qu'a l'arrivee. Douze suffisaient
// aux sites d'actualite, pas a ces flux-la, et les refuser revenait a refuser
// les podcasts les plus suivis. Le plafond reste : il protege d'un flux qui
// n'en finit pas, sans ecarter ceux qui sont simplement gros.
export const MAX_FLUX = 32 * 1024 * 1024;
const REDIRECTIONS_MAX = 5;

/* ------------------------------------------------------- adresses privees */

/** Vrai pour une adresse IPv4 qui ne designe pas l'internet public. */
function ipv4Privee(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)          // CGNAT
    || (a === 169 && b === 254)                     // lien local, metadonnees cloud
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    // Deux /24 reserves, et deux seulement : le troisieme octet compte. Sans
    // lui on refusait tout 192.0.0.0/16, soit soixante-cinq mille adresses
    // parfaitement publiques — dont celles de WordPress.com, ce qui rendait
    // injoignables tous les blogs qui y sont heberges.
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19))        // bancs d'essai
    || a >= 224;                                    // multicast, reserve, diffusion
}

/** Vrai pour une adresse IPv6 privee, y compris une IPv4 privee encapsulee. */
function ipv6Privee(ip) {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v === '::' || v === '::1') return true;
  // ::ffff:a.b.c.d et ::ffff:aabb:ccdd : une IPv4 deguisee.
  const mappee = /^(?:0*:)*ffff:(.+)$/.exec(v);
  if (mappee) {
    const reste = mappee[1];
    if (net.isIPv4(reste)) return ipv4Privee(reste);
    const [h, l] = reste.split(':').map((x) => parseInt(x, 16));
    if (Number.isFinite(h) && Number.isFinite(l)) return ipv4Privee(`${h >> 8}.${h & 255}.${l >> 8}.${l & 255}`);
    return true;
  }
  if (/^64:ff9b:/.test(v)) return true;             // NAT64 : on ne sait pas ce qu'il y a derriere
  const premier = parseInt(v.split(':')[0] || '0', 16);
  return (premier & 0xfe00) === 0xfc00               // fc00::/7 : unique local
    || (premier & 0xffc0) === 0xfe80                 // fe80::/10 : lien local
    || (premier & 0xff00) === 0xff00;                // multicast
}

export function ipPrivee(ip) {
  const v = String(ip || '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(v)) return ipv4Privee(v);
  if (net.isIPv6(v)) return ipv6Privee(v);
  return true;                                       // pas une adresse : on refuse
}

const NOM_PRIVE = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home|.*\.lan|.*\.localdomain)$/i;

/**
 * Refuse ce qui n'est pas du http(s) public, d'apres la seule forme de
 * l'adresse : schema, nom manifestement local, IP litterale privee. C'est le
 * filtre synchrone ; `adressePublique` verifie ensuite ce que le nom resout.
 */
export function urlPubliqueOuNull(input) {
  let url;
  try { url = new URL(String(input)); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const hote = url.hostname;
  if (!hote || NOM_PRIVE.test(hote)) return null;
  if (net.isIP(hote.replace(/^\[|\]$/g, '')) && ipPrivee(hote)) return null;
  return url;
}

/**
 * Le nom resolu ne doit renvoyer que des adresses publiques — toutes, sinon
 * un DNS malicieux glisserait une adresse privee parmi les publiques.
 * Leve une erreur explicite sinon.
 */
export async function adressePublique(url) {
  const parsed = urlPubliqueOuNull(url);
  if (!parsed) throw Object.assign(new Error('Adresse refusée : seule une adresse web publique est acceptée.'), { status: 400 });
  const hote = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hote)) return parsed;

  let adresses;
  try {
    adresses = await dns.lookup(hote, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error('Adresse introuvable : ' + hote), { status: 502 });
  }
  if (!adresses.length || adresses.some((a) => ipPrivee(a.address))) {
    throw Object.assign(new Error('Adresse refusée : elle désigne le réseau local.'), { status: 400 });
  }
  return parsed;
}

/* ------------------------------------------------------------- decodage */

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

/* ------------------------------------------------------------------ GET */

/**
 * Lit le corps en entier, puis verifie le plafond.
 *
 * On ne coupe jamais une lecture en cours — ni `abort()` a mi-parcours, ni
 * `cancel()` sur un corps a moitie lu. Undici, le client HTTP de Node, plante
 * alors son parseur quand la socket se ferme : `assert(!this.paused)`, une
 * exception levee dans un rappel de socket, hors de portee de tout try/catch,
 * qui emporte le processus entier. On lit donc jusqu'au bout et on rejette
 * apres : un peu plus de reseau sur une reponse trop grosse, jamais de chute.
 *
 * Le content-length declare permet quand meme de refuser tot ce qui s'annonce
 * demesure — apres avoir vide ce que le serveur a deja envoye, proprement.
 */
async function lireCorps(res, maxBytes) {
  const annonce = Number(res.headers.get('content-length'));
  if (Number.isFinite(annonce) && annonce > maxBytes) {
    await res.arrayBuffer().catch(() => {});   // drainer sans planter
    throw new Error('Réponse trop volumineuse.');
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('Réponse trop volumineuse.');
  return buffer;
}

/**
 * GET avec delai maximal, plafond de taille et garde-fou SSRF.
 * Retourne { res, buffer }. `res.url` porte l'adresse finale apres redirections.
 *
 * Les redirections sont suivies a la main : chaque saut repasse devant le
 * controle d'adresse, sinon un site public pourrait renvoyer vers 127.0.0.1.
 *
 * `verifier` remplace le controle d'adresse : reserve aux tests, qui n'ont
 * qu'un serveur local sous la main pour eprouver les redirections et le plafond.
 */
export async function httpGet(url, {
  headers = {}, timeout = 20000, navigateur = false, maxBytes = MAX_BYTES, verifier = adressePublique
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let cible = await verifier(url);
    for (let saut = 0; ; saut++) {
      const res = await fetch(cible.href, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': navigateur ? USER_AGENT_NAVIGATEUR : USER_AGENT,
          'accept-language': 'fr,fr-FR;q=0.9,en;q=0.7',
          ...headers
        }
      });

      const vers = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && vers) {
        // Le corps d'une redirection ne sert a rien, mais il faut le lire
        // jusqu'au bout : l'abandonner (cancel) ferait planter undici, comme
        // ci-dessus. On le vide donc, sans le garder.
        await res.arrayBuffer().catch(() => {});
        if (saut >= REDIRECTIONS_MAX) throw new Error('Trop de redirections.');
        let suivante;
        try { suivante = new URL(vers, cible.href).href; } catch { throw new Error('Redirection illisible.'); }
        cible = await verifier(suivante);
        continue;
      }

      const buffer = await lireCorps(res, maxBytes);
      // fetch ne renseigne res.url qu'en mode follow : on le pose nous-memes.
      Object.defineProperty(res, 'url', { value: cible.href, configurable: true });
      return { res, buffer };
    }
  } finally {
    clearTimeout(timer);
  }
}
