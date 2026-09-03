// Le service worker : ce qui permet de lire hors ligne, et de poser Bublee
// sur un écran d'accueil.
//
// Trois régimes, un par nature de ressource :
//
//   la coquille (HTML, JS, CSS, polices) — servie du cache, rafraîchie
//     derrière ; l'application démarre alors sans réseau ;
//   les articles déjà ouverts et les images du relais — gardés au passage,
//     rendus du cache quand le réseau manque ;
//   tout le reste de l'API — réseau seulement : un compteur périmé serait
//     pire qu'une erreur franche.
//
// Rien n'est mis en cache avant que la réponse ne soit là : on ne garde
// jamais une redirection vers la page de connexion à la place d'un article.

// À monter à chaque changement de l'habillage (app.js, glisse.js, styles.css,
// index.html…). Sans ça, le service worker continue de servir les anciens
// fichiers depuis son cache — un correctif poussé n'atteint pas le téléphone,
// ou seulement « un chargement en retard ». Changer ce numéro force la
// réinstallation : tout l'habillage est repris du réseau, les vieux caches effacés.
const VERSION = 'bublee-v5';
const COQUILLE = VERSION + '-coquille';
const LECTURE = VERSION + '-lecture';
const IMAGES = VERSION + '-images';

/** Ce qu'il faut pour que l'application s'ouvre sans réseau — la coquille
    entière, modules du découpage compris, sinon ils repartent au réseau. */
const SOCLE = [
  '/',
  '/index.html',
  '/styles.css',
  '/js/app.js',
  '/js/api.js',
  '/js/util.js',
  '/js/amorce.js',
  '/js/etat.js',
  '/js/cartes.js',
  '/js/couleurs.js',
  '/js/baladeur.js',
  '/js/glisse.js',
  '/fonts/polices.css',
  '/manifest.webmanifest'
];

/** Au-delà, on oublie les plus anciens : un téléphone n'est pas un disque. */
const MAX_LECTURE = 300;
const MAX_IMAGES = 400;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(COQUILLE);
    // Une police manquante ne doit pas faire échouer toute l'installation.
    await Promise.allSettled(SOCLE.map((u) => cache.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const noms = await caches.keys();
    await Promise.all(noms.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

/** Efface les plus anciennes entrées d'un cache au-delà de sa taille. */
async function borner(nom, maximum) {
  const cache = await caches.open(nom);
  const cles = await cache.keys();
  for (const cle of cles.slice(0, Math.max(0, cles.length - maximum))) await cache.delete(cle);
}

/** Du cache d'abord, le réseau en second plan : l'affichage ne l'attend pas. */
async function duCachePuisReseau(requete, nom) {
  const cache = await caches.open(nom);
  const gardee = await cache.match(requete);
  const reseau = fetch(requete).then((reponse) => {
    if (reponse.ok) cache.put(requete, reponse.clone());
    return reponse;
  }).catch(() => null);
  return gardee || (await reseau) || Response.error();
}

/** Le réseau d'abord ; le cache prend le relais quand il n'y a plus de réseau. */
async function duReseauPuisCache(requete, nom, maximum) {
  const cache = await caches.open(nom);
  try {
    const reponse = await fetch(requete);
    if (reponse.ok) {
      cache.put(requete, reponse.clone()).then(() => borner(nom, maximum));
    }
    return reponse;
  } catch (souci) {
    const gardee = await cache.match(requete);
    if (gardee) return gardee;
    throw souci;
  }
}

self.addEventListener('fetch', (e) => {
  const requete = e.request;
  if (requete.method !== 'GET') return;

  const url = new URL(requete.url);
  if (url.origin !== self.location.origin) return;

  // Les images du relais : une fois vues, elles restent lisibles hors ligne.
  if (url.pathname === '/api/image') {
    e.respondWith(duReseauPuisCache(requete, IMAGES, MAX_IMAGES));
    return;
  }

  // Un article déjà ouvert se relit dans le métro.
  if (/^\/api\/articles\/\d+$/.test(url.pathname)) {
    e.respondWith(duReseauPuisCache(requete, LECTURE, MAX_LECTURE));
    return;
  }

  // Le reste de l'API n'est jamais servi du cache : un compteur périmé
  // tromperait plus qu'une erreur franche.
  if (url.pathname.startsWith('/api/')) return;

  // Une adresse de vue est rendue par l'index : c'est lui qu'on garde.
  // La coquille est servie du cache d'emblée — l'app démarre sans attendre le
  // réseau —, et rafraîchie en arrière-plan pour le prochain lancement. C'est
  // le modèle « app shell » : sans lui, chaque ouverture patientait le temps
  // d'un aller-retour rien que pour la page, avant même que le JavaScript ne
  // commence.
  if (requete.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(COQUILLE);
      const gardee = await cache.match('/index.html');
      const reseau = fetch(requete).then((reponse) => {
        if (reponse.ok) cache.put('/index.html', reponse.clone());
        return reponse;
      }).catch(() => null);
      return gardee || (await reseau) || Response.error();
    })());
    return;
  }

  e.respondWith(duCachePuisReseau(requete, COQUILLE));
});
