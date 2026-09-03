// Le test de fumée : on lance Bublee et on s'en sert.
//
//   npm run fumee
//
// Les tests de `npm test` vérifient les pièces ; celui-ci vérifie qu'elles
// tiennent ensemble — que la porte s'ouvre, que la une se compose, qu'un
// article s'ouvre, s'étiquette et se retrouve. C'est le seul endroit où le
// JavaScript du navigateur est réellement exécuté.
//
// Il ne dépend d'aucun réseau : la bibliothèque est semée directement en base,
// avec des articles fabriqués. Playwright est une dépendance de développement
// facultative ; sans lui, ce fichier le dit et s'arrête sans échouer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const racine = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('Playwright n’est pas installé : « npm i -D playwright && npx playwright install chromium ».');
  process.exit(0);
}

/* ------------------------------------------------------- la bibliothèque */

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'bublee-fumee-'));
process.env.BUBLEE_DATA = dossier;

const { db } = await import('../server/db.js');
const store = await import('../server/store.js');
const comptes = await import('../server/comptes.js');

const IDENTIFIANTS = { email: 'fumee@bublee.test', motDePasse: 'un-mot-de-passe-long' };
const moi = await comptes.creerCompte({ ...IDENTIFIANTS, nom: 'Fumée', role: 'super' });

const SOURCES = [
  ['Le Quotidien', 'Actualité'], ['La Revue', 'Actualité'],
  ['Chronique du soir', 'Idées'], ['Le Carnet', 'Idées'], ['Dépêches', '']
];
const MOTS = ['élection', 'climat', 'québec', 'musique', 'archives', 'sardine'];

let n = 0;
for (const [titre, dossierSource] of SOURCES) {
  const flux = Number(db.prepare(
    'INSERT INTO feeds (url, title, folder, created_at, user_id) VALUES (?, ?, ?, ?, ?)'
  ).run(`https://${encodeURIComponent(titre)}.test/rss`, titre, dossierSource, Date.now(), moi.id).lastInsertRowid);

  const lot = [];
  for (let i = 0; i < 9; i++) {
    n++;
    lot.push({
      guid: 'g' + n,
      url: `https://exemple.test/article-${n}`,
      title: `${MOTS[n % MOTS.length]} : un titre d’article assez long pour tenir sur deux lignes, numéro ${n}`,
      author: 'Une signature',
      summary: `Un chapô qui parle de ${MOTS[n % MOTS.length]} et annonce ce que l’article raconte ensuite.`,
      content: `<p>Le corps de l’article numéro ${n}, où il est question de ${MOTS[n % MOTS.length]}.</p>`
        + '<p>' + 'Une phrase de plus pour donner du texte à lire. '.repeat(30) + '</p>',
      // Une image sur trois : de quoi que la mise en page « une » remonte un
      // article illustré en tête et réordonne les autres — le cas où le lecteur
      // doit suivre l'écran et non les données.
      image: n % 3 === 0 ? `https://exemple.test/img-${n}.jpg` : null,
      published_at: Date.now() - n * 3600_000,
      duration: null,
      word_count: 300
    });
  }
  store.saveItems(flux, lot, moi.id);
}
console.log(`bibliothèque semée : ${SOURCES.length} sources, ${n} articles`);

/* ------------------------------------------------------------ le serveur */

const PORT = 4700 + (process.pid % 90);
const serveur = spawn(process.execPath, [path.join(racine, 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BUBLEE_NO_OPEN: '1', BUBLEE_DATA: dossier },
  stdio: ['ignore', 'pipe', 'pipe']
});
const journal = [];
serveur.stdout.on('data', (d) => journal.push(String(d)));
serveur.stderr.on('data', (d) => journal.push('ERR ' + d));

const BASE = `http://127.0.0.1:${PORT}`;
for (let essai = 0; ; essai++) {
  try { if ((await fetch(BASE + '/api/ping')).ok) break; } catch { /* pas encore là */ }
  if (essai > 60) throw new Error('le serveur ne répond pas :\n' + journal.join(''));
  await new Promise((r) => setTimeout(r, 250));
}

