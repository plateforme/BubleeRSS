// Le nettoyeur, mis à l'épreuve. Le HTML des articles vient de l'extérieur et
// finit en innerHTML : ce fichier est le filet qui doit céder en premier si
// une charge utile passait un jour.
//
// La CSP est la seconde ligne (server/entetes.js) ; elle ne dispense pas
// celle-ci d'être solide.
import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeHtml, absolutize, toPlainText } from '../server/html.js';

/** Ce qui reste après nettoyage ne doit contenir aucune de ces marques. */
function estSur(html, note) {
  const propre = sanitizeHtml(html, 'https://exemple.fr/article');
  assert.doesNotMatch(propre, /<script/i, note + ' — un <script> a survécu');
  assert.doesNotMatch(propre, /<(style|iframe(?![^>]*(youtube|vimeo|spotify|soundcloud|bandcamp|dailymotion|anchor|archive)))/i,
    note + ' — une balise interdite a survécu');
  assert.doesNotMatch(propre, /\son[a-z]+\s*=/i, note + ' — un gestionnaire on* a survécu');
  assert.doesNotMatch(propre, /javascript\s*:/i, note + ' — une adresse javascript: a survécu');
  assert.doesNotMatch(propre, /<(object|embed|form|svg|canvas|noscript|template|base|meta|link)\b/i,
    note + ' — une balise dangereuse a survécu');
  return propre;
}

const CHARGES = [
  ['script simple', '<p>a</p><script>alert(1)</script>'],
  ['script en majuscules', '<SCRIPT>alert(1)</SCRIPT>'],
  ['script avec attribut', '<script type="text/javascript" src="//mal.fr/x.js"></script>'],
  ['script mal fermé', '<script>alert(1)<script>'],
  ['gestionnaire sur une image', '<img src="x" onerror="alert(1)">'],
  ['gestionnaire en majuscules', '<img src="x" ONERROR="alert(1)">'],
  ['gestionnaire avec espaces', '<img src="x" onerror = "alert(1)">'],
  ['gestionnaire sans guillemets', '<img src=x onerror=alert(1)>'],
  ['lien javascript', '<a href="javascript:alert(1)">clic</a>'],
  ['lien javascript espacé', '<a href=" javascript:alert(1)">clic</a>'],
  ['lien javascript en majuscules', '<a href="JaVaScRiPt:alert(1)">clic</a>'],
  ['lien vbscript', '<a href="vbscript:msgbox(1)">clic</a>'],
  ['lien data html', '<a href="data:text/html,<script>alert(1)</script>">clic</a>'],
  ['image data html', '<img src="data:text/html;base64,PHNjcmlwdD4=">'],
  ['iframe étrangère', '<iframe src="https://mal.fr/x"></iframe>'],
  ['iframe javascript', '<iframe src="javascript:alert(1)"></iframe>'],
  ['iframe qui ressemble à YouTube', '<iframe src="https://youtube.com.mal.fr/embed/x"></iframe>'],
  ['style avec expression', '<style>body{background:url(javascript:alert(1))}</style>'],
  ['balise style en ligne', '<p style="background:url(javascript:alert(1))">a</p>'],
  ['svg avec onload', '<svg onload="alert(1)"><circle r="1"/></svg>'],
  ['formulaire', '<form action="https://mal.fr"><input name="a"><button>ok</button></form>'],
  ['object', '<object data="https://mal.fr/x.swf"></object>'],
  ['embed', '<embed src="https://mal.fr/x.swf">'],
  ['base détournée', '<base href="https://mal.fr/">'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://mal.fr">'],
  ['commentaire conditionnel', '<!--[if IE]><script>alert(1)</script><![endif]-->'],
  ['script dans un commentaire ouvert', '<!-- <script>alert(1)</script>'],
  ['balise imbriquée dans un attribut', '<a title="<script>alert(1)</script>" href="/x">clic</a>'],
  ['guillemet qui casse l’attribut', '<img src="x&quot; onerror=&quot;alert(1)">'],
  ['fin de balise dans un attribut', '<img src="x><script>alert(1)</script>">'],
  ['noscript', '<noscript><script>alert(1)</script></noscript>'],
  ['template', '<template><script>alert(1)</script></template>'],
  ['balise inconnue avec gestionnaire', '<xyz onclick="alert(1)">a</xyz>'],
  ['srcset javascript', '<img srcset="javascript:alert(1) 1x" src="/ok.png">'],
  ['poster javascript', '<video poster="javascript:alert(1)" src="/x.mp4"></video>']
];

for (const [nom, charge] of CHARGES) {
  test('le nettoyeur désamorce : ' + nom, () => estSur(charge, nom));
}

test('ce qui doit passer passe', () => {
  const propre = sanitizeHtml(
    '<p>Un <strong>vrai</strong> paragraphe, une <a href="/suite">suite</a> et une <img src="/photo.jpg" alt="x">.</p>'
    + '<blockquote cite="/source">citation</blockquote><table><tr><td colspan="2">a</td></tr></table>',
    'https://exemple.fr/article'
  );
  assert.match(propre, /<strong>vrai<\/strong>/);
  assert.match(propre, /href="https:\/\/exemple\.fr\/suite"/);
  assert.match(propre, /src="https:\/\/exemple\.fr\/photo\.jpg"/);
  assert.match(propre, /rel="noopener noreferrer external"/, 'un lien sortant est cadenassé');
  assert.match(propre, /loading="lazy"/);
  assert.match(propre, /referrerpolicy="no-referrer"/, 'une image ne dit pas d’où on vient');
  assert.match(propre, /colspan="2"/);
});

test('les lecteurs connus survivent, les autres non', () => {
  const garde = (url) => sanitizeHtml(`<iframe src="${url}"></iframe>`, 'https://exemple.fr/').includes('<iframe');
  assert.ok(garde('https://www.youtube-nocookie.com/embed/abc'));
  assert.ok(garde('https://player.vimeo.com/video/1'));
  assert.ok(garde('https://open.spotify.com/embed/episode/1'));
  assert.ok(!garde('https://mal.fr/embed/abc'));
  assert.ok(!garde('https://youtube.com.mal.fr/embed/abc'));
  assert.ok(!garde('//mal.fr/embed/abc'));
});

test('absolutize ne laisse passer que http, https et les petites images en ligne', () => {
  assert.equal(absolutize('javascript:alert(1)', 'https://exemple.fr/'), null);
  assert.equal(absolutize('  JAVASCRIPT:alert(1)', 'https://exemple.fr/'), null);
  assert.equal(absolutize('file:///etc/passwd', 'https://exemple.fr/'), null);
  assert.equal(absolutize('data:text/html,<script>', 'https://exemple.fr/'), null);
  assert.ok(absolutize('data:image/png;base64,AAAA', 'https://exemple.fr/'));
  assert.equal(absolutize('data:image/png;base64,' + 'A'.repeat(300000), 'https://exemple.fr/'), null,
    'une image en ligne démesurée est refusée');
  assert.equal(absolutize('/suite', 'https://exemple.fr/a/b'), 'https://exemple.fr/suite');
});

test('le texte brut ne garde pas le contenu des scripts', () => {
  const texte = toPlainText('<p>visible</p><script>invisible_secret</script><style>.a{color:red}</style>');
  assert.match(texte, /visible/);
  assert.doesNotMatch(texte, /invisible_secret/);
  assert.doesNotMatch(texte, /color:red/);
});
