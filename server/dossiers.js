// Les dossiers d'un compte.
//
// Un dossier n'etait qu'une chaine portee par chaque source : il existait tant
// qu'une source le portait, et pas un instant de plus. On ne pouvait donc ni
// en creer un d'avance, ni en garder un vide, ni le supprimer autrement qu'en
// reprenant ses sources une a une.
//
// Chaque compte tient maintenant sa liste. La source garde son dossier en
// clair — les adresses (#/dossier/Tech), l'OPML et les filtres n'ont pas
// bouge — et la liste en est le registre : tout nom porte par une source y
// figure, et un nom peut y figurer sans source. Un nouveau compte n'en a aucun.
import { db } from './db.js';
import { exigeCompte, now } from './garde.js';

const LONGUEUR_MAX = 80;

const introuvable = () => Object.assign(new Error('Dossier introuvable.'), { status: 404 });

/** Un nom de dossier tel qu'on le range : espaces resserres, longueur bornee. */
export function nomDeDossier(nom) {
  return String(nom ?? '').replace(/\s+/g, ' ').trim().slice(0, LONGUEUR_MAX);
}

/** Inscrit un dossier dans la liste du compte, s'il n'y est pas deja. */
export function retenirDossier(nom, compte) {
  const propre = nomDeDossier(nom);
  if (!propre) return;
  db.prepare('INSERT OR IGNORE INTO folders (user_id, name, created_at) VALUES (?, ?, ?)')
    .run(compte, propre, now());
}

/** Les dossiers du compte, vides compris, avec leur nombre de sources. */
export function listFolders(u) {
  return db.prepare(`
    SELECT d.name,
           (SELECT COUNT(*) FROM feeds f WHERE f.user_id = d.user_id AND f.folder = d.name) AS feeds
    FROM folders d
    WHERE d.user_id = ?
    ORDER BY d.name COLLATE NOCASE
  `).all(exigeCompte(u));
}

/** Cree un dossier vide. Le creer une seconde fois ne fait rien de plus. */
export function creerDossier(nom, u) {
  const compte = exigeCompte(u);
  const propre = nomDeDossier(nom);
  if (!propre) throw Object.assign(new Error('Nom de dossier vide.'), { status: 400 });
  retenirDossier(propre, compte);
  return listFolders(compte).find((d) => d.name === propre);
}

const existe = (nom, compte) =>
  Boolean(db.prepare('SELECT 1 FROM folders WHERE name = ? AND user_id = ?').get(nom, compte)
    || db.prepare('SELECT 1 FROM feeds WHERE folder = ? AND user_id = ? LIMIT 1').get(nom, compte));

/**
 * Supprime un dossier. Ses sources restent : elles en sortent, simplement.
 * Rien ne le fait revenir ensuite, puisque plus aucune source ne le porte.
 */
export function supprimerDossier(nom, u) {
  const compte = exigeCompte(u);
  const cible = String(nom ?? '');
  if (!cible || !existe(cible, compte)) throw introuvable();

  let sorties = 0;
  db.transaction(() => {
    sorties = db.prepare("UPDATE feeds SET folder = '' WHERE folder = ? AND user_id = ?").run(cible, compte).changes;
    db.prepare('DELETE FROM folders WHERE name = ? AND user_id = ?').run(cible, compte);
  })();
  return { sorties };
}

/**
 * Renomme un dossier, et ses sources avec lui. Vers un nom qui existe deja,
 * les deux fusionnent — la seule chose sensee a faire. Vers un nom vide, les
 * sources sortent du dossier et il disparait : c'est ce que faisait la route
 * avant la liste, et un script peut s'y fier.
 */
export function renommerDossier(ancien, nouveau, u) {
  const compte = exigeCompte(u);
  const source = String(ancien ?? '');
  if (!source || !existe(source, compte)) throw introuvable();

  const cible = nomDeDossier(nouveau);
  if (!cible) return supprimerDossier(source, compte).sorties;
  if (cible === source) return 0;

  let changees = 0;
  db.transaction(() => {
    changees = db.prepare('UPDATE feeds SET folder = ? WHERE folder = ? AND user_id = ?')
      .run(cible, source, compte).changes;
    db.prepare('DELETE FROM folders WHERE name = ? AND user_id = ?').run(source, compte);
    retenirDossier(cible, compte);
  })();
  return changees;
}