/* --------------------------------------------------------- les épreuves */

const epreuves = [];
const verifier = async (nom, faire) => {
  try { await faire(); epreuves.push(['ok', nom]); }
  catch (e) { epreuves.push(['NON', nom + ' — ' + e.message.split('\n')[0]]); }
};
const doitEtre = (reel, attendu, quoi) => {
  if (reel !== attendu) throw new Error(`${quoi} : ${JSON.stringify(reel)} au lieu de ${JSON.stringify(attendu)}`);
};

const nav = await chromium.launch();
const page = await (await nav.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const erreurs = [];
page.on('pageerror', (e) => erreurs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') erreurs.push('console : ' + m.text()); });

await verifier('la porte s’ouvre et laisse entrer', async () => {
  await page.goto(BASE);
  await page.waitForSelector('#porte:not([hidden])');
  await page.fill('#porteEmail', IDENTIFIANTS.email);
  await page.fill('#portePass', IDENTIFIANTS.motDePasse);
  await page.click('#porteBouton');
  await page.waitForSelector('.art', { timeout: 20000 });
});

await verifier('l’index liste les sources et leurs dossiers', async () => {
  doitEtre(await page.$$eval('.feed-row', (l) => l.length), SOURCES.length, 'sources');
  doitEtre(await page.$$eval('.folder', (l) => l.length), 2, 'dossiers');
});

await verifier('la une se compose, en articles et non en boutons', async () => {
  const cartes = await page.$$eval('.art', (l) => l.length);
  if (cartes < 5) throw new Error(`seulement ${cartes} cartes`);
  doitEtre(await page.$$eval('button.art', (l) => l.length), 0, 'cartes restées boutons');
  doitEtre(await page.$$eval('button h2, button h3, button p', (l) => l.length), 0, 'titres dans un bouton');
});

await verifier('les trois mises en page se composent', async () => {
  for (const [onglet, classe] of [['list', 'l-sommaire'], ['compact', 'l-depeches'], ['magazine', 'l-une']]) {
    await page.click(`.tab[data-layout="${onglet}"]`);
    await page.waitForTimeout(400);
    doitEtre(await page.$eval('#flux', (n2) => n2.className.includes('l-')), true, 'classe de mise en page');
    if (!(await page.$eval('#flux', (n2) => n2.className)).includes(classe)) throw new Error(onglet + ' non appliquée');
    if (!await page.$('.art')) throw new Error(onglet + ' ne rend rien');
  }
});

await verifier('un article s’ouvre, et se marque lu', async () => {
  const avant = Number((await page.$eval('#countUnread', (t) => t.textContent)).replace(/\D/g, ''));
  await page.click('a.art-lien');
  await page.waitForSelector('#reader:not([hidden]) .reader-titre', { timeout: 15000 });
  await page.waitForTimeout(1200);
  const apres = Number((await page.$eval('#countUnread', (t) => t.textContent)).replace(/\D/g, ''));
  if (apres !== avant - 1) throw new Error(`compteur ${avant} → ${apres}`);
});

await verifier('l’article s’étiquette depuis le lecteur', async () => {
  await page.click('#readerTagBtn');
  await page.waitForSelector('#tagPop:not([hidden])');
  await page.fill('#tagPopInput', 'à relire');
  await page.press('#tagPopInput', 'Enter');
  await page.waitForTimeout(1200);
  doitEtre(await page.$$eval('.tag-chip', (l) => l.length), 1, 'étiquettes posées');
  doitEtre(await page.$$eval('#tagList .tag-row', (l) => l.length), 1, 'étiquettes dans l’index');
});

await verifier('Échap ferme d’abord le popover, puis le lecteur', async () => {
  // Deux couches ouvertes, deux Échap : la plus haute d'abord. C'est la règle
  // qu'on attend d'une pile de fenêtres, et elle se vérifie ici.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  doitEtre(await page.$eval('#tagPop', (p2) => p2.hidden), true, 'popover fermé');
  doitEtre(await page.$eval('#reader', (r) => r.hidden), false, 'lecteur encore ouvert');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  doitEtre(await page.$eval('#reader', (r) => r.hidden), true, 'lecteur fermé');
});

await verifier('la recherche trouve, et met le mot en évidence', async () => {
  await page.fill('#search', 'sardine');
  await page.waitForTimeout(1400);
  if (!(await page.evaluate(() => location.hash)).includes('recherche')) throw new Error('adresse non mise à jour');
  const trouves = await page.$$eval('.art', (l) => l.length);
  if (!trouves) throw new Error('aucun résultat');
  if (!await page.$('mark')) throw new Error('le mot cherché n’est pas mis en évidence');
});

await verifier('l’édition du jour se compose et s’annonce', async () => {
  await page.fill('#search', '');
  await page.waitForTimeout(1000);
  await page.click('.view-row[data-view="edition"]');
  await page.waitForTimeout(1400);
  doitEtre(await page.$eval('#stageTitle', (t) => t.textContent.trim()), 'L’édition du jour', 'titre');
  if (!/\d+ articles? · \d+ min/.test(await page.$eval('#stageSub', (t) => t.textContent))) {
    throw new Error('le sous-titre n’annonce pas la durée : ' + await page.$eval('#stageSub', (t) => t.textContent));
  }
});

await verifier('en magazine, le lecteur suit l’ordre affiché, pas celui des données', async () => {
  // Le lecteur avance vers la carte suivante à l'écran, pas vers celle que
  // l'ordre des données donnerait : en « une », la mise en page remonte un
  // article illustré et réordonne le reste. Depuis une une posée tard dans les
  // données, on butait après deux ou trois articles — c'est ce qu'on garde.
  await page.click('.view-row[data-view="all"]');
  await page.waitForTimeout(700);
  await page.click('.tab[data-layout="magazine"]');
  await page.waitForTimeout(500);
  const ordre = await page.$$eval('#flux .art[data-id]', (els) => els.slice(0, 6).map((e) => Number(e.dataset.id)));
  if (ordre.length < 6) throw new Error(`pas assez de cartes (${ordre.length})`);
  // On part de la une (1re carte affichée) et on avance : chaque pas doit tomber
  // sur la carte suivante de l'écran, dans l'ordre exact où elles sont posées.
  // La carte entière est cliquable ; la « une » n'a pas de lien de titre, on
  // clique donc le conteneur, en JS (l'image le recouvre pour Playwright).
  await page.$eval(`#flux .art[data-id="${ordre[0]}"]`, (el) => el.click());
  await page.waitForSelector('#reader:not([hidden]) .reader-titre', { timeout: 15000 });
  const idOuvert = () => page.evaluate(() => Number((location.hash.match(/(\d+)(?!.*\d)/) || [])[1]));
  for (let k = 1; k < ordre.length; k++) {
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(400);
    doitEtre(await idOuvert(), ordre[k], `${k + 1}e article = ${k + 1}e carte affichée`);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
});

await verifier('les réglages s’ouvrent, piègent le focus, et le rendent', async () => {
  await page.focus('#openSettings');
  await page.click('#openSettings');
  await page.waitForTimeout(900);
  doitEtre(await page.$eval('#settingsModal', (d) => d.tagName), 'DIALOG', 'balise');
  doitEtre(await page.evaluate(() => document.querySelector('#settingsModal').contains(document.activeElement)), true, 'focus dedans');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  doitEtre(await page.evaluate(() => document.activeElement?.id), 'openSettings', 'focus rendu');
});

await verifier('une règle écarte ce qu’on ne veut plus voir', async () => {
  await page.click('#openSettings');
  await page.waitForTimeout(800);
  await page.fill('#regleMotif', 'sardine');
  await page.click('#regleForm button[type="submit"]');
  await page.waitForTimeout(1800);
  const regles = await page.$$eval('.regle', (l) => l.length);
  doitEtre(regles, 1, 'règles posées');
  const pris = await page.$eval('.regle-compte', (t) => t.textContent);
  if (!/\d/.test(pris)) throw new Error('la règle n’a rien attrapé : ' + pris);
  await page.keyboard.press('Escape');
});

await verifier('le clavier pilote la liste', async () => {
  await page.waitForTimeout(600);
  await page.click('.view-row[data-view="all"]');
  await page.waitForTimeout(1200);
  await page.keyboard.press('j');
  await page.waitForTimeout(300);
  doitEtre(await page.$$eval('.art.cursor', (l) => l.length), 1, 'curseur clavier');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#reader:not([hidden]) .reader-titre', { timeout: 10000 });
  await page.keyboard.press('Escape');
});

await verifier('fermer le lecteur vide le panneau, et coupe donc la vidéo', async () => {
  // Masquer ne suffit pas : une iframe de lecture ou une <video> continueraient
  // de jouer derrière le panneau caché, sans commande pour les arrêter. On
  // vérifie que la fermeture retire vraiment le contenu.
  await page.$eval('#flux .art[data-id]', (el) => el.click());
  await page.waitForSelector('#reader:not([hidden]) .reader-titre', { timeout: 15000 });
  await page.waitForTimeout(400);
  if (!(await page.$eval('#readerScroll', (n2) => n2.childElementCount))) throw new Error('le lecteur est vide alors qu’il devrait porter l’article');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  doitEtre(await page.$eval('#readerScroll', (n2) => n2.childElementCount), 0, 'contenu resté vivant après fermeture');
});

await verifier('le glissé survit à un article qui déborde en largeur', async () => {
  // Déclarer le seul overflow-y fait calculer l'autre axe en « auto » : le
  // panneau passait alors pour une zone à défilement horizontal dès qu'un
  // article dépassait de deux pixels, et le glissé — qui cède la priorité à ces
  // zones-là — mourait sur cet article, dans les deux sens. On le rejoue au
  // doigt, avec un débord fabriqué.
  const tactile = await nav.newContext({ viewport: { width: 400, height: 820 }, isMobile: true, hasTouch: true });
  try {
    const p = await tactile.newPage();
    const cdp = await tactile.newCDPSession(p);
    await p.goto(BASE);
    await p.waitForSelector('#porte:not([hidden])');
    await p.fill('#porteEmail', IDENTIFIANTS.email);
    await p.fill('#portePass', IDENTIFIANTS.motDePasse);
    await p.click('#porteBouton');
    await p.waitForSelector('.art', { timeout: 20000 });
    await p.$eval('#flux .art[data-id]', (el) => el.click());
    await p.waitForSelector('#reader:not([hidden]) .reader-titre', { timeout: 15000 });
    await p.waitForTimeout(500);

    doitEtre(await p.evaluate(() => getComputedStyle(document.getElementById('readerScroll')).overflowX),
      'hidden', 'overflow-x du panneau de lecture');

    await p.evaluate(() => {
      const large = document.createElement('div');
      large.style.cssText = 'width:3000px;height:8px';
      document.querySelector('.reader-body').appendChild(large);
    });
    const avant = await p.$eval('#reader .reader-titre', (n) => n.textContent.trim());
    const doigt = (x) => [{ x, y: 520, radiusX: 12, radiusY: 12, force: 1, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: doigt(350) });
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: doigt(350 - (310 * i) / 12) });
      await new Promise((r) => setTimeout(r, 16));
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p.waitForTimeout(900);
    if (await p.$eval('#reader .reader-titre', (n) => n.textContent.trim()) === avant) {
      throw new Error('le glissé est resté mort sur un article large');
    }
  } finally {
    await tactile.close();
  }
});

await page.screenshot({ path: path.join(dossier, 'fumee.png'), fullPage: false });
await nav.close();
serveur.kill();

/* --------------------------------------------------------------- verdict */

console.log('');
for (const [etat, nom] of epreuves) console.log(`  ${etat === 'ok' ? 'ok  ' : 'NON '} ${nom}`);
if (erreurs.length) {
  console.log('\nerreurs du navigateur :');
  for (const e of [...new Set(erreurs)].slice(0, 8)) console.log('  ·', e);
}

const rates = epreuves.filter(([e]) => e !== 'ok').length;
console.log(`\n${epreuves.length - rates} / ${epreuves.length} épreuves passées.`);
if (rates || erreurs.length) process.exit(1);
