// Acces a l'API depuis l'exterieur : jeton, portee reseau, CORS.
import crypto from 'node:crypto';
import { getSetting, setSetting } from './db.js';

/**
 * Niveaux d'ouverture (variable BUBLEE_AUTH) :
 *   lan    - defaut : la machine locale et le reseau prive passent sans jeton
 *   strict - seule la machine locale passe sans jeton
 *   off    - aucun controle (a reserver a un reseau de confiance)
 */
export const NIVEAU = (process.env.BUBLEE_AUTH || 'lan').toLowerCase();

const LOOPBACK = /^(::1|::ffff:127\.|127\.)/;
const RESEAU_PRIVE = /^(::ffff:)?(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|f[cd])/i;

/** Le jeton est genere une fois puis conserve ; BUBLEE_TOKEN a la priorite. */
export function jeton() {
  if (process.env.BUBLEE_TOKEN) return process.env.BUBLEE_TOKEN;
  let valeur = getSetting('api_token');
  if (!valeur) {
    valeur = crypto.randomBytes(24).toString('base64url');
    setSetting('api_token', valeur);
  }
  return valeur;
}

export function regenererJeton() {
  const valeur = crypto.randomBytes(24).toString('base64url');
  setSetting('api_token', valeur);
  return valeur;
}

function jetonFourni(req) {
  const entete = req.get('authorization');
  if (entete && /^bearer\s+/i.test(entete)) return entete.replace(/^bearer\s+/i, '').trim();
  return req.get('x-bublee-token') || (typeof req.query.token === 'string' ? req.query.token : null);
}

function memeJeton(fourni, attendu) {
  if (!fourni || fourni.length !== attendu.length) return false;
  return crypto.timingSafeEqual(Buffer.from(fourni), Buffer.from(attendu));
}

/** Autorise les requetes hors API et applique la regle ci-dessus aux routes /api. */
export function controleAcces(req, res, next) {
  // Le navigateur d'un autre appareil doit pouvoir appeler l'API : on annonce CORS.
  res.set('access-control-allow-origin', req.get('origin') || '*');
  res.set('access-control-allow-headers', 'content-type, authorization, x-bublee-token');
  res.set('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.set('access-control-max-age', '86400');
  res.set('vary', 'origin');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (NIVEAU === 'off') return next();

  const ip = req.ip || req.socket.remoteAddress || '';
  if (LOOPBACK.test(ip)) return next();
  if (NIVEAU === 'lan' && RESEAU_PRIVE.test(ip)) return next();

  if (memeJeton(jetonFourni(req), jeton())) return next();

  res.status(401).json({
    error: 'Jeton d’API manquant ou invalide.',
    aide: 'Ajoute l’en-tete « Authorization: Bearer <jeton> ». Le jeton s’affiche dans les réglages de Bublee.'
  });
}
