// Limite les tentatives de connexion.
//
// scrypt reserve 64 Mo par verification : rien ne bornait le parallelisme,
// et deux cents requetes simultanees suffisaient a mettre le serveur a genoux
// — sans parler du mot de passe qu'on essaie de deviner. On compte donc les
// echecs par adresse IP et par courriel vise, en memoire : a l'echelle d'une
// poignee de comptes, une table en RAM suffit et disparait avec le processus.

const ECHECS_MAX = 5;
const FENETRE_MS = 60 * 1000;
const BLOCAGE_MS = 60 * 1000;

/** cle -> { echecs: [horodatages], jusqua: fin du blocage } */
const registre = new Map();

function entree(cle) {
  let e = registre.get(cle);
  if (!e) { e = { echecs: [], jusqua: 0 }; registre.set(cle, e); }
  return e;
}

/** Secondes restantes si la cle est bloquee, 0 sinon. */
export function bloque(cle, maintenant = Date.now()) {
  const e = registre.get(cle);
  if (!e) return 0;
  if (e.jusqua > maintenant) return Math.ceil((e.jusqua - maintenant) / 1000);
  return 0;
}

/** Un echec de plus ; au-dela du seuil dans la fenetre, la cle est bloquee. */
export function echec(cle, maintenant = Date.now()) {
  const e = entree(cle);
  e.echecs = e.echecs.filter((t) => maintenant - t < FENETRE_MS);
  e.echecs.push(maintenant);
  if (e.echecs.length >= ECHECS_MAX) {
    e.jusqua = maintenant + BLOCAGE_MS;
    e.echecs = [];
  }
}

/** Une reussite efface l'ardoise. */
export function reussite(cle) {
  registre.delete(cle);
}

/** Oublie ce qui est trop vieux pour compter, pour que la table ne grossisse pas. */
export function nettoyer(maintenant = Date.now()) {
  for (const [cle, e] of registre) {
    if (e.jusqua <= maintenant && !e.echecs.some((t) => maintenant - t < FENETRE_MS)) registre.delete(cle);
  }
}

/**
 * Le garde de la route de connexion. Il refuse en 429 avec Retry-After quand
 * l'adresse ou le courriel est bloque, et laisse la route enregistrer le
 * resultat par `req.limiteur.echec()` / `req.limiteur.reussite()`.
 */
export function gardeConnexion(req, res, next) {
  const courriel = String(req.body?.email || '').trim().toLowerCase();
  const cles = ['ip:' + req.ip, ...(courriel ? ['courriel:' + courriel] : [])];
  const attente = Math.max(...cles.map((c) => bloque(c)));
  if (attente > 0) {
    res.set('retry-after', String(attente));
    return res.status(429).json({ error: `Trop de tentatives. Réessaie dans ${attente} s.` });
  }
  req.limiteur = {
    echec: () => cles.forEach((c) => echec(c)),
    reussite: () => cles.forEach((c) => reussite(c))
  };
  next();
}

export const _pourLesTests = { ECHECS_MAX, BLOCAGE_MS, registre };
