// Consigne les tickets de l'audit dans Jira, dans l'ordre des etapes.
//
//   node scripts/jira/consigner.mjs        (JIRA_EMAIL et JIRA_TOKEN dans .env ou l environnement)
//
// Variables :
//   JIRA_SITE     https://waavoo.atlassian.net (defaut)
//   JIRA_PROJECT  BUB (defaut)
//   JIRA_DRY=1    n'ecrit rien, affiche ce qui serait cree
//
// Le jeton se cree sur https://id.atlassian.com/manage-profile/security/api-tokens.
// Les cles Jira obtenues sont ecrites dans scripts/jira/cles.json, pour
// pouvoir les citer dans les commits et ne pas creer deux fois le meme ticket.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ici = path.dirname(fileURLToPath(import.meta.url));

// Le jeton peut aussi vivre dans un fichier .env a la racine (ignore par git) :
//   JIRA_EMAIL=...
//   JIRA_TOKEN=...
{
  const env = path.join(ici, '..', '..', '.env');
  if (fs.existsSync(env)) {
    for (const ligne of fs.readFileSync(env, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(ligne);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const SITE = (process.env.JIRA_SITE || 'https://waavoo.atlassian.net').replace(/\/$/, '');
const PROJET = process.env.JIRA_PROJECT || 'BUB';
const SEC = process.env.JIRA_DRY === '1';

const email = process.env.JIRA_EMAIL;
const jeton = process.env.JIRA_TOKEN;
if (!SEC && (!email || !jeton)) {
  console.error('JIRA_EMAIL et JIRA_TOKEN sont requis (ou JIRA_DRY=1 pour un essai a blanc).');
  process.exit(1);
}

const tickets = JSON.parse(fs.readFileSync(path.join(ici, 'tickets.json'), 'utf8'));
const fichierCles = path.join(ici, 'cles.json');
const cles = fs.existsSync(fichierCles) ? JSON.parse(fs.readFileSync(fichierCles, 'utf8')) : {};

const entetes = {
  authorization: 'Basic ' + Buffer.from(`${email}:${jeton}`).toString('base64'),
  accept: 'application/json',
  'content-type': 'application/json'
};

async function api(chemin, options = {}) {
  const res = await fetch(SITE + '/rest/api/3' + chemin, { ...options, headers: { ...entetes, ...(options.headers || {}) } });
  const texte = await res.text();
  let corps;
  try { corps = texte ? JSON.parse(texte) : null; } catch { corps = texte; }
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${chemin} → ${res.status} ${JSON.stringify(corps).slice(0, 400)}`);
  return corps;
}

/** Un paragraphe ADF par ligne du texte. */
const adf = (texte) => ({
  type: 'doc', version: 1,
  content: String(texte).split(/\n+/).filter(Boolean).map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] }))
});

const ETAPES = {
  1: 'Étape 1 — corriger et sécuriser le minimum',
  2: 'Étape 2 — sécurité et outillage',
  3: 'Étape 3 — performance, robustesse, adresse',
  4: 'Étape 4 — fonctionnalités et architecture'
};

/* Les types d'issue et les priorites portent des noms qui dependent de la
   langue du site : on lit ce que le projet propose et on rapproche. */
function rapprocher(voulu, disponibles, synonymes) {
  const noms = disponibles.map((d) => d.name);
  for (const candidat of [voulu, ...(synonymes[voulu] || [])]) {
    const hit = disponibles.find((d) => d.name.toLowerCase() === candidat.toLowerCase());
    if (hit) return hit;
  }
  throw new Error(`« ${voulu} » introuvable parmi : ${noms.join(', ')}`);
}

const SYNONYMES_TYPE = { Task: ['Tâche', 'Tache'], Bug: ['Bogue', 'Anomalie'], Story: ['Récit', 'Recit', 'Task', 'Tâche'] };
const SYNONYMES_PRIO = { Highest: ['Très élevée', 'Tres elevee', 'Highest'], High: ['Élevée', 'Elevee', 'High'], Medium: ['Moyenne', 'Medium'], Low: ['Faible', 'Basse', 'Low'] };

async function main() {
  let types = [], priorites = [];
  if (!SEC) {
    const meta = await api(`/issue/createmeta/${PROJET}/issuetypes`);
    types = meta.issueTypes || meta.values || [];
    priorites = await api('/priority');
  }

  let crees = 0;
  for (const t of tickets) {
    if (cles[t.cle]) { console.log(`  =  ${cles[t.cle].padEnd(8)} ${t.titre}  (déjà consigné)`); continue; }

    const champs = {
      project: { key: PROJET },
      summary: t.titre,
      description: adf(`${t.description}\n\n${ETAPES[t.etape]}. Référence : audit Bublee du 2 septembre 2026, identifiant « ${t.cle} ».`),
      labels: ['audit-2026-09', `etape-${t.etape}`]
    };
    if (SEC) { console.log(`  +  [${t.type}/${t.priorite}] ${t.titre}`); continue; }

    champs.issuetype = { id: rapprocher(t.type, types, SYNONYMES_TYPE).id };
    try { champs.priority = { id: rapprocher(t.priorite, priorites, SYNONYMES_PRIO).id }; } catch { /* projet sans priorite */ }

    let cree;
    try {
      cree = await api('/issue', { method: 'POST', body: JSON.stringify({ fields: champs }) });
    } catch (e) {
      // Un projet d'equipe refuse parfois labels ou priority : on retente nu.
      delete champs.labels; delete champs.priority;
      cree = await api('/issue', { method: 'POST', body: JSON.stringify({ fields: champs }) });
    }
    cles[t.cle] = cree.key;
    fs.writeFileSync(fichierCles, JSON.stringify(cles, null, 2));
    crees++;
    console.log(`  +  ${cree.key.padEnd(8)} ${t.titre}`);
  }
  console.log(`\n${crees} ticket(s) créé(s) dans ${PROJET}. Clés dans ${path.relative(process.cwd(), fichierCles)}.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
