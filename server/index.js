// Le point d'entree : ecoute, ouvre le navigateur, lance les taches de fond,
// et s'arrete proprement. Les routes vivent dans app.js.
import { spawn } from 'node:child_process';

import * as store from './store.js';
import { db, migrationApplied, orphelinsEnAttente } from './db.js';
import * as comptes from './comptes.js';
import { app, scheduleRefresh, stopRefresh } from './app.js';

const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';

function openBrowser(url) {
  if (process.env.BUBLEE_NO_OPEN) return;
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* tant pis */ }
}

const serveur = app.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`\n  Bublee    →  ${url}`);
  console.log(`  API       →  ${url}/api`);
  const installe = comptes.nombreDeComptes() > 0;
  console.log(installe
    ? `  comptes   →  ${comptes.nombreDeComptes()}`
    : '  installation →  aucun compte : la page de connexion proposera d’en créer un.');
  const restes = orphelinsEnAttente();
  if (restes) console.log(`  ${restes} source(s) sans propriétaire : le premier compte créé les reprendra.`);
  console.log('');

  // Base existante : on rattache les doublons deja stockes, compte par compte —
  // la deduplication ne traverse pas les comptes.
  if (migrationApplied) {
    let lies = 0;
    for (const c of comptes.listerComptes()) lies += store.dedupeExistants(c.id);
    if (lies) console.log(`[bublee] ${lies} doublon(s) rattaché(s) dans la base existante.`);
  }

  comptes.purgerSessionsExpirees();
  scheduleRefresh();
  openBrowser(url);
  // Un rafraichissement au demarrage, en tache de fond. La recherche
  // d'illustrations manquantes se fait ensuite pour chaque compte.
  setTimeout(() => store.refreshAll().then(async () => {
    for (const c of comptes.listerComptes()) await store.completerImages({}, c.id).catch(() => {});
  }).catch(() => {}), 2000);
});

/* Arret propre : on cesse d'accepter des connexions, on laisse les reponses
   en cours finir, puis on ferme la base — avec un PRAGMA optimize, qui
   rafraichit les statistiques du planificateur pour le prochain demarrage.
   Sans ca, un SIGTERM de Docker coupait net au milieu d'une ecriture WAL. */
let arretEnCours = false;
function arreter(signal) {
  if (arretEnCours) return;
  arretEnCours = true;
  console.log(`\n[bublee] ${signal} : arrêt en cours…`);
  stopRefresh();
  const fin = setTimeout(() => process.exit(0), 5000).unref();
  serveur.close(() => {
    clearTimeout(fin);
    try { db.pragma('optimize'); db.close(); } catch { /* deja fermee */ }
    process.exit(0);
  });
}
process.on('SIGINT', () => arreter('SIGINT'));
process.on('SIGTERM', () => arreter('SIGTERM'));
