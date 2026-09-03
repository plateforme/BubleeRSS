import test from 'node:test';
import assert from 'node:assert/strict';

import { extractionDouteuse } from '../server/readable.js';

/* Les seuils viennent de la bibliotheque reelle : sur les extractions deja en
   base, tout ce qui etait lisible plafonnait a 42 balises par millier de
   caracteres de texte, et les pages ratees demarraient a 95. Les cas ci-dessous
   reproduisent les deux cotes de cette frontiere. */

const texteDe = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const juge = (html) => extractionDouteuse(html, texteDe(html));

/** Un article ordinaire : une balise pour cent-cinquante caracteres. */
function article(paragraphes = 12) {
  const phrase = 'Le rapport rendu mardi decrit une situation plus contrastee que prevu, '
    + 'et invite a revoir les hypotheses retenues jusqu ici par les autorites locales.';
  return Array.from({ length: paragraphes }, () => `<p>${phrase}</p>`).join('');
}

/** Une ligne de comparateur : huit balises pour trente caracteres. */
function comparateur(lignes = 60) {
  return Array.from({ length: lignes }, (_, i) =>
    `<li><div><p><span><span>Marchand ${i}</span></span></p>`
    + '<p><span>2 199,00 &euro;</span><span>Neuf</span></p></div></li>').join('');
}

test('un article ordinaire passe', () => {
  assert.equal(juge(article()), false);
});

test('un comparateur de prix est rejete', () => {
  assert.equal(juge(comparateur()), true);
});

test('l’article noye dans le comparateur est rejete lui aussi', () => {
  // Le cas reel : Readability ramene l'article ET tout le comparateur derriere.
  assert.equal(juge(article(6) + comparateur(120)), true);
});

test('une galerie photo passe : ses images expliquent le balisage', () => {
  const images = Array.from({ length: 40 }, (_, i) =>
    `<figure><img src="https://exemple.test/photo-${i}.jpg" alt=""><figcaption>Vue ${i}</figcaption></figure>`).join('');
  const html = `<p>La maison occupe une parcelle etroite au nord de la ville, entre deux pignons aveugles.</p>${images}`;
  assert.equal(juge(html), false);
});

test('une breve trop courte n’est pas jugee : le rapport y est trop bruite', () => {
  const html = '<p><span>Bruxelles</span> ouvre une enquete.</p><ul><li>Un</li><li>Deux</li><li>Trois</li></ul>';
  assert.ok(texteDe(html).length < 300);
  assert.equal(juge(html), false);
});
