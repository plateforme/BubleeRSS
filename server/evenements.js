// Ce que le serveur a a dire pendant qu'on lit.
//
// Le rafraichissement automatique arrivait en silence : les compteurs de
// l'index restaient ceux du chargement de la page, et rien ne signalait que
// quatorze articles venaient d'entrer. L'import OPML, lui, faisait attendre
// huit secondes au hasard avant de recharger.
//
// Un flux d'evenements (Server-Sent Events) regle les deux. Il va dans un seul
// sens — du serveur vers la page —, se reconnecte tout seul, et tient sur une
// connexion HTTP ordinaire : pas de protocole de plus a servir ni a proteger.
//
// Chaque abonne est rattache a son compte : personne ne recoit les compteurs
// d'un autre.

/** userId -> Set des reponses ouvertes. */
const abonnes = new Map();

/** Un commentaire toutes les vingt-cinq secondes : les mandataires coupent
    volontiers une connexion muette au bout de trente. */
const BATTEMENT_MS = 25000;

export function abonner(req, res) {
  const compte = req.compte.id;

  res.set({
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Nginx met en tampon par defaut, ce qui retiendrait chaque evenement.
    'x-accel-buffering': 'no'
  });
  res.flushHeaders?.();
  // Le premier octet ouvre vraiment la connexion cote navigateur.
  res.write(': bienvenue\n\n');

  if (!abonnes.has(compte)) abonnes.set(compte, new Set());
  abonnes.get(compte).add(res);

  const battement = setInterval(() => {
    try { res.write(': .\n\n'); } catch { fermer(); }
  }, BATTEMENT_MS);
  battement.unref?.();

  const fermer = () => {
    clearInterval(battement);
    const siens = abonnes.get(compte);
    siens?.delete(res);
    if (siens && !siens.size) abonnes.delete(compte);
  };

  req.on('close', fermer);
  res.on('error', fermer);
}

/** Envoie un evenement a toutes les pages ouvertes d'un compte. */
export function annoncer(userId, type, donnees) {
  const siens = abonnes.get(userId);
  if (!siens?.size) return 0;
  const charge = `event: ${type}\ndata: ${JSON.stringify(donnees)}\n\n`;
  let partis = 0;
  for (const res of [...siens]) {
    try { res.write(charge); partis++; } catch { siens.delete(res); }
  }
  return partis;
}

/** Combien de pages ecoutent, pour /api/health. */
export const nombreAbonnes = () =>
  [...abonnes.values()].reduce((n, s) => n + s.size, 0);

/** Ferme tout : l'arret du serveur ne doit pas attendre des connexions
    qui, par nature, ne se terminent jamais d'elles-memes. */
export function toutFermer() {
  for (const siens of abonnes.values()) {
    for (const res of siens) { try { res.end(); } catch { /* deja partie */ } }
  }
  abonnes.clear();
}
