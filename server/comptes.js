// Comptes, mots de passe, sessions et roles.
//
// Deux roles, pas trois : `super` administre les comptes en plus du sien,
// `editeur` n'a que le sien. Un role de lecture seule serait un troisieme cas
// a verifier partout pour un besoin qui n'existe pas ici.
//
// Les mots de passe sont derives avec scrypt, de la bibliotheque standard :
// bcrypt et argon2 demandent une compilation native, ce qui rendrait le
// deploiement du conteneur dependant d'une chaine de build.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db.js';

const scrypt = promisify(crypto.scrypt);

/* Parametres scrypt. N=2^15 tient sous ~100 ms, le bon ordre de grandeur pour
   une connexion humaine.

   `maxmem` doit etre releve : scrypt demande 128 * N * r octets, soit ici
   exactement les 32 Mo que Node autorise par defaut — et le calcul echoue pour
   quelques octets d'entete. On donne le double, ce qui laisse de la marge. */
const MAXMEM = 64 * 1024 * 1024;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: MAXMEM };
const LONGUEUR_CLE = 64;

export const ROLES = new Set(['super', 'editeur']);

/** Une session dure trente jours, et se prolonge a chaque visite. */
export const DUREE_SESSION = 30 * 24 * 60 * 60 * 1000;

const MIN_MOT_DE_PASSE = 10;

/* ------------------------------------------------------------ mots de passe */

