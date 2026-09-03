// Les couleurs d’attente, mesurées par le navigateur.
//
// Le serveur n’a pas de décodeur d’image : c’est la page qui mesure les deux
// teintes moyennes d’une illustration, une seule fois, puis les renvoie pour
// que tout le monde en profite ensuite.
import { api } from './api.js';
import { state, $$, articleParId } from './etat.js';


/* Le serveur n'a pas de decodeur d'image : c'est le navigateur qui mesure les
   couleurs, une seule fois, au premier affichage — puis les renvoie pour que
   tout le monde en profite ensuite. Les illustrations passent par /api/image,
   donc meme origine : le canevas n'est pas souille et reste lisible. */

const couleursDemandees = new Set();
let enCours = 0;
const FILE = [];

/** Moyenne du haut et du bas d'une image, reduite a 16 x 16. */
function mesurerCouleurs(img) {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 16, 16);
  const d = ctx.getImageData(0, 0, 16, 16).data;

  const moyenne = (debut, fin) => {
    let r = 0, v = 0, b = 0, n = 0;
    for (let i = debut; i < fin; i += 4) {
      if (d[i + 3] < 128) continue;              // on ignore le transparent
      r += d[i]; v += d[i + 1]; b += d[i + 2]; n++;
    }
    if (!n) return null;
    const deux = (x) => Math.round(x / n).toString(16).padStart(2, '0');
    return '#' + deux(r) + deux(v) + deux(b);
  };

  const moitie = 16 * 8 * 4;
  const haut = moyenne(0, moitie);
  const bas = moyenne(moitie, d.length);
  return haut && bas ? haut + ',' + bas : null;
}

function viderFile() {
  while (enCours < 2 && FILE.length) {
    const { id, img } = FILE.shift();
    enCours++;
    // Le calcul se fait quand le navigateur est libre : il ne doit jamais
    // disputer une image de plus au defilement.
    requestIdleCallback(() => {
      let couleurs = null;
      try { couleurs = mesurerCouleurs(img); } catch (e) { /* image inutilisable */ }
      const fini = () => { enCours--; viderFile(); };
      if (!couleurs) return fini();

      const local = state.articles.find((a) => a.id === id);
      if (local) local.image_color = couleurs;
      api.couleur(id, couleurs).catch(() => {}).finally(fini);
    }, { timeout: 3000 });
  }
}

/** Une image vient d'arriver : elle se montre, et livre ses couleurs si besoin. */
export function imageArrivee(img) {
  if (!img.classList.contains('fondu') || img.dataset.vue) return;
  img.dataset.vue = '1';
  img.classList.add('chargee');

  const id = Number(img.closest('.art')?.dataset.id ?? (img.closest('.reader-hero') ? state.openId : NaN));
  if (!Number.isFinite(id) || couleursDemandees.has(id)) return;

  const article = articleParId(id);
  if (article?.image_color) return;              // deja connues, rien a faire

  couleursDemandees.add(id);
  FILE.push({ id, img });
  viderFile();
}

/** Les images deja en cache n'emettent pas d'evenement : on les rattrape. */
export function rattraperImages(racine = document) {
  $$('img.fondu', racine).forEach((img) => {
    if (img.complete && img.naturalWidth) imageArrivee(img);
  });
}
