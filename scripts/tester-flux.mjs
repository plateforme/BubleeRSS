// Outil d'atelier : verifie une liste de flux avant de l'ajouter a la bibliotheque.
//   node scripts/tester-flux.mjs candidats.json
// Le fichier attendu : [{ "folder": "...", "title": "...", "url": "..." }, ...]
import fs from 'node:fs';
import { fetchFeed } from '../server/feed.js';

const candidats = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const resultats = [];
let curseur = 0;

async function worker() {
  while (curseur < candidats.length) {
    const c = candidats[curseur++];
    try {
      const { parsed } = await fetchFeed(c.url);
      const items = parsed?.items || [];
      const dernier = items.length ? Math.max(...items.map((i) => i.published_at)) : 0;
      resultats.push({
        ...c,
        ok: items.length > 0,
        titre: parsed?.title || '',
        items: items.length,
        jours: dernier ? Math.round((Date.now() - dernier) / 86400000) : null,
        images: items.filter((i) => i.image).length,
        mots: items.length ? Math.round(items.reduce((s, i) => s + i.word_count, 0) / items.length) : 0
      });
    } catch (error) {
      resultats.push({ ...c, ok: false, erreur: String(error.message).slice(0, 60) });
    }
  }
}

await Promise.all(Array.from({ length: 8 }, worker));

resultats.sort((a, b) => (a.folder || '').localeCompare(b.folder) || (a.title || '').localeCompare(b.title));

let dossier = null;
for (const r of resultats) {
  if (r.folder !== dossier) { dossier = r.folder; console.log('\n### ' + dossier); }
  if (!r.ok) {
    console.log('  KO   ' + String(r.title).slice(0, 30).padEnd(30) + ' | ' + (r.erreur || 'aucun article'));
    continue;
  }
  console.log(
    '  ok   ' + String(r.title).slice(0, 30).padEnd(30) +
    ' | ' + String(r.items).padStart(3) + ' art' +
    ' | ' + String(r.jours + 'j').padStart(6) +
    ' | ' + String(r.images + ' img').padStart(7) +
    ' | ' + String(r.mots + ' mots').padStart(10) +
    ' | ' + String(r.titre).slice(0, 34)
  );
}

fs.writeFileSync(
  process.argv[3] || 'candidats-valides.json',
  JSON.stringify(resultats.filter((r) => r.ok), null, 2)
);
console.log('\n' + resultats.filter((r) => r.ok).length + ' / ' + resultats.length + ' flux valides.');