export async function empreinte(motDePasse) {
  const sel = crypto.randomBytes(16);
  const cle = await scrypt(motDePasse.normalize('NFKC'), sel, LONGUEUR_CLE, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${sel.toString('base64')}$${cle.toString('base64')}`;
}

export async function verifierMotDePasse(motDePasse, stocke) {
  const bouts = String(stocke || '').split('$');
  if (bouts.length !== 6 || bouts[0] !== 'scrypt') return false;
  const [, N, r, p, sel, attendu] = bouts;

  const cle = await scrypt(String(motDePasse).normalize('NFKC'), Buffer.from(sel, 'base64'),
    LONGUEUR_CLE, { N: Number(N), r: Number(r), p: Number(p), maxmem: MAXMEM });
  const ref = Buffer.from(attendu, 'base64');
  // Longueurs egales avant timingSafeEqual, qui leve sinon.
  return cle.length === ref.length && crypto.timingSafeEqual(cle, ref);
}

/** Refuse ce qui ne protege rien, sans imposer de rituel de caracteres :
    la longueur est ce qui compte vraiment. */
export function motDePasseAcceptable(motDePasse) {
  const v = String(motDePasse ?? '');
  if (v.length < MIN_MOT_DE_PASSE) return `Le mot de passe doit faire au moins ${MIN_MOT_DE_PASSE} caractères.`;
  if (v.trim().length === 0) return 'Le mot de passe ne peut pas être vide.';
  return null;
}

/* ----------------------------------------------------------------- comptes */

const CHAMPS = 'id, email, nom, role, actif, created_at, last_seen_at';

export const listerComptes = () => db.prepare(`
  SELECT ${CHAMPS},
    (SELECT COUNT(*) FROM feeds f WHERE f.user_id = u.id) AS sources,
    (SELECT COUNT(*) FROM articles a JOIN feeds f ON f.id = a.feed_id WHERE f.user_id = u.id) AS articles
  FROM users u ORDER BY u.created_at
`).all();

export const compteParId = (id) => db.prepare(`SELECT ${CHAMPS} FROM users WHERE id = ?`).get(id);
export const compteParEmail = (email) =>
  db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());

export const nombreDeComptes = () => db.prepare('SELECT COUNT(*) n FROM users').get().n;

export async function creerCompte({ email, nom, motDePasse, role = 'editeur' }) {
  const adresse = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adresse)) {
    throw Object.assign(new Error('Adresse de courriel invalide.'), { status: 400 });
  }
  if (!ROLES.has(role)) throw Object.assign(new Error('Rôle inconnu : ' + role), { status: 400 });

  const souci = motDePasseAcceptable(motDePasse);
  if (souci) throw Object.assign(new Error(souci), { status: 400 });

  if (compteParEmail(adresse)) {
    throw Object.assign(new Error('Un compte existe déjà avec cette adresse.'), { status: 409 });
  }

  const id = db.prepare(
    'INSERT INTO users (email, nom, mot_de_passe, role, actif, created_at) VALUES (?, ?, ?, ?, 1, ?)'
  ).run(adresse, String(nom || '').trim() || adresse.split('@')[0], await empreinte(motDePasse), role, Date.now())
    .lastInsertRowid;

  return compteParId(Number(id));
}

export async function modifierCompte(id, patch, { parSuper = false } = {}) {
  const compte = compteParId(id);
  if (!compte) throw Object.assign(new Error('Compte introuvable.'), { status: 404 });

  const champs = [];
  const valeurs = [];

  if (patch.nom !== undefined) { champs.push('nom = ?'); valeurs.push(String(patch.nom).trim()); }

  if (patch.motDePasse !== undefined) {
    const souci = motDePasseAcceptable(patch.motDePasse);
    if (souci) throw Object.assign(new Error(souci), { status: 400 });
    champs.push('mot_de_passe = ?');
    valeurs.push(await empreinte(patch.motDePasse));
  }

  // Le role et l'activation ne se changent que par un super, et jamais sur
  // soi-meme : sinon le dernier administrateur peut se retirer ses propres
  // droits et plus personne ne peut administrer.
  if (patch.role !== undefined || patch.actif !== undefined) {
    if (!parSuper) throw Object.assign(new Error('Réservé à un super-utilisateur.'), { status: 403 });
    if (patch.role !== undefined) {
      if (!ROLES.has(patch.role)) throw Object.assign(new Error('Rôle inconnu : ' + patch.role), { status: 400 });
      if (compte.role === 'super' && patch.role !== 'super' && dernierSuper(id)) {
        throw Object.assign(new Error('C’est le dernier super-utilisateur : son rôle ne peut pas être retiré.'), { status: 409 });
      }
      champs.push('role = ?'); valeurs.push(patch.role);
    }
    if (patch.actif !== undefined) {
      const actif = patch.actif ? 1 : 0;
      if (!actif && compte.role === 'super' && dernierSuper(id)) {
        throw Object.assign(new Error('C’est le dernier super-utilisateur : il ne peut pas être suspendu.'), { status: 409 });
      }
      champs.push('actif = ?'); valeurs.push(actif);
      if (!actif) fermerToutesLesSessions(id);
    }
  }

  if (!champs.length) return compte;
  valeurs.push(id);
  db.prepare('UPDATE users SET ' + champs.join(', ') + ' WHERE id = ?').run(...valeurs);
  return compteParId(id);
}

/** Vrai s'il n'y a aucun autre super actif que celui-ci. */
function dernierSuper(id) {
  return db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'super' AND actif = 1 AND id <> ?").get(id).n === 0;
}

export function supprimerCompte(id) {
  const compte = compteParId(id);
  if (!compte) return false;
  if (compte.role === 'super' && dernierSuper(id)) {
    throw Object.assign(new Error('C’est le dernier super-utilisateur : il ne peut pas être supprimé.'), { status: 409 });
  }
  // Les flux, articles, etiquettes et reglages partent en cascade.
  return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
}

/* ---------------------------------------------------------------- sessions */

const NOM_COOKIE = 'bublee_session';

/** Le jeton n'est jamais stocke en clair : la base ne garde que son empreinte,
    pour qu'une copie de la base ne donne pas les sessions en cours. */
const empreinteJeton = (jeton) => crypto.createHash('sha256').update(jeton).digest('hex');

export function ouvrirSession(userId, { agent = '', ip = '' } = {}) {
  const jeton = crypto.randomBytes(32).toString('base64url');
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, agent, ip) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(empreinteJeton(jeton), userId, Date.now(), Date.now() + DUREE_SESSION,
    String(agent).slice(0, 200), String(ip).slice(0, 60));
  return jeton;
}

export function fermerSession(jeton) {
  if (!jeton) return false;
  return db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(empreinteJeton(jeton)).changes > 0;
}

export const fermerToutesLesSessions = (userId) =>
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;

/** Rend le compte d'une session valide, et prolonge celle-ci. */
export function compteDeSession(jeton) {
  if (!jeton) return null;
  const hash = empreinteJeton(jeton);
  const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash);
  if (!session) return null;

  if (session.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }

  const compte = compteParId(session.user_id);
  if (!compte || !compte.actif) return null;

  // Prolongee au plus une fois par heure : sinon chaque requete ecrit.
  if (session.expires_at - Date.now() < DUREE_SESSION - 3600_000) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() + DUREE_SESSION, hash);
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), compte.id);
  }
  return compte;
}

export const purgerSessionsExpirees = () =>
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()).changes;

export function listerSessions(userId) {
  return db.prepare(
    'SELECT created_at, expires_at, agent, ip FROM sessions WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId);
}

/* ------------------------------------------------------------- le cookie */

export function poserCookie(res, jeton, securise) {
  res.cookie(NOM_COOKIE, jeton, {
    httpOnly: true,                 // hors de portee du JavaScript de la page
    sameSite: 'lax',                // suffit contre le CSRF pour nos routes
    secure: securise,               // seulement en HTTPS, sinon le cookie ne partirait pas en local
    maxAge: DUREE_SESSION,
    path: '/'
  });
}

export const retirerCookie = (res) => res.clearCookie(NOM_COOKIE, { path: '/' });
export const jetonDuCookie = (req) => req.cookies?.[NOM_COOKIE] || null;
export { NOM_COOKIE };
