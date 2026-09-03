// Rapatrie les trois familles de Bublee dans public/fonts, pour que l'app ne
// parle plus a Google et fonctionne hors ligne. Les trois sont sous licence
// OFL : les servir soi-meme est prevu par la licence.
//
//   node scripts/telecharger-polices.mjs
//
// Seuls les sous-ensembles latin et latin-ext sont gardes : Bublee est en
// francais, les alphabets cyrillique, grec et vietnamien ne servent a rien ici.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dossier = path.join(root, 'public', 'fonts');
fs.mkdirSync(dossier, { recursive: true });

const CSS2 = 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1'
  + '&family=Newsreader:ital,opsz,wght@0,6..72,300..700;1,6..72,300..600'
  + '&family=IBM+Plex+Mono:wght@400;500;600&display=swap';

// Un navigateur recent recoit du woff2 ; sans cet en-tete, Google sert du TTF.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const css = await (await fetch(CSS2, { headers: { 'user-agent': UA } })).text();

const blocs = css.match(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{[^}]*\}/g) || [];
if (!blocs.length) throw new Error('Aucun @font-face dans la reponse de Google Fonts.');

const gardes = [];
let n = 0;
for (const bloc of blocs) {
  const sousEnsemble = /\/\*\s*([\w-]+)\s*\*\//.exec(bloc)[1];
  if (sousEnsemble !== 'latin' && sousEnsemble !== 'latin-ext') continue;

  const famille = /font-family:\s*'([^']+)'/.exec(bloc)[1];
  const style = /font-style:\s*(\w+)/.exec(bloc)[1];
  const poids = /font-weight:\s*([\d ]+)/.exec(bloc)[1].trim().replace(' ', '-');
  const url = /url\(([^)]+)\)/.exec(bloc)[1];
  const nom = `${famille.toLowerCase().replace(/\s+/g, '-')}-${style}-${poids}-${sousEnsemble}.woff2`;

  const octets = Buffer.from(await (await fetch(url)).arrayBuffer());
  fs.writeFileSync(path.join(dossier, nom), octets);
  n++;

  gardes.push(bloc
    .replace(/\/\*\s*[\w-]+\s*\*\/\s*/, `/* ${famille} ${style} ${poids} ${sousEnsemble} */\n`)
    .replace(/url\([^)]+\)/, `url(/fonts/${nom})`));
}

fs.writeFileSync(path.join(dossier, 'polices.css'),
  '/* Genere par scripts/telecharger-polices.mjs — ne pas editer a la main. */\n\n' + gardes.join('\n\n') + '\n');

console.log(`${n} fichiers dans public/fonts, feuille polices.css ecrite.`);
