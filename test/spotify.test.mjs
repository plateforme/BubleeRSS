import test from 'node:test';
import assert from 'node:assert/strict';

import { estSpotify, resoudreFluxSpotify, _pourLesTests } from '../server/spotify.js';

const { titreDansLaPage, memeEmission, simplifier } = _pourLesTests;

/* ------------------------------------------------------ ce qui est de Spotify */

test('reconnaît une adresse Spotify, et elle seule', () => {
  assert.ok(estSpotify('https://open.spotify.com/show/abc'));
  assert.ok(estSpotify('https://spotify.link/xyz'), 'les liens courts aussi');
  assert.ok(!estSpotify('https://exemple.fr/show/abc'));
  assert.ok(!estSpotify('https://spotify.fr.mal.example/show/abc'), 'un hôte qui imite ne passe pas');
  assert.ok(!estSpotify('pas une adresse'));
});

test('seules les émissions sont traitées : le reste renonce sans toucher au réseau', async () => {
  // Un épisode annonce son propre titre, pas celui de l'émission : chercher
  // dessus ne mènerait nulle part. Une playlist, un artiste, encore moins.
  assert.equal(await resoudreFluxSpotify('https://open.spotify.com/episode/abc'), null);
  assert.equal(await resoudreFluxSpotify('https://open.spotify.com/playlist/abc'), null);
  assert.equal(await resoudreFluxSpotify('https://open.spotify.com/artist/abc'), null);
  assert.equal(await resoudreFluxSpotify('https://exemple.fr/show/abc'), null);
  assert.equal(await resoudreFluxSpotify('n’importe quoi'), null);
});

/* ------------------------------------------------- le nom lu dans la page */

test('tire le nom de l’émission de la page, débarrassé de ce que Spotify y accroche', () => {
  assert.equal(
    titreDansLaPage('<meta property="og:title" content="The Daily | Podcast on Spotify">'),
    'The Daily'
  );
  assert.equal(
    titreDansLaPage('<meta name="twitter:title" content="Affaires sensibles"><title>autre</title>'),
    'Affaires sensibles',
    'à défaut d’open graph, twitter fait l’affaire'
  );
  assert.equal(
    titreDansLaPage('<meta property="og:title" content="C&#39;est arriv&eacute; demain">'),
    "C'est arrivé demain",
    'les entités sont décodées — apostrophe droite comprise'
  );
  assert.equal(titreDansLaPage('<p>rien ici</p>'), null);
});

/* -------------------------------------------- l’appariement avec l’annuaire */

test('compare les noms sans casse, accents ni ponctuation', () => {
  assert.equal(simplifier('Affaires Sensibles — France Inter'), 'affaires sensibles france inter');
  assert.equal(simplifier('L’Heure du Monde 2'), 'l heure du monde 2', 'les chiffres restent');
});

test('apparie une émission sans confondre deux voisines', () => {
  assert.ok(memeEmission('The Daily', 'The Daily'));
  assert.ok(memeEmission('The Daily', 'The Daily : the news'), 'un sous-titre ne disqualifie pas');
  assert.ok(!memeEmission('The Daily', 'Affaires sensibles'));
  assert.ok(!memeEmission('The Daily', 'Daily'), 'ni un nom seulement contenu');
  assert.ok(!memeEmission('', 'The Daily'), 'un nom vide n’apparie rien');
});
