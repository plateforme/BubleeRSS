// Les fichiers de l'interface, servis depuis la memoire et compresses une
// seule fois.
//
// Ils partaient bruts, avec max-age=0 : cent-huit kilo-octets de JavaScript et
// soixante de CSS a chaque ouverture, revalides a chaque fois. Le dossier
// public tient en deux cents kilo-octets de texte — le garder decompresse et
// compresse en memoire coute moins qu'un aller-retour disque par requete.
//
// Le fichier reste la verite : sa date de modification est relue a chaque
// requete (c'est un appel systeme, pas une lecture), et le cache se refait
// des qu'elle bouge. « On edite un fichier, on recharge » tient toujours.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

/** Compresser une image ou une police ne gagne rien : elles le sont deja. */
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|manifest\+json)|image\/svg)/;

/** En deca, l'en-tete de compression coute plus que ce qu'elle economise. */
const SEUIL = 1024;

const cache = new Map();

function preparer(fichier, stat) {
  const brut = fs.readFileSync(fichier);
  const type = TYPES[path.extname(fichier).toLowerCase()] || 'application/octet-stream';
  const entree = {
    empreinte: stat.mtimeMs + ':' + stat.size,
    type,
    brut,
    etag: 'W/"' + crypto.createHash('sha1').update(brut).digest('base64url').slice(0, 22) + '"'
  };
  if (COMPRESSIBLE.test(type) && brut.length >= SEUIL) {
    // Qualite maximale : on ne compresse qu'une fois, autant bien le faire.
    entree.br = zlib.brotliCompressSync(brut, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: brut.length
      }
    });
    entree.gzip = zlib.gzipSync(brut, { level: 9 });
  }
  return entree;
}

/** Le contenu d'un fichier, prepare et garde tant qu'il n'a pas change. */
export function lire(fichier) {
  let stat;
  try {
    stat = fs.statSync(fichier);
    if (!stat.isFile()) return null;
  } catch { return null; }

  const connu = cache.get(fichier);
  if (connu && connu.empreinte === stat.mtimeMs + ':' + stat.size) return connu;

  const entree = preparer(fichier, stat);
  cache.set(fichier, entree);
  return entree;
}

/** Sert une entree preparee, en negociant la compression. */
export function servir(req, res, entree, cacheControl) {
  res.set('content-type', entree.type);
  res.set('cache-control', cacheControl);
  res.set('etag', entree.etag);
  res.set('vary', 'accept-encoding');

  // Rien n'a change depuis la derniere visite : on ne renvoie pas les octets.
  if (req.get('if-none-match') === entree.etag) return res.status(304).end();

  const accepte = String(req.get('accept-encoding') || '');
  let corps = entree.brut;
  if (entree.br && /\bbr\b/.test(accepte)) {
    res.set('content-encoding', 'br');
    corps = entree.br;
  } else if (entree.gzip && /\bgzip\b/.test(accepte)) {
    res.set('content-encoding', 'gzip');
    corps = entree.gzip;
  }
  res.set('content-length', String(corps.length));
  return req.method === 'HEAD' ? res.end() : res.end(corps);
}

/**
 * Le middleware. `racine` est le dossier public ; tout ce qui n'y correspond
 * pas passe au suivant, et c'est la route attrape-tout qui rendra l'index.
 */
export function fichiers(racine) {
  const polices = path.join(racine, 'fonts');

  return function statique(req, res, suite) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return suite();

    let relatif;
    try { relatif = decodeURIComponent(req.path); } catch { return suite(); }
    if (relatif === '/') relatif = '/index.html';

    // On resout, puis on verifie qu'on est bien reste dans le dossier : une
    // adresse peut toujours contenir « .. », meme apres normalisation.
    const fichier = path.resolve(racine, '.' + relatif);
    if (fichier !== racine && !fichier.startsWith(racine + path.sep)) return suite();

    const entree = lire(fichier);
    if (!entree) return suite();

    // Les polices ne changent jamais sans changer de nom : un an, sans
    // revalidation. Le reste garde son ETag, pour qu'une modification se voie
    // au rechargement suivant.
    const duree = fichier.startsWith(polices + path.sep)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    // Le service worker doit pouvoir prendre toute l'origine sous son aile,
    // et jamais etre servi d'un cache : c'est lui qui gere les autres.
    if (relatif === '/sw.js') {
      res.set('service-worker-allowed', '/');
      res.set('cache-control', 'no-cache');
    }
    return servir(req, res, entree, duree);
  };
}
