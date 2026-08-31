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

  return {
    content: contenu,
    wordCount: countWords(texte),
    byline: article.byline ? String(article.byline).trim().slice(0, 160) : null,
    excerpt: article.excerpt ? String(article.excerpt).trim().slice(0, 600) : null,
    image,
    finalUrl
  };
}
