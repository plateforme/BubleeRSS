// Reduire une illustration a la taille ou elle sera vue.
//
// Une tuile de 150 x 104 recevait l'original : deux megaoctets pour occuper la
// surface d'un timbre. Sur un telephone en 4G, une page de la une pouvait
// peser vingt megaoctets d'images dont on n'affichait qu'un centieme.
//
// Le redimensionnement demande un decodeur d'image, donc une dependance
// native. Elle est donc *optionnelle* : si `sharp` s'installe, les vignettes
// sont reduites ; s'il ne s'installe pas — un NAS exotique, une architecture
// sans binaire precompile —, l'original est servi comme avant. Bublee doit
// s'installer partout, et une image un peu lourde vaut mieux qu'un serveur
// qui refuse de demarrer.

/** Trois tailles, pas davantage : chacune coute une entree de cache par
    image, et l'ecart entre 380 et 420 pixels ne se voit pas. */
export const TAILLES = [160, 400, 900];

let sharp = null;
let cherche = false;

/** Charge `sharp` une seule fois, et retient son absence. */
async function decodeur() {
  if (cherche) return sharp;
  cherche = true;
  try {
    sharp = (await import('sharp')).default;
    // Le cache interne de libvips ne sert a rien ici : chaque image ne passe
    // qu'une fois, et il retiendrait des megaoctets pour rien.
    sharp.cache(false);
    sharp.concurrency(2);
  } catch {
    sharp = null;
    console.log('[bublee] sharp absent : les illustrations sont servies telles quelles.');
  }
  return sharp;
}

/** La taille retenue pour une largeur demandee, ou null si elle ne dit rien. */
export function tailleVoulue(demande) {
  const n = Number(demande);
  if (!Number.isFinite(n) || n <= 0) return null;
  return TAILLES.find((t) => t >= n) || null;   // au-dela de la plus grande, on sert l'original
}

/**
 * Reduit `corps` a `largeur` pixels. Rend `null` quand il n'y a rien a gagner
 * — pas de decodeur, image deja plus petite, format anime, echec de decodage.
 * L'appelant sert alors l'original, ce qui est toujours correct.
 */
export async function reduire(corps, type, largeur) {
  if (!largeur) return null;
  // Un SVG n'a pas de taille a reduire : c'est deja du dessin.
  if (/^image\/svg/i.test(type)) return null;

  const outil = await decodeur();
  if (!outil) return null;

  /* Un GIF anime doit le rester : le webp anime existe pour ca, et c'est la
     ou le gain est le plus gros — les GIF d'illustration pesent volontiers
     plusieurs megaoctets pour occuper la surface d'une carte. */
  const anime = /^image\/gif/i.test(type);

  try {
    const image = outil(corps, { failOn: 'error', animated: anime });
    const { width } = await image.metadata();
    // Deja plus petite que ce qu'on demande : la reduire l'abimerait sans
    // rien economiser.
    if (!width || width <= largeur) return null;

    const reduit = await image
      .rotate()                                   // respecte l'orientation EXIF
      .resize({ width: largeur, withoutEnlargement: true })
      .webp({ quality: 78, effort: 4 })
      .toBuffer();

    // Si le webp est plus lourd que l'original, autant garder l'original.
    return reduit.length < corps.length ? { corps: reduit, type: 'image/webp' } : null;
  } catch {
    return null;   // image illisible pour le decodeur : on sert l'octet recu
  }
}

/** Vrai si le redimensionnement est disponible, pour /api/health. */
export async function disponible() {
  return Boolean(await decodeur());
}
