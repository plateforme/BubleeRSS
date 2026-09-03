// Le baladeur : un seul lecteur audio, hors du panneau de lecture.
//
// Un podcast vivait dans le lecteur, et le fermer coupait le son — exactement
// ce qu’on ne veut pas d’une écoute. Celui-ci survit à tout : changer
// d’article, revenir à la liste, chercher autre chose.
import { $, toast } from './etat.js';
import { relais } from './util.js';


/* Un podcast vivait dans le panneau de lecture : le fermer coupait le son, ce
   qui est exactement ce qu'on ne veut pas d'une écoute. Le lecteur audio est
   donc unique, en pied de page, et survit à tout — changer d'article, revenir
   à la liste, chercher autre chose.

   La position est retenue par épisode : reprendre un épisode d'une heure là où
   on l'avait laissé est la moitié de ce qu'on attend d'un baladeur. */

const VITESSES = [1, 1.25, 1.5, 1.75, 2];
const POSITIONS = 'bublee.ecoutes';

let ecoute = null;              // { id, titre, source, src }

export function positions() {
  try { return JSON.parse(localStorage.getItem(POSITIONS) || '{}'); } catch { return {}; }
}

function retenirPosition(id, secondes) {
  try {
    const toutes = positions();
    // Un épisode fini n'a pas de reprise à retenir ; on ne garde que
    // cinquante entrées, sinon le stockage enfle sans qu'on le voie.
    if (secondes > 5) toutes[id] = Math.round(secondes); else delete toutes[id];
    const cles = Object.keys(toutes);
    for (const vieille of cles.slice(0, Math.max(0, cles.length - 50))) delete toutes[vieille];
    localStorage.setItem(POSITIONS, JSON.stringify(toutes));
  } catch { /* stockage plein ou refusé : l'écoute continue */ }
}

const minutes = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return (m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : String(m))
    + ':' + String(r).padStart(2, '0');
};

export function ecouter(article, src) {
  const audio = $('#baladeurAudio');
  const memeEpisode = ecoute?.id === article.id;
  ecoute = { id: article.id, titre: article.title, source: article.feed_title, src };

  $('#baladeur').hidden = false;
  $('#app').classList.add('avec-baladeur');
  $('#baladeurTitre').textContent = article.title;
  $('#baladeurSource').textContent = article.feed_title || '';

  if (!memeEpisode) {
    audio.src = src;
    const reprise = positions()[article.id];
    if (reprise) audio.currentTime = reprise;
  }
  audio.play().catch((error) => toast('Lecture impossible : ' + error.message, 'bad'));

  // Les commandes de l'écran verrouillé, quand le navigateur les porte.
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: article.title,
      artist: article.feed_title || 'Bublee',
      artwork: article.image ? [{ src: relais(article.image, 400), sizes: '512x512' }] : []
    });
    navigator.mediaSession.setActionHandler('play', () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('seekbackward', () => { audio.currentTime -= 15; });
    navigator.mediaSession.setActionHandler('seekforward', () => { audio.currentTime += 30; });
  }
}

export function fermerBaladeur() {
  const audio = $('#baladeurAudio');
  audio.pause();
  if (ecoute) retenirPosition(ecoute.id, audio.currentTime);
  audio.removeAttribute('src');
  audio.load();
  ecoute = null;
  $('#baladeur').hidden = true;
  $('#app').classList.remove('avec-baladeur');
}

export function brancherBaladeur() {
  const audio = $('#baladeurAudio');
  const barre = $('#baladeurBarre');
  let glisse = false;

  const peindre = () => {
    $('#baladeurGlyphe').textContent = audio.paused ? '▶' : '❚❚';
    if (!glisse && Number.isFinite(audio.duration)) {
      barre.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    }
    $('#baladeurTemps').textContent = minutes(audio.currentTime)
      + (Number.isFinite(audio.duration) ? ' / ' + minutes(audio.duration) : '');
  };

  audio.addEventListener('timeupdate', peindre);
  audio.addEventListener('play', peindre);
  audio.addEventListener('pause', () => { peindre(); if (ecoute) retenirPosition(ecoute.id, audio.currentTime); });
  audio.addEventListener('loadedmetadata', peindre);
  audio.addEventListener('ended', () => { if (ecoute) retenirPosition(ecoute.id, 0); peindre(); });
  audio.addEventListener('error', () => toast('L’épisode ne se charge pas.', 'bad'));

  $('#baladeurJouer').addEventListener('click', () => (audio.paused ? audio.play() : audio.pause()));
  $('#baladeurFermer').addEventListener('click', fermerBaladeur);
  $('#baladeurVitesse').addEventListener('click', (e) => {
    const suivante = VITESSES[(VITESSES.indexOf(audio.playbackRate) + 1) % VITESSES.length];
    audio.playbackRate = suivante;
    e.currentTarget.textContent = (suivante % 1 ? suivante.toFixed(2).replace(/0$/, '') : suivante) + '×';
  });
  barre.addEventListener('input', () => { glisse = true; });
  barre.addEventListener('change', () => {
    glisse = false;
    if (Number.isFinite(audio.duration)) audio.currentTime = (Number(barre.value) / 1000) * audio.duration;
  });
  // Une position perdue à la fermeture de l'onglet, c'est un épisode à
  // retrouver à l'oreille.
  addEventListener('pagehide', () => { if (ecoute) retenirPosition(ecoute.id, audio.currentTime); });
}

/**
 * Remplace le lecteur audio en ligne d'un épisode par un bouton qui confie
 * l'écoute au baladeur. Sans ça, deux lecteurs coexisteraient — celui de
 * l'article et celui du pied de page — et pourraient jouer en même temps.
 */
export function detournerLAudio(article) {
  const enLigne = $('.reader-body audio', $('#readerScroll'));
  if (!enLigne) return;
  const src = enLigne.getAttribute('src') || $('source', enLigne)?.getAttribute('src');
  if (!src) return;

  const bouton = document.createElement('button');
  bouton.type = 'button';
  bouton.className = 'btn solid ecouter';
  const reprise = positions()[article.id];
  bouton.textContent = reprise ? `Reprendre à ${minutes(reprise)}` : 'Écouter l’épisode';
  bouton.addEventListener('click', () => ecouter(article, src));
  enLigne.replaceWith(bouton);
}
