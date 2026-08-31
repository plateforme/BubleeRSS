// Recuperation du texte complet quand un flux ne publie qu'un resume.
// On telecharge la page, on la passe dans Readability, on la renettoie.
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

import { httpGet, decodeBody, urlPubliqueOuNull } from './http.js';
import { sanitizeHtml, toPlainText, countWords, absolutize } from './html.js';

const ACCEPT_HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

/** Cherche une image d'illustration dans les metadonnees de la page. */
function imageDeLaPage(document, base) {
  const selectors = [
    'meta[property="og:image"]',
    'meta[name="og:image"]',
    'meta[property="twitter:image"]',
    'meta[name="twitter:image"]',
    'link[rel="image_src"]'
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const value = el?.getAttribute('content') || el?.getAttribute('href');
    const abs = absolutize(value, base);
    if (abs) return abs;
  }
  return null;
}

/**
 * Recupere seulement l'illustration d'un article, pour les flux qui n'en
 * fournissent aucune. On lit les metadonnees de partage, sans passer par
 * Readability : c'est nettement plus leger.
 */
export async function extraireImageDeLaPage(url) {
  const cible = urlPubliqueOuNull(url);
  if (!cible) return null;

  const { res, buffer } = await httpGet(cible.href, {
    navigateur: true,
    timeout: 15000,
    headers: { accept: ACCEPT_HTML }
  });
  if (!res.ok) return null;

  const type = res.headers.get('content-type') || '';
  if (type && !/text\/html|application\/xhtml/i.test(type)) return null;

  const html = decodeBody(buffer, type);
  const finTete = html.search(/<\/head>/i);
  const tete = finTete > 0 ? html.slice(0, finTete) : html;

  const motif = /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)["'][^>]*>/gi;

  // L'en-tete d'abord, c'est la que la balise se trouve presque toujours.
  // Puis le document entier : YouTube, par exemple, place ses balises og:
  // apres </head>, et s'arreter a l'en-tete ne trouverait jamais l'avatar.
  for (const portee of tete === html ? [html] : [tete, html]) {
    motif.lastIndex = 0;
    let m;
    while ((m = motif.exec(portee))) {
      const contenu = /content\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(m[0]);
      if (!contenu) continue;
      const abs = absolutize(contenu[1].replace(/^["']|["']$/g, ''), res.url || cible.href);
      if (abs) return abs;
    }
  }
  return null;
}

export const EXTRACTION_DOUTEUSE =
  'La page est surtout de la mise en page — menus, comparateur de prix, encarts — et pas un article.';

/** En deca, le rapport est trop bruite pour decider : une breve de trois lignes
    a mecaniquement beaucoup de balises par caractere. */
const TEXTE_MESURABLE = 300;
const BALISES_MAX = 70;      // par millier de caracteres de texte
const IMAGES_ILLUSTRE = 15;  // au-dela, c'est une galerie, pas un debordement

/**
 * Readability se trompe parfois de bloc et rend la page entiere : le comparateur
 * de prix d'un bon plan, une liste de marchands, un pied de page. Ca se voit au
 * nombre de balises rapporte au texte — un paragraphe, c'est une balise pour
 * cent-cinquante caracteres ; une ligne de comparateur, huit balises pour trente.
 *
 * Sur la bibliotheque reelle, tout ce qui etait lisible plafonnait a 42 balises
 * par millier de caracteres, et les pages ratees demarraient a 95.
 *
 * Une exception : un article tres illustre (une galerie d'architecture) monte
 * aussi haut, mais parce qu'il est fait d'images. On ne compte donc comme
 * suspect que le balisage que les images n'expliquent pas.
 */
export function extractionDouteuse(html, texte) {
  if (texte.length < TEXTE_MESURABLE) return false;
  const mille = texte.length / 1000;
  const balises = (html.match(/<[a-z]/gi) || []).length / mille;
  const images = (html.match(/<img[\s>]/gi) || []).length / mille;
  return balises > BALISES_MAX && images < IMAGES_ILLUSTRE;
}

/**
 * Telecharge `url` et en extrait l'article principal.
 * Leve une erreur explicite si la page est inaccessible ou illisible.
 */
export async function extraireTexteComplet(url) {
  const cible = urlPubliqueOuNull(url);
  if (!cible) throw Object.assign(new Error('Adresse inutilisable.'), { status: 400 });

  const { res, buffer } = await httpGet(cible.href, {
    navigateur: true,
    timeout: 25000,
    headers: { accept: ACCEPT_HTML }
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('Le site refuse la lecture automatique (protection anti-robot).');
    }
    if (res.status === 404 || res.status === 410) throw new Error('La page n’existe plus.');
    if (res.status === 429) throw new Error('Le site demande de ralentir, à réessayer plus tard.');
    throw new Error('La page répond ' + res.status + '.');
  }

  const type = res.headers.get('content-type') || '';
  if (type && !/text\/html|application\/xhtml/i.test(type)) {
    throw new Error('Ce lien ne pointe pas vers une page web.');
  }

  const finalUrl = res.url || cible.href;
  const html = decodeBody(buffer, type);

  // JSDOM n'execute aucun script et ne charge aucune ressource externe.
  const dom = new JSDOM(html, { url: finalUrl });
  const document = dom.window.document;
  const image = imageDeLaPage(document, finalUrl);

  const article = new Readability(document, { charThreshold: 250 }).parse();
  if (!article || !article.content) throw new Error('Aucun texte d’article reconnu sur la page.');

  const contenu = sanitizeHtml(article.content, finalUrl);
  const texte = toPlainText(contenu);
  if (countWords(texte) < 40) throw new Error('Le texte extrait est trop court.');
  if (extractionDouteuse(contenu, texte)) throw new Error(EXTRACTION_DOUTEUSE);

  return {
    content: contenu,
    wordCount: countWords(texte),
    byline: article.byline ? String(article.byline).trim().slice(0, 160) : null,
    excerpt: article.excerpt ? String(article.excerpt).trim().slice(0, 600) : null,
    image,
    finalUrl
  };
}
