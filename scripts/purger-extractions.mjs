/**
 * Repasse les textes complets deja en base devant le controle de qualite.
 *
 * Readability rend parfois la page entiere au lieu de l'article : comparateur
 * de prix, liste de marchands, pied de page. Le controle est applique a la
 * volee depuis, mais les extractions plus anciennes sont restees telles quelles.
 *
 *   node scripts/purger-extractions.mjs           # liste, ne touche a rien
 *   node scripts/purger-extractions.mjs --purger  # efface les mauvaises
 *
 * Une extraction effacee n'est pas retentee : l'article garde le resume de son
 * flux et le lien vers l'original, ce qui est la bonne reponse pour ces pages.
 */
import { db } from '../server/db.js';
import { extractionDouteuse } from '../server/readable.js';
import { toPlainText } from '../server/html.js';

const RAISON = 'Page non exploitable : surtout de la mise en page, pas un article.';

const purger = process.argv.includes('--purger');

const articles = db.prepare(`
  SELECT id, title, full_content FROM articles
  WHERE full_content IS NOT NULL AND length(full_content) > 0
`).all();

const douteux = articles.filter((a) => extractionDouteuse(a.full_content, toPlainText(a.full_content)));

console.log(`${articles.length} extractions en base, ${douteux.length} douteuses.`);
for (const a of douteux) console.log('  ·', a.title.slice(0, 70));

if (!douteux.length) process.exit(0);
if (!purger) {
  console.log('\nRien n’a ete modifie. Relancer avec --purger pour effacer ces extractions.');
  process.exit(0);
}

const oublier = db.prepare(`
  UPDATE articles SET full_content = NULL, full_error = ?, full_fetched_at = ? WHERE id = ?
`);
const maintenant = Date.now();
const tout = db.transaction((liste) => {
  for (const a of liste) oublier.run(RAISON, maintenant, a.id);
});
tout(douteux);

console.log(`\n${douteux.length} extractions effacees. Les articles gardent leur resume et leur lien.`);
