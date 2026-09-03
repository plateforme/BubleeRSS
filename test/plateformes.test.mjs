import test from 'node:test';
import assert from 'node:assert/strict';

import { fluxDePlateforme } from '../server/plateformes.js';

test('Mastodon : un profil, sur n’importe quelle instance', () => {
  assert.equal(fluxDePlateforme('https://mamot.fr/@gregoire'), 'https://mamot.fr/@gregoire.rss');
  assert.equal(fluxDePlateforme('piaille.fr/@quelquun/'), 'https://piaille.fr/@quelquun.rss');
  assert.equal(fluxDePlateforme('@gregoire@mamot.fr'), 'https://mamot.fr/@gregoire.rss');
});

test('Medium partage la forme mais pas la convention', () => {
  assert.equal(fluxDePlateforme('https://medium.com/@alice'), 'https://medium.com/feed/@alice');
});

test('Bluesky : le flux d’un profil', () => {
  assert.equal(fluxDePlateforme('https://bsky.app/profile/exemple.bsky.social'),
    'https://bsky.app/profile/exemple.bsky.social/rss');
  assert.equal(fluxDePlateforme('https://bsky.app/profile/exemple.bsky.social/post/abc'),
    'https://bsky.app/profile/exemple.bsky.social/rss');
});

test('Reddit : sous-forum et profil', () => {
  assert.equal(fluxDePlateforme('https://www.reddit.com/r/france'), 'https://www.reddit.com/r/france/.rss');
  assert.equal(fluxDePlateforme('reddit.com/r/france/hot/'), 'https://www.reddit.com/r/france/.rss');
  assert.equal(fluxDePlateforme('https://old.reddit.com/user/quelquun'), 'https://www.reddit.com/user/quelquun/.rss');
  assert.equal(fluxDePlateforme('https://www.reddit.com/u/quelquun'), 'https://www.reddit.com/user/quelquun/.rss');
});

test('GitHub : les publications d’un dépôt, l’activité d’un compte', () => {
  assert.equal(fluxDePlateforme('https://github.com/nodejs/node'), 'https://github.com/nodejs/node/releases.atom');
  assert.equal(fluxDePlateforme('github.com/nodejs/node.git'), 'https://github.com/nodejs/node/releases.atom');
  assert.equal(fluxDePlateforme('https://github.com/torvalds'), 'https://github.com/torvalds.atom');
  assert.equal(fluxDePlateforme('https://github.com/topics/rss'), null, 'une page de service n’est pas un compte');
});

test('le reste n’est pas deviné', () => {
  assert.equal(fluxDePlateforme('https://www.lemonde.fr/'), null);
  assert.equal(fluxDePlateforme('https://exemple.fr/blog/2026/article'), null);
  assert.equal(fluxDePlateforme(''), null);
  assert.equal(fluxDePlateforme('pas une adresse du tout'), null);
});
