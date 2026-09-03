// Qui parle a l'API : session de navigateur, ou jeton personnel.
//
// Avant les comptes, ce module exemptait tout le reseau prive de jeton. C'etait
// tenable tant que Bublee tournait sur une machine de bureau ; ca ne l'est plus
// derriere un proxy, dont l'adresse est justement privee — tout l'internet
// arrivait alors comme un voisin de palier. L'exemption a donc disparu :
// l'identite vient de la session ou du jeton, jamais de l'adresse IP.
import crypto from 'node:crypto';
import { db, getSetting, setSetting } from './db.js';
import { compteDeSession, jetonDuCookie, compteParId } from './comptes.js';

/** Le jeton personnel d'un compte, cree a la demande. */
export function jeton(userId) {
  let valeur = getSetting('api_token', null, userId);
  if (!valeur) {
    valeur = crypto.randomBytes(24).toString('base64url');
    setSetting('api_token', valeur, userId);
  }
  return valeur;
}

export function regenererJeton(userId) {
  const valeur = crypto.randomBytes(24).toString('base64url');
  setSetting('api_token', valeur, userId);
  return valeur;
}

/* Le jeton ne voyage que dans un en-tete. En query string, il finissait dans
   les journaux, l'historique du navigateur et le Referer envoye aux editeurs. */
function jetonFourni(req) {
  const entete = req.get('authorization');
  if (entete && /^bearer\s+/i.test(entete)) return entete.replace(/^bearer\s+/i, '').trim();
  return req.get('x-bublee-token') || null;
}

/** Compare en temps constant, longueurs egalisees. */
function memeJeton(fourni, attendu) {
  if (!fourni || !attendu || fourni.length !== attendu.length) return false;
  return crypto.timingSafeEqual(Buffer.from(fourni), Buffer.from(attendu));
}

/**
 * Retrouve le compte d'un jeton personnel. Le jeton vit dans les reglages du
 * compte : on parcourt donc les comptes actifs plutot que d'indexer un secret.
 * A l'echelle d'une poignee de comptes, c'est sans consequence.
 */
export function compteDuJeton(fourni) {
  if (!fourni) return null;
  const lignes = db.prepare("SELECT user_id, value FROM settings WHERE key = 'api_token' AND user_id > 0").all();
  for (const ligne of lignes) {
    if (!memeJeton(fourni, ligne.value)) continue;
    const compte = compteParId(ligne.user_id);
    return compte?.actif ? compte : null;
  }
  return null;
}

/**
 * Pose `req.compte` quand la requete est authentifiee. Ne refuse rien ici :
 * chaque route decide si elle exige un compte, ce qui laisse passer la page de
 * connexion et la mise en route initiale.
 */
export function identifier(req, res, next) {
  // Une requete venue d'une autre origine n'a droit qu'au jeton : le cookie
  // n'y vaut rien, meme s'il est arrive (navigateur ancien, SameSite absent).
  // On compare l'hote, pas le schema : derriere un proxy TLS qui n'est pas
  // sur la boucle locale, le schema vu d'ici est http alors que l'origine
  // dit https, et ce n'est pas une attaque.
  const origine = req.get('origin');
  let memeOrigine = true;
  if (origine) {
    try { memeOrigine = new URL(origine).host === req.get('host'); } catch { memeOrigine = false; }
  }
  const parSession = memeOrigine ? compteDeSession(jetonDuCookie(req)) : null;
  if (parSession) {
    req.compte = parSession;
    req.viaSession = true;
    return next();
  }
  const compte = compteDuJeton(jetonFourni(req));
  if (compte) req.compte = compte;
  next();
}

/** Exige un compte. */
export function exigeCompte(req, res, next) {
  if (req.compte) return next();
  res.status(401).json({
    error: 'Authentification requise.',
    aide: 'Connecte-toi, ou ajoute l’en-tête « Authorization: Bearer <jeton> ».'
  });
}

/** Exige le role super. */
export function exigeSuper(req, res, next) {
  if (req.compte?.role === 'super') return next();
  res.status(403).json({ error: 'Réservé à un super-utilisateur.' });
}

/**
 * Les en-tetes CORS, et la reponse au preflight.
 *
 * Une page tierce peut appeler l'API avec un jeton — c'est prevu, c'est a ca
 * qu'il sert. Elle ne peut pas le faire avec le cookie : l'origine n'est
 * refletee que pour une requete qui porte un jeton (ou un preflight qui
 * annonce qu'elle en portera un), et jamais avec allow-credentials. Refleter
 * toute origine avec credentials ne tenait que par le SameSite du cookie,
 * c'est-a-dire par un seul fil.
 */
export function cors(req, res, next) {
  const origine = req.get('origin');
  const demandes = String(req.get('access-control-request-headers') || '').toLowerCase();
  const avecJeton = Boolean(jetonFourni(req)) || /authorization|x-bublee-token/.test(demandes);
  if (origine && avecJeton) {
    res.set('access-control-allow-origin', origine);
    res.set('vary', 'origin');
    res.set('access-control-allow-headers', 'content-type, authorization, x-bublee-token');
    res.set('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.set('access-control-max-age', '86400');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

/** Analyse l'en-tete Cookie. Une dizaine de lignes valent mieux qu'une
    dependance de plus pour ce seul besoin. */
export function cookies(req, res, next) {
  req.cookies = {};
  const brut = req.get('cookie');
  if (brut) {
    for (const morceau of brut.split(';')) {
      const i = morceau.indexOf('=');
      if (i < 1) continue;
      const cle = morceau.slice(0, i).trim();
      try { req.cookies[cle] = decodeURIComponent(morceau.slice(i + 1).trim()); } catch { /* valeur illisible */ }
    }
  }
  next();
}

export { memeJeton, compteParId };
