// En-tetes de securite, poses sur chaque reponse.
//
// Le HTML des articles vient de l'exterieur et finit en innerHTML. Le
// nettoyeur (html.js) est la premiere ligne ; la CSP est la seconde : si un
// script passait un jour a travers, le navigateur refuserait de l'executer.

// Les seuls hotes qu'une <iframe> d'article peut charger : les lecteurs que
// html.js laisse passer. La liste vit ici en miroir de EMBED_HOSTS.
const CADRES = [
  'https://*.youtube.com', 'https://*.youtube-nocookie.com', 'https://youtu.be',
  'https://*.vimeo.com', 'https://*.dailymotion.com', 'https://*.soundcloud.com',
  'https://*.bandcamp.com', 'https://*.spotify.com', 'https://anchor.fm', 'https://archive.org'
];

const CSP = [
  "default-src 'self'",
  // Aucun script inline : l'amorce du theme est un fichier a part.
  "script-src 'self'",
  // Les cartes portent leurs teintes en attribut style : sans 'unsafe-inline'
  // sur les styles, toute la mise en page tombe. Ca n'ouvre pas de porte au
  // script — un style ne s'execute pas.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  // Les images passent toutes par le relais, sauf les petites images inline
  // que le nettoyeur tolere.
  "img-src 'self' data:",
  // Un podcast ou une video HTML5 se lit depuis son hebergeur.
  'media-src https: http:',
  'frame-src ' + CADRES.join(' '),
  "connect-src 'self'",
  // Le service worker vit ici, et n'est jamais charge d'ailleurs.
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join('; ');

export function entetes(req, res, next) {
  res.set('content-security-policy', CSP);
  res.set('x-content-type-options', 'nosniff');
  // L'adresse de Bublee ne regarde ni l'editeur qu'on ouvre ni le relais.
  res.set('referrer-policy', 'no-referrer');
  res.set('x-frame-options', 'SAMEORIGIN');
  res.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

export { CSP };
