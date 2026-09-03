import { api } from './api.js';
import { esc, quand, heure, dateJournal, tempsLecture, duree, relais, hote, debounce, pluriel, nombre } from './util.js';

const $ = (sel, scope = document) => scope.querySelector(sel);
const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];

/* ------------------------------------------------------------------- etat */

const state = {
  view: 'unread',        // unread | all | starred
  feedId: null,
  folder: null,
  q: '',
  tri: 'date',           // pendant une recherche : date | pertinence
  edition: null,         // { total, restants, minutes } dans la vue « édition »
  tag: null,
  layout: 'magazine',    // magazine (la une) | list (sommaire) | compact (dépêches)
  articles: [],
  cursor: null,
  loading: false,
  done: false,
  pointer: -1,
  openId: null,
  ouvert: null,          // l'article affiche dans le lecteur, liste ou non
  moi: null,             // le compte connecte
  profondeur: 0,         // articles enchaines depuis celui ouvert depuis la liste
  feeds: [],
  folders: [],
  counts: { unread: 0, starred: 0, total: 0 },
  tags: [],
  regles: [],
  palette: [],
  accents: [],
  settings: {}
};

const CLASSE_LAYOUT = { magazine: 'l-une', list: 'l-sommaire', compact: 'l-depeches' };

/** Palette fermée du kiosque : six teintes, deux neutres. */
const TEINTES_SOURCE = [
  '#e2452a', '#1b3fd8', '#f0a91d',
  '#10604a', '#6a2fd0', '#d81e73',
  '#a9a69d', '#f6f5f1'
];

const collapsed = new Set(JSON.parse(localStorage.getItem('bublee.collapsed') || '[]'));

const SUGGESTIONS = [
  { title: 'Le Monde — Une', url: 'https://www.lemonde.fr/rss/une.xml', folder: 'Actualité' },
  { title: 'France Info', url: 'https://www.francetvinfo.fr/titres.rss', folder: 'Actualité' },
  { title: 'Le Devoir', url: 'https://www.ledevoir.com/rss/manchettes.xml', folder: 'Actualité' },
  { title: 'Numerama', url: 'https://www.numerama.com/feed/', folder: 'Tech' },
  { title: 'Next', url: 'https://next.ink/feed/', folder: 'Tech' },
  { title: 'Hacker News', url: 'https://hnrss.org/frontpage', folder: 'Tech' },
  { title: 'Aeon', url: 'https://aeon.co/feed.rss', folder: 'Idées' },
  { title: 'Kurzgesagt', url: 'https://www.youtube.com/@kurzgesagt', folder: 'Vidéo' }
];

/* --------------------------------------------------------------- couleurs */

/** Teinte stable par source : une même source garde toujours la sienne. */
function teinte(texte) {
  let h = 0;
  for (const c of String(texte || '')) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return TEINTES_SOURCE[h % TEINTES_SOURCE.length];
}

/** Encre ou papier sur une teinte, selon sa luminance perceptuelle. */
function contraste(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const lum = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
  return lum > 150 ? '#1b1a17' : '#f6f5f1';
}

function rgba(hex, alpha) {
  const n = parseInt(String(hex).slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/* ----------------------------------------------------------------- toasts */

/**
 * Un message passager. `action` y pose un bouton — « Annuler » après un
 * marquage en masse : le geste le plus lourd de l'application est aussi le
 * seul qui n'avait pas de filet.
 */
function toast(message, kind = '', action = null) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.append(message);
  if (action) {
    const bouton = document.createElement('button');
    bouton.className = 'toast-action';
    bouton.type = 'button';
    bouton.textContent = action.libelle;
    bouton.addEventListener('click', () => { el.remove(); action.faire(); });
    el.append(bouton);
  }
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, action ? 7000 : kind === 'bad' ? 4600 : 2800);
}

/* --------------------------------------------------------------- demarrage */

/* ================================================== connexion et comptes === */

/**
 * La porte : premier écran quand personne n'est connecté. Elle sert aussi à
 * l'installation — le tout premier compte devient super et reprend la
 * bibliothèque d'avant les comptes.
 */
async function ouvrirLaPorte() {
  const etat = await api.etatAuth();
  if (etat.compte) { state.moi = etat.compte; return true; }

  const installation = !etat.installe;
  const porte = $('#porte');
  porte.hidden = false;
  $('#porteNomChamp').hidden = !installation;
  $('#portePass').autocomplete = installation ? 'new-password' : 'current-password';
  $('#porteBouton').textContent = installation ? 'Créer le compte' : 'Entrer';
  $('#porteIntro').textContent = installation
    ? 'Personne n’a encore de compte ici. Le premier créé sera super-utilisateur : il pourra en ouvrir d’autres.'
    : 'Chaque compte a sa propre bibliothèque.';
  $('#porteEmail').focus();

  // On rend la main à `boot`, qui reprendra une fois la porte franchie.
  return new Promise((resolve) => {
    $('#porteForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const erreur = $('#porteErreur');
      erreur.hidden = true;
      const email = $('#porteEmail').value.trim();
      const motDePasse = $('#portePass').value;
      try {
        const r = installation
          ? await api.installer({ email, nom: $('#porteNom').value.trim(), motDePasse })
          : await api.login(email, motDePasse);
        state.moi = r.compte;
        if (r.repris?.flux) toast(`${nombre(r.repris.flux)} source(s) reprise(s) dans ton compte.`);
        porte.hidden = true;
        resolve(true);
      } catch (error) {
        erreur.textContent = error.message;
        erreur.hidden = false;
        $('#portePass').select();
      }
    });
  });
}

function renderMonCompte() {
  const moi = state.moi;
  if (!moi) return;
  $('#compteQui').textContent = `${moi.email} · ${moi.role === 'super' ? 'super-utilisateur' : 'éditeur'}`;
  $('#compteNom').value = moi.nom || '';
  const estSuper = moi.role === 'super';
  $('#sepComptes').hidden = !estSuper;
  $('#zoneComptes').hidden = !estSuper;
  // La base porte tous les comptes : seul un super la télécharge.
  $('#sauvegarde').hidden = !estSuper;
  if (estSuper) renderComptes();
}

async function renderComptes() {
  let liste;
  try { liste = (await api.comptes()).comptes; } catch { return; }

  $('#comptesListe').innerHTML = liste.map((c) => `
    <div class="compte-ligne${c.actif ? '' : ' suspendu'}">
      <span class="compte-qui">
        <b>${esc(c.nom || c.email)}${c.id === state.moi.id ? ' <span class="compte-moi">— moi</span>' : ''}</b>
        <span>${esc(c.email)}</span>
      </span>
      <span class="compte-chiffres">${nombre(c.sources)} src<br>${nombre(c.articles)} art.</span>
      <select data-role-de="${c.id}"${c.id === state.moi.id ? ' disabled' : ''}>
        <option value="editeur"${c.role === 'editeur' ? ' selected' : ''}>Éditeur</option>
        <option value="super"${c.role === 'super' ? ' selected' : ''}>Super</option>
      </select>
      ${c.id === state.moi.id ? '' : `
        <button type="button" data-actif-de="${c.id}" data-actif="${c.actif ? 0 : 1}">${c.actif ? 'Suspendre' : 'Réactiver'}</button>
        <button type="button" class="lien-danger" data-supprimer-compte="${c.id}" data-nom="${esc(c.nom || c.email)}">Supprimer</button>`}
    </div>`).join('');
}

/* --------------------------------------------- ce que le serveur annonce */

/* Le rafraîchissement automatique arrivait en silence : les compteurs de
   l'index restaient ceux du chargement, et rien ne disait que quatorze
   articles venaient d'entrer. Le serveur pousse maintenant ce qu'il a à dire.

   On ne réordonne jamais la liste sous les yeux de qui lit : on pose un
   bandeau, et c'est le lecteur qui décide de le suivre. */

let entrants = 0;

function annoncerNouveautes(n) {
  entrants += n;
  const bandeau = $('#nouveautes');
  bandeau.hidden = !entrants;
  bandeau.textContent = `${nombre(entrants)} ${entrants > 1 ? 'nouveaux articles' : 'nouvel article'} — afficher`;
}

function ecouterLeServeur() {
  if (!('EventSource' in window)) return;
  // EventSource se reconnecte tout seul : rien à tenir ici.
  const flux = new EventSource('/api/events');

  flux.addEventListener('compteurs', (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    majCompteurs(d);
    // Dans une vue d'ensemble seulement : sur une source précise ou une
    // recherche, ce qui arrive ailleurs ne regarde pas la page ouverte.
    const ensemble = !state.feedId && !state.folder && !state.tag && !state.q;
    if (d.added && ensemble) annoncerNouveautes(d.added);
    if (d.import === 'fini') {
      toast('Import terminé');
      // Les sources importées doivent entrer dans l'index, pas seulement
      // leurs articles dans la liste.
      reloadState().then(() => loadArticles(true)).catch(() => {});
    }
  });

  flux.addEventListener('import', (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (d.etat === 'en-cours') toast(`${pluriel(d.sources, 'source ajoutée', 'sources ajoutées')} — téléchargement en cours`);
    if (d.etat === 'echec') toast('Téléchargement interrompu : ' + d.error, 'bad');
  });
}

/* ------------------------------------------------- l'ordre des sources */

/* L'index rangeait les sources par titre, sans recours : une source qu'on lit
   tous les jours se retrouvait en bas de son dossier parce qu'elle commence
   par un W. Elles se déplacent maintenant au glissé, dans leur dossier.

   Tant qu'on n'a touché à rien, la position vaut zéro partout et l'ordre reste
   l'alphabet — seul un dossier qu'on a rangé à la main s'en écarte. */

function glisserLesSources() {
  const liste = $('#feedList');
  let prise = null;

  liste.addEventListener('dragstart', (e) => {
    const ligne = e.target.closest('.feed-row');
    if (!ligne) return;
    prise = ligne;
    ligne.classList.add('emportee');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox ne démarre pas un glissé sans données.
    e.dataTransfer.setData('text/plain', ligne.dataset.feed);
  });

  liste.addEventListener('dragover', (e) => {
    if (!prise) return;
    const cible = e.target.closest('.feed-row');
    // On ne déplace qu'à l'intérieur d'un dossier : changer de dossier reste
    // le rôle de la fiche de la source, où l'on voit ce qu'on fait.
    if (!cible || cible === prise || cible.dataset.dossier !== prise.dataset.dossier) return;
    e.preventDefault();
    const r = cible.getBoundingClientRect();
    cible.parentNode.insertBefore(prise, e.clientY < r.top + r.height / 2 ? cible : cible.nextSibling);
  });

  liste.addEventListener('dragend', async () => {
    if (!prise) return;
    const corps = prise.parentNode;
    prise.classList.remove('emportee');
    prise = null;

    const ids = [...corps.querySelectorAll('.feed-row')].map((n) => Number(n.dataset.feed));
    try {
      await api.ordonner(ids);
      // L'ordre local suit, sans redemander tout l'état : la liste est déjà
      // à l'écran dans le bon ordre, la refaire la ferait sauter.
      ids.forEach((id, rang) => {
        const feed = state.feeds.find((f) => f.id === id);
        if (feed) feed.position = rang + 1;
      });
      state.feeds.sort((a, b) => (a.folder === '' ? 0 : 1) - (b.folder === '' ? 0 : 1)
        || (a.folder || '').localeCompare(b.folder || '', 'fr')
        || a.position - b.position
        || a.title.localeCompare(b.title, 'fr'));
    } catch (error) {
      toast('Ordre : ' + error.message, 'bad');
      renderFeedList();
    }
  });
}

/* ------------------------------------------------- réglages de lecture */

/* Corps, interligne, largeur de colonne. Un lecteur qu'on utilise une heure
   par jour doit se régler à l'œil de chacun : trois variables CSS et trois
   curseurs. Comme le thème et la largeur de l'index, ça vit dans le
   navigateur — c'est un réglage d'écran, pas de compte. */

const LECTURE_DEFAUT = { corps: 19.5, interligne: 1.68, colonne: 66 };

function lireLecture() {
  try { return { ...LECTURE_DEFAUT, ...JSON.parse(localStorage.getItem('bublee.lecture') || '{}') }; }
  catch { return { ...LECTURE_DEFAUT }; }
}

function appliquerLecture(reglages) {
  const racine = document.documentElement.style;
  racine.setProperty('--corps', reglages.corps + 'px');
  racine.setProperty('--interligne', String(reglages.interligne));
  racine.setProperty('--colonne', reglages.colonne + 'ch');
  try { localStorage.setItem('bublee.lecture', JSON.stringify(reglages)); } catch { /* tant pis */ }

  $('#setCorps').value = String(reglages.corps);
  $('#setInterligne').value = String(reglages.interligne);
  $('#setColonne').value = String(reglages.colonne);
  $('#valCorps').textContent = reglages.corps + ' px';
  $('#valInterligne').textContent = Number(reglages.interligne).toFixed(2);
  $('#valColonne').textContent = reglages.colonne + ' signes';
}

function brancherLecture() {
  const relever = () => appliquerLecture({
    corps: Number($('#setCorps').value),
    interligne: Number($('#setInterligne').value),
    colonne: Number($('#setColonne').value)
  });
  for (const id of ['#setCorps', '#setInterligne', '#setColonne']) {
    $(id).addEventListener('input', relever);
  }
  $('#lectureDefaut').addEventListener('click', () => appliquerLecture({ ...LECTURE_DEFAUT }));
  appliquerLecture(lireLecture());
}

/* --------------------------------------------------------- le baladeur */

/* Un podcast vivait dans le panneau de lecture : le fermer coupait le son, ce
   qui est exactement ce qu'on ne veut pas d'une écoute. Le lecteur audio est
   donc unique, en pied de page, et survit à tout — changer d'article, revenir
   à la liste, chercher autre chose.

   La position est retenue par épisode : reprendre un épisode d'une heure là où
   on l'avait laissé est la moitié de ce qu'on attend d'un baladeur. */

const VITESSES = [1, 1.25, 1.5, 1.75, 2];
const POSITIONS = 'bublee.ecoutes';

let ecoute = null;              // { id, titre, source, src }

function positions() {
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

function ecouter(article, src) {
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
      artwork: article.image ? [{ src: relais(article.image), sizes: '512x512' }] : []
    });
    navigator.mediaSession.setActionHandler('play', () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('seekbackward', () => { audio.currentTime -= 15; });
    navigator.mediaSession.setActionHandler('seekforward', () => { audio.currentTime += 30; });
  }
}

function fermerBaladeur() {
  const audio = $('#baladeurAudio');
  audio.pause();
  if (ecoute) retenirPosition(ecoute.id, audio.currentTime);
  audio.removeAttribute('src');
  audio.load();
  ecoute = null;
  $('#baladeur').hidden = true;
  $('#app').classList.remove('avec-baladeur');
}

function brancherBaladeur() {
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
function detournerLAudio(article) {
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

/* ------------------------------------------------- hors ligne et partage */

/**
 * Le service worker : il garde la coquille et les articles déjà ouverts, de
 * sorte que Bublee s'ouvre et se relit sans réseau. Il ne s'enregistre qu'en
 * contexte sûr — le navigateur refuse ailleurs, et l'application marche très
 * bien sans lui.
 */
function poserLeServiceWorker() {
  if (!('serviceWorker' in navigator) || !isSecureContext) return;
  navigator.serviceWorker.register('/sw.js').catch(() => { /* tant pis, on reste en ligne */ });
}

/**
 * Une adresse partagée depuis le téléphone arrive sur /partage. On en tire ce
 * qui ressemble à une adresse — certaines applications mettent le lien dans
 * le texte plutôt que dans le champ prévu — et on ouvre l'ajout de source.
 */
function adressePartagee() {
  if (location.pathname !== '/partage') return null;
  const p = new URLSearchParams(location.search);
  const candidats = [p.get('url'), p.get('text'), p.get('title')].filter(Boolean);
  for (const c of candidats) {
    const trouve = /https?:\/\/\S+/.exec(c);
    if (trouve) return trouve[0];
  }
  return candidats[0] || null;
}

async function boot() {
  applyTheme(localStorage.getItem('bublee.theme') || 'auto');
  // L'amorce a posé l'état replié sur <html> avant le rendu ; on le reporte sur
  // .app, qui porte la grille — sans transition pour ce premier passage.
  if (document.documentElement.dataset.plie === '1') $('#app').classList.add('plie');

  // Rien ne se charge tant que personne n'est entré.
  await ouvrirLaPorte();
  $('#indexDate').textContent = dateJournal();
  $('#mastheadDate').textContent = dateJournal();

  // La vue vient de l'adresse avant le premier chargement : sans ça, on
  // chargeait les non-lus puis la vraie liste, deux fois.
  const ecran = ECRANS[location.hash];
  const depart = ecran ? null : lireAdresse();
  if (depart) {
    Object.assign(state, {
      view: depart.view, feedId: depart.feedId, folder: depart.folder, tag: depart.tag, q: depart.q
    });
    $('#search').value = depart.q;
  }

  try {
    const data = await api.state();
    absorb(data);
    applyAccent(data.settings.accent);
    applyLayout(data.settings.layout || 'magazine');
    await loadArticles(true);
  } catch (error) {
    toast('Le serveur ne répond pas : ' + error.message, 'bad');
  }
  wireEvents();

  poserLeServiceWorker();

  // Une adresse partagée depuis le téléphone, ou « #/ajouter » en marque-page.
  const partagee = adressePartagee();
  if (partagee || location.hash === '#/ajouter') {
    history.replaceState(null, '', '/#/' + state.view);
    openModal('#feedModal');
    $('#feedUrl').value = partagee || '';
    $('#feedUrl').focus();
    return;
  }

  // Un écran (étiquettes, réglages, raccourcis) s'ouvre par-dessus la vue.
  if (ecran) ecran();
  else if (depart.openId) openArticle(depart.openId);
  else ecrireAdresse({ remplacer: true });
}

function absorb(data) {
  state.feeds = data.feeds;
  state.folders = data.folders;
  state.counts = data.counts;
  state.tags = data.tags || [];
  state.palette = data.palette || state.palette;
  state.accents = data.accents || state.accents;
  state.settings = data.settings;
  renderIndex();
}

async function reloadState() {
  absorb(await api.state());
}

/* ============================================================== l'index */

/**
 * Les seuls chiffres. Lire un article n'a aucune raison de reconstruire
 * l'index — quatre-vingt-dix-huit lignes, leurs favicons et leurs teintes —
 * pour changer deux nombres. On les repeint là où ils sont.
 */
function peindreCompteurs() {
  $('#countUnread').textContent = nombre(state.counts.unread);
  $('#countAll').textContent = nombre(state.counts.total);
  $('#countStarred').textContent = nombre(state.counts.starred);
  $('#countSurvol').textContent = nombre(state.counts.survol || 0);
  $('#rowSurvol').hidden = !state.counts.survol && state.view !== 'survol';
  // L'édition ne s'affiche que s'il y a une édition : pas de ligne morte pour
  // qui vient de tout lire.
  $('#countEdition').textContent = nombre(state.counts.edition || 0);
  $('#rowEdition').hidden = !state.counts.edition && state.view !== 'edition';
  $('#lastRefresh').textContent = state.counts.lastRefreshAt ? 'Màj ' + quand(state.counts.lastRefreshAt) : '';
  $('#toolbarCount').textContent =
    `${nombre(state.counts.unread)} non lus · ${nombre(state.feeds.length)} sources`;

  for (const feed of state.feeds) {
    const ligne = $(`.feed-row[data-feed="${feed.id}"]`);
    if (ligne) $('.feed-count', ligne).textContent = feed.unread || '';
  }
  // Le compteur d'un dossier est la somme des siennes.
  for (const dossier of $$('.folder')) {
    const somme = state.feeds
      .filter((f) => (f.folder || '') === dossier.dataset.folder)
      .reduce((n, f) => n + f.unread, 0);
    $('.folder-count', dossier).textContent = somme || '';
  }
  for (const tag of state.tags) {
    const ligne = $(`.tag-row[data-tag="${CSS.escape(tag.name)}"]`);
    if (ligne) $('.tag-count', ligne).textContent = tag.count || '';
  }
}

/** Les chiffres renvoyés par une écriture, sans redemander tout l'état. */
function majCompteurs({ counts, feeds, tags_liste: tags } = {}) {
  if (counts) state.counts = counts;
  for (const maj of feeds || []) {
    const feed = state.feeds.find((f) => f.id === maj.id);
    if (feed) { feed.unread = maj.unread; feed.total = maj.total; }
  }
  if (tags) {
    state.tags = tags;
    $('#tagCount').textContent = String(state.tags.length).padStart(2, '0');
    renderTagList();
  }
  peindreCompteurs();
}

function renderIndex() {
  peindreCompteurs();

  const neutre = !state.feedId && !state.folder && !state.tag;
  $$('.view-row').forEach((b) => b.classList.toggle('active', neutre && b.dataset.view === state.view));

  $('#tagCount').textContent = String(state.tags.length).padStart(2, '0');
  $('#folderOptions').innerHTML = state.folders.map((f) => `<option value="${esc(f.name)}"></option>`).join('');

  renderTagList();
  renderFeedList();
  // Les lignes viennent d'être refaites : leurs compteurs avec.
  peindreCompteurs();
}

function couleurTag(nom) {
  return state.tags.find((t) => t.name === nom)?.color || 'var(--accent)';
}

function renderTagList() {
  $('#tagOptions').innerHTML = state.tags.map((t) => `<option value="${esc(t.name)}"></option>`).join('');

  $('#tagList').innerHTML = state.tags.map((t) => `
    <button class="tag-row${state.tag === t.name ? ' active' : ''}" data-tag="${esc(t.name)}"
            style="--teinte:${esc(t.color || 'var(--accent)')}">
      <span class="tag-square" aria-hidden="true"></span>
      <span class="tag-label">${esc(t.name)}</span>
      <span class="tag-count">${t.count || ''}</span>
    </button>`).join('');
}

/** Ce qu'ajoute l'infobulle d'une source selon sa priorité. */
const LEGENDE_PRIORITE = {
  survol: ' — en survol, hors des non-lus',
  muet: ' — muette, ne remonte plus d’elle-même'
};

/** La pastille de type : rien pour un article, une marque pour la vidéo et le son. */
function pastilleType(kind) {
  if (kind === 'video') {
    return `<span class="feed-badge"><svg viewBox="0 0 12 12" aria-hidden="true">
      <rect width="12" height="12" fill="#d63a2a"/><path d="M4.4 3.2 8.6 6 4.4 8.8Z" fill="#fff"/></svg></span>`;
  }
  if (kind === 'podcast') {
    return `<span class="feed-badge"><svg viewBox="0 0 12 12" aria-hidden="true">
      <rect width="12" height="12" fill="#f0a91d"/>
      <rect x="2.5" y="4.5" width="1.2" height="3" fill="#1b1a17"/>
      <rect x="5.4" y="2.6" width="1.2" height="6.8" fill="#1b1a17"/>
      <rect x="8.3" y="4.5" width="1.2" height="3" fill="#1b1a17"/></svg></span>`;
  }
  return '';
}

function renderFeedList() {
  const groups = new Map();
  for (const feed of state.feeds) {
    const key = feed.folder || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(feed);
  }

  const initiale = (t) => (String(t).match(/[\p{L}\p{N}]/u)?.[0] || '•').toUpperCase();

  const feedRow = (feed) => {
    const couleur = teinte(feed.title);
    const marque = feed.icon
      ? `<img class="feed-icon" src="${esc(relais(feed.icon))}" alt="" loading="lazy">`
      : `<span class="feed-icon mono-mark" style="--teinte:${couleur};--teinte-texte:${contraste(couleur)}">${esc(initiale(feed.title))}</span>`;

    return `
      <button class="feed-row${state.feedId === feed.id ? ' active' : ''}${feed.last_error ? ' error' : ''}${
                feed.priority && feed.priority !== 'suivi' ? ' p-' + feed.priority : ''}"
              data-feed="${feed.id}" data-dossier="${esc(feed.folder || '')}" draggable="true"
              style="--teinte:${couleur}"
              title="${esc(feed.last_error ? feed.title + ' — ' + feed.last_error
                : feed.title + (LEGENDE_PRIORITE[feed.priority] || ''))}">
        <span class="feed-bar" aria-hidden="true"></span>
        <span class="feed-mark">${marque}${pastilleType(feed.kind)}</span>
        <span class="feed-name">${esc(feed.title)}</span>
        ${feed.last_error ? '<span class="feed-warn">!</span>' : ''}
        <span class="feed-count">${feed.unread || ''}</span>
      </button>`;
  };

  const blocs = [];
  const libres = groups.get('') || [];
  if (libres.length) blocs.push(`<div class="folder-body">${libres.map(feedRow).join('')}</div>`);

  for (const [name, feeds] of [...groups].filter(([k]) => k).sort(([a], [b]) => a.localeCompare(b, 'fr'))) {
    const unread = feeds.reduce((s, f) => s + f.unread, 0);
    blocs.push(`
      <div class="folder${collapsed.has(name) ? ' collapsed' : ''}" data-folder="${esc(name)}">
        <button class="folder-head${state.folder === name ? ' active' : ''}" data-toggle="${esc(name)}"
                title="${esc(name)} — double-clic pour renommer">
          <span class="chev"><svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg></span>
          <span class="folder-name" data-open-folder="${esc(name)}" data-renommer="${esc(name)}">${esc(name)}</span>
          <span class="folder-rule"></span>
          <span class="folder-count">${unread || ''}</span>
        </button>
        <div class="folder-body">${feeds.map(feedRow).join('')}</div>
      </div>`);
  }

  $('#feedList').innerHTML = blocs.join('') ||
    '<p class="index-section" style="padding-top:8px">Aucune source</p>';
}

/* ------------------------------------------------------------ chargement */

function titreVue() {
  if (state.q) return `« ${state.q} »`;
  if (state.feedId) return state.feeds.find((f) => f.id === state.feedId)?.title || 'Source';
  if (state.tag) return '#' + state.tag;
  if (state.folder) return state.folder;
  return {
    unread: 'Non lus', all: 'Tout', starred: 'Favoris', survol: 'Survol', edition: 'L’édition du jour'
  }[state.view];
}

function sousTitre() {
  const n = state.articles.length;
  if (state.loading && !n) return 'Chargement';
  if (!n) return '';
  // L'édition annonce ce qu'elle demande : c'est ce qui en fait une pile
  // qu'on peut finir, et non un fond qui se dérobe.
  if (state.edition) {
    const { total, restants, minutes } = state.edition;
    return `${pluriel(total, 'article')} · ${minutes} min`
      + (restants && restants < total ? ` · ${nombre(restants)} à lire` : '');
  }
  return nombre(n) + (state.done ? '' : '+') + ' articles';
}

async function loadArticles(reset = false) {
  if (state.loading) return;
  if (reset) {
    state.articles = [];
    state.cursor = null;
    state.done = false;
    state.pointer = -1;
    state.edition = null;
    // La liste qu'on recharge contient ce qui vient d'arriver : le bandeau
    // n'a plus rien à annoncer.
    entrants = 0;
    $('#nouveautes').hidden = true;
    $('#scroller').scrollTop = 0;
    renderSkeleton();
  }
  if (state.done) return;

  state.loading = true;
  $('#stageTitle').textContent = titreVue();
  $('#stageSub').textContent = sousTitre();
  $('#triRecherche').hidden = !state.q;
  $$('#triRecherche [data-tri]').forEach((b) => b.classList.toggle('on', b.dataset.tri === state.tri));

  // Ce qui est déjà à l'écran ne sera pas refait : la page qui arrive s'ajoute.
  const depuis = reset ? 0 : state.articles.length;

  try {
    const data = await api.articles({
      view: state.view,
      feed: state.feedId,
      folder: state.folder,
      q: state.q,
      tag: state.tag,
      limit: state.layout === 'compact' ? 60 : 34,
      before: state.cursor,
      sort: state.q ? state.tri : null
    });
    state.articles.push(...data.articles);
    state.cursor = data.nextCursor;
    state.done = !data.nextCursor;
    state.edition = data.edition || null;
  } catch (error) {
    toast('Chargement impossible : ' + error.message, 'bad');
    state.done = true;
  } finally {
    state.loading = false;
    renderFlux({ depuis });
    $('#stageSub').textContent = sousTitre();
  }
}

function renderSkeleton() {
  $('#flux').innerHTML = `<div class="sk une"></div>
    <div class="cols">${'<div class="sk col"></div>'.repeat(4)}</div>`;
  $('#endNote').hidden = true;
}

/* ------------------------------------------------------- briques d'article */

const estVideo = (a) => /(^|\/\/)(www\.)?(youtube\.com\/watch|youtu\.be\/)/.test(a.url || '');
const estAudio = (a) => !estVideo(a) && Boolean(a.duration);

function laDuree(a) {
  if (a.duration) return duree(a.duration);
  return tempsLecture(a.word_count);
}

/**
 * La pastille de dossier, dans les vues d'ensemble seulement. Sur « Non lus »,
 * « Tout » et « Favoris », les articles viennent de partout et rien ne dit d'où
 * — alors que dans un dossier ou une source précise, ce serait se répéter.
 */
function pastilleDossier(a) {
  if (state.feedId || state.folder) return '';
  const nom = (a.feed_folder || '').trim();
  return nom ? `<span class="art-dossier">${esc(nom)}</span>` : '';
}

function surtitre(a, { avecDuree = true } = {}) {
  const bouts = [`${pastilleDossier(a)}<b>${esc(a.feed_title)}</b>`, esc(quand(a.published_at))];
  const d = avecDuree ? laDuree(a) : '';
  if (d) bouts.push(esc(d));
  return bouts.join(' · ');
}

/** Index de l'article dans la liste courante — sert au curseur clavier. */
let indexParId = new Map();

function attrs(a) {
  return `data-id="${a.id}" data-index="${indexParId.get(a.id)}"`;
}

const classeLue = (a) => (a.read_at ? ' read' : '');
const curseur = (a) => (indexParId.get(a.id) === state.pointer ? ' cursor' : '');

/**
 * Le titre d'un article, en vrai lien.
 *
 * Les cartes étaient des <button> contenant des <h2> et des <p> : du HTML
 * qu'aucune spécification n'autorise, et qu'un lecteur d'écran annonce comme
 * un seul bouton dont le libellé serait toute la carte, surtitre et chapô
 * compris. Le titre porte maintenant un lien : il nomme la carte, se tabule,
 * s'ouvre dans un onglet, se copie. La carte entière reste cliquable — c'est
 * le gestionnaire de la scène qui s'en charge.
 */
const lien = (a) => `<a class="art-lien" href="#/article/${a.id}" data-open="${a.id}">${esc(a.title)}</a>`;

/* ------------------------------------------- couleurs d'attente des images */

/**
 * Le fond posé derrière une illustration le temps qu'elle arrive. Deux teintes
 * moyennes de l'image elle-même quand on les connaît — haut et bas, ce qui
 * donne un dégradé qui ressemble à une version très floue de la photo. Sinon,
 * la teinte de la source : jamais de trou blanc.
 */
function fondImage(a) {
  const paire = String(a.image_color || '').split(',');
  const [h, b] = /^#[0-9a-f]{6}$/i.test(paire[0] || '') && /^#[0-9a-f]{6}$/i.test(paire[1] || '')
    ? paire
    : [rgba(teinte(a.feed_title), .5), rgba(teinte(a.feed_title), .8)];
  return `--f1:${h};--f2:${b}`;
}

/**
 * Les images arrivent en fondu sur ce fond, plutôt que d'apparaître d'un bloc.
 *
 * `pressee` pour ce qui est certainement au-dessus de la ligne de flottaison :
 * la une et l'ouverture du lecteur. Les différer là n'économise rien et laisse
 * le fond d'attente en place une seconde de trop, juste sous les yeux.
 */
const imgFondue = (src, { pressee = false } = {}) => `<img class="fondu" src="${esc(src)}" alt=""` +
  (pressee ? ' loading="eager" fetchpriority="high"' : ' loading="lazy"') + ' decoding="async">';

/* Pendant une recherche, le chapô cède la place au passage qui correspond,
   le mot cherché en évidence. FTS5 l'entoure de deux caractères de contrôle :
   on échappe le texte d'abord, on pose les balises ensuite — sinon un article
   qui contient « <b> » ouvrirait une balise pour de bon. */
const DEBUT_MARQUE = String.fromCharCode(2);
const FIN_MARQUE = String.fromCharCode(3);
const MARQUE = new RegExp(DEBUT_MARQUE + '([\\s\\S]*?)' + FIN_MARQUE, 'g');

function chapo(a) {
  if (a.extrait) {
    // FTS5 rend le passage de la colonne qui correspond le mieux : quand c'est
    // le titre, l'extrait répéterait le titre juste au-dessus. On garde alors
    // le chapô, qui apprend quelque chose.
    const nu = a.extrait.replaceAll(DEBUT_MARQUE, '').replaceAll(FIN_MARQUE, '').replace(/^…|…$/g, '').trim();
    if (nu && !String(a.title || '').includes(nu)) {
      return esc(a.extrait).replace(MARQUE, '<mark>$1</mark>');
    }
  }
  return esc(a.summary || '');
}

/** Les étiquettes d'un article, telles qu'elles s'affichent dans une carte. */
const pastilles = (a) => (a.tags || [])
  .map((nom) => `<span class="art-etiq" style="background:${esc(couleurTag(nom))}">${esc(nom)}</span>`)
  .join('');

/* Le conteneur est toujours posé, même vide (il se cache tout seul) : c'est ce
   qui permet de rafraîchir une carte sans la reconstruire, donc sans faire
   sauter la page sous le curseur. */
const puces = (a) => `<span class="art-etiqs">${pastilles(a)}</span>`;

function majPuces(a) {
  $$(`.art[data-id="${a.id}"] .art-etiqs`).forEach((el) => { el.innerHTML = pastilles(a); });
}

/* --- les blocs de la mise en page « la une » ----------------------------- */

function blocUne(a) {
  const couleur = teinte(a.feed_title);
  const fond = a.image
    ? imgFondue(relais(a.image), { pressee: true })
    : `<div class="plaque-initiale" style="color:${rgba(couleur, .2)}">${esc(initialeDe(a))}</div>`;

  return `
    <div class="bloc une art${classeLue(a)}${curseur(a)}" ${attrs(a)} style="--teinte:${couleur};${fondImage(a)}">
      ${fond}
      <div class="une-voile"></div>
      <div class="une-tampon">La une</div>
      <div class="une-corps">
        <div class="une-sur">${surtitre(a)}</div>
        <h2 class="une-titre">${esc(a.title)}</h2>
        ${a.summary || a.extrait ? `<p class="une-chapo">${chapo(a)}</p>` : ''}
        ${puces(a)}
      </div>
    </div>`;
}

function blocColonnes(liste) {
  return `<div class="bloc cols">${liste.map((a) => `
    <article class="col art${classeLue(a)}${curseur(a)}" ${attrs(a)}>
      <div class="sur">${pastilleDossier(a)}${esc(a.feed_title)} <span class="quand">· ${esc(quand(a.published_at))}</span></div>
      <h3 class="col-titre">${lien(a)}</h3>
      <div class="wipe"></div>
      ${a.summary || a.extrait ? `<p class="chapo">${chapo(a)}</p>` : ''}
      <div class="col-pied">${esc(laDuree(a) || 'à lire')}${puces(a)}</div>
    </article>`).join('')}</div>`;
}

function blocMur(liste) {
  return `<div class="bloc wall">${liste.map((a) => {
    const badge = estVideo(a)
      ? `<span class="badge video">▶ ${esc(duree(a.duration) || 'vidéo')}</span>`
      : estAudio(a)
        ? `<span class="badge audio">◆ ${esc(duree(a.duration))}</span>`
        // Une image dans un mur d'images n'a pas besoin qu'on la dise image.
        // La pastille ne sert qu'à annoncer ce qui ne se voit pas : une durée.
        : '';
    return `
      <article class="tuile art${classeLue(a)}${curseur(a)}" ${attrs(a)} style="${fondImage(a)}">
        ${imgFondue(relais(a.image))}
        <span class="tuile-voile"></span>
        ${badge}
        <span class="tuile-corps">
          <span class="tuile-sur">${pastilleDossier(a)}${esc(a.feed_title)} · ${esc(quand(a.published_at))}</span>
          <span class="tuile-titre">${lien(a)}</span>
          ${puces(a)}
        </span>
      </article>`;
  }).join('')}</div>`;
}

const initialeDe = (a) => (String(a.title).match(/[\p{L}\p{N}]/u)?.[0] || '§').toUpperCase();

function blocAplats(liste) {
  if (!liste.length) return '';
  // L'aplat large va de préférence à un article dont le texte complet est là.
  const large = liste.find((a) => a.has_full) || liste[0];
  const plaques = liste.filter((a) => a !== large);
  const couleur = teinte(large.feed_title);

  const bloc = `
    <article class="aplat art${classeLue(large)}${curseur(large)}" ${attrs(large)}
            style="--teinte:${couleur};color:${contraste(couleur)}">
      <span class="aplat-initiale">${esc(initialeDe(large))}</span>
      <span class="sur">${pastilleDossier(large)}${esc(large.feed_title)} · ${esc(quand(large.published_at))}
        ${large.has_full ? '<span class="aplat-badge">Texte complet</span>' : ''}</span>
      <span class="aplat-titre">${lien(large)}</span>
      <span class="aplat-pied">
        ${large.summary || large.extrait ? `<span class="aplat-chapo">${chapo(large)}</span>` : '<span></span>'}
        <span class="aplat-duree">${puces(large)}${esc(laDuree(large))}</span>
      </span>
    </article>`;

  return `<div class="bloc aplats">${bloc}${plaques.map(blocPlaque).join('')}</div>`;
}

function blocPlaque(a, i = 0) {
  const couleur = teinte(a.feed_title);
  const sombre = i % 2 === 1;
  return `
    <article class="plaque art ${sombre ? 'sombre' : 'claire'}${classeLue(a)}${curseur(a)}" ${attrs(a)}
            style="--teinte:${couleur};--teinte-douce:${rgba(couleur, .22)}">
      <span class="plaque-initiale">${esc(initialeDe(a))}</span>
      <span class="plaque-source">${esc(a.feed_title)}</span>
      <span class="plaque-corps">
        <span class="sur">${pastilleDossier(a)}${esc(quand(a.published_at))} · sans illustration</span>
        <span class="plaque-titre">${lien(a)}</span>
        <span class="wipe"></span>
        <span class="plaque-pied">${esc(laDuree(a) || 'texte indisponible')}${puces(a)}</span>
      </span>
    </article>`;
}

function blocFils(liste) {
  return `
    <div class="bloc">
      <div class="fils-titre">
        <span>Dépêches</span>
        <span class="rule"></span>
        <span class="reste">${nombre(liste.length)} à lire</span>
      </div>
      <div class="fils">${liste.map((a) => `
        <article class="fil art${classeLue(a)}${curseur(a)}" ${attrs(a)}>
          <span class="fil-heure">${esc(heure(a.published_at))}</span>
          <span class="fil-titre">${lien(a)}</span>
          ${puces(a)}
          <span class="fil-source">${esc(a.feed_title)}</span>
        </article>`).join('')}</div>
    </div>`;
}

/**
 * Découpe la liste en blocs de journal. Les blocs qui ont besoin d'une image
 * la réclament en priorité, sans jamais bloquer si personne n'en a.
 */
function composerUne(articles, { une = true } = {}) {
  const reste = articles.slice();
  const blocs = [];

  const prendre = (n, pref) => {
    const pris = [];
    if (pref) {
      for (let i = 0; i < reste.length && pris.length < n; i++) {
        if (pref(reste[i])) pris.push(...reste.splice(i--, 1));
      }
    }
    while (pris.length < n && reste.length) pris.push(reste.shift());
    return pris;
  };

  const avecImage = (a) => Boolean(a.image);
  const sansImage = (a) => !a.image;

  // La une n'a lieu qu'une fois, en tête d'édition : une page qui s'ajoute
  // en dessous reprend le rythme à la rangée de colonnes.
  let premier = une;
  while (reste.length) {
    if (premier) {
      blocs.push({ type: 'une', liste: prendre(1, avecImage) });
      premier = false;
    }
    const avant = reste.length;

    const cols = prendre(4);
    if (cols.length) blocs.push({ type: 'cols', liste: cols });

    const mur = prendre(3, avecImage).filter(avecImage);
    if (mur.length === 3) blocs.push({ type: 'wall', liste: mur });
    else reste.unshift(...mur);

    const aplats = prendre(3, sansImage);
    if (aplats.length) blocs.push({ type: 'aplats', liste: aplats });

    const fils = prendre(6);
    if (fils.length) blocs.push({ type: 'fils', liste: fils });

    if (reste.length === avant) break;
  }
  return blocs;
}

/* ------------------------------------------------------------ rendu du flux */

/** Le HTML d'une tranche d'articles, dans la mise en page courante. */
function htmlDesArticles(liste, decalage) {
  if (state.layout === 'compact') return liste.map(ligneDepeche).join('');
  if (state.layout === 'list') return liste.map((a, i) => ligneSommaire(a, decalage + i)).join('');
  return composerUne(liste, { une: decalage === 0 }).map((b) => {
    if (b.type === 'une') return b.liste.length ? blocUne(b.liste[0]) : '';
    if (b.type === 'cols') return blocColonnes(b.liste);
    if (b.type === 'wall') return blocMur(b.liste);
    if (b.type === 'aplats') return blocAplats(b.liste);
    return blocFils(b.liste);
  }).join('');
}

/**
 * Rend la liste. `depuis` dit à partir de quel article elle a changé : une
 * page de plus s'ajoute à la fin, tout le reste se recompose.
 *
 * Sans ça, la dixième page régénérait les trois cent quarante cartes déjà
 * posées pour en montrer trente-quatre — et chaque image déjà chargée
 * rejouait son fondu.
 */
function renderFlux({ depuis = 0 } = {}) {
  const flux = $('#flux');
  const memeMiseEnPage = flux.className === 'flux ' + CLASSE_LAYOUT[state.layout];
  flux.className = 'flux ' + CLASSE_LAYOUT[state.layout];

  indexParId = new Map(state.articles.map((a, i) => [a.id, i]));

  if (!state.articles.length) {
    flux.innerHTML = etatVide();
    $('#endNote').hidden = true;
    return;
  }

  // On n'ajoute que si ce qui est en place est bien le début de la même liste :
  // un squelette, un état vide ou un changement de mise en page repartent de zéro.
  const ajout = depuis > 0 && memeMiseEnPage && flux.firstElementChild
    && !$('.empty', flux) && !$('.sk', flux);
  const tranche = ajout ? state.articles.slice(depuis) : state.articles;
  const html = htmlDesArticles(tranche, ajout ? depuis : 0);

  let neufs;
  if (ajout) {
    const avant = flux.children.length;
    flux.insertAdjacentHTML('beforeend', html);
    neufs = [...flux.children].slice(avant);
  } else {
    flux.innerHTML = html;
    neufs = [flux];
  }

  $('#endNote').hidden = !state.done;

  // Une illustration qui ne charge pas laisse la place à son fond d'attente,
  // qui devient alors l'illustration : mieux qu'une icône cassée.
  for (const racine of neufs) {
    $$('img', racine).forEach((img) => {
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; }, { once: true });
    });
    rattraperImages(racine);
  }
}

function ligneSommaire(a, i) {
  const couleur = teinte(a.feed_title);
  const vignette = a.image ? imgFondue(relais(a.image)) : '';
  return `
    <article class="som art${classeLue(a)}${curseur(a)}" ${attrs(a)}>
      <span class="som-num">${String(i + 1).padStart(2, '0')}</span>
      <span>
        <span class="sur">${pastilleDossier(a)}${esc(a.feed_title)} <span class="quand">· ${esc(quand(a.published_at))}${laDuree(a) ? ' · ' + esc(laDuree(a)) : ''}</span></span>
        <span class="som-titre">${lien(a)}</span>
        ${a.summary || a.extrait ? `<span class="som-chapo">${chapo(a)}</span>` : ''}
        ${puces(a)}
      </span>
      <span class="som-thumb" style="--teinte:${couleur};${fondImage(a)}">${vignette}</span>
    </article>`;
}

function ligneDepeche(a) {
  return `
    <article class="dep art${classeLue(a)}${curseur(a)}" ${attrs(a)}>
      <span class="dep-puce" aria-hidden="true"></span>
      <span class="dep-heure">${esc(heure(a.published_at))}</span>
      <span class="dep-titre">${lien(a)}</span>
      ${puces(a)}
      <span class="dep-source">${esc(a.feed_title)}</span>
      <span class="dep-duree">${esc(a.duration ? '◆ ' + Math.round(a.duration / 60) + ' min' : '')}</span>
    </article>`;
}

function etatVide() {
  if (state.q) {
    return `<div class="empty"><h2>Rien pour « ${esc(state.q)} »</h2>
      <p>Essaie un autre mot, ou élargis la vue à « Tout ».</p>
      <div class="empty-actions"><button class="btn" data-clear-search>Effacer</button></div></div>`;
  }
  if (!state.feeds.length) {
    return `<div class="empty">
      <h2>Le kiosque est vide</h2>
      <p>Ajoute une source, ou importe ton export OPML pour tout récupérer d’un coup.</p>
      <div class="empty-actions">
        <button class="btn solid" data-add-feed>＋ Ajouter une source</button>
        <button class="btn" data-import-opml>Importer un OPML</button>
      </div>
      <div class="suggestions">
        <h3>Pour commencer</h3>
        <div class="suggestion-grid">
          ${SUGGESTIONS.map((s, i) => `<button class="suggestion" data-suggest="${i}">
            <span>${esc(s.title)}</span><span class="plus">＋</span></button>`).join('')}
        </div>
      </div></div>`;
  }
  if (state.view === 'unread') {
    return `<div class="empty"><h2>Tout est lu</h2>
      <p>Belle discipline. Reviens plus tard, ou relis ce qui est passé.</p>
      <div class="empty-actions">
        <button class="btn" data-goto-view="all">Voir tout</button>
        <button class="btn" data-refresh>Rafraîchir</button>
      </div></div>`;
  }
  if (state.view === 'starred') {
    return `<div class="empty"><h2>Aucun favori</h2>
      <p>Appuie sur <kbd>S</kbd> sur un article pour le garder sous la main.</p></div>`;
  }
  if (state.view === 'edition') {
    return `<div class="empty"><h2>Pas d’édition aujourd’hui</h2>
      <p>Elle se compose à partir des sources suivies, avec ce qui est arrivé ces
         derniers jours. Rafraîchis, ou va voir dans « Tout ».</p>
      <div class="empty-actions">
        <button class="btn" data-refresh>Rafraîchir</button>
        <button class="btn" data-goto-view="all">Voir tout</button>
      </div></div>`;
  }
  return `<div class="empty"><h2>Rien à afficher</h2>
    <div class="empty-actions"><button class="btn" data-refresh>Rafraîchir</button></div></div>`;
}

/* ------------------------------------------------------------------ vues */

function setView({ view, feedId = null, folder = null, tag = null }) {
  state.view = view ?? state.view;
  state.feedId = feedId;
  state.folder = folder;
  state.tag = tag;
  closeRail();
  renderIndex();
  ecrireAdresse();
  loadArticles(true);
}

/* ------------------------------------------------------------- l'adresse */

/* Seul l'article ouvert tenait dans l'adresse : recharger la page revenait
   aux non-lus, le bouton « précédent » ne faisait rien, et une recherche ne
   se mettait pas en marque-page. L'adresse dit maintenant ce qu'on regarde.

     #/unread                     #/source/17            #/source/17/all
     #/dossier/Tech               #/etiquette/veille     #/recherche/quebec
     #/unread/article/482         #/article/482          (l'ancienne forme)  */

const VUES = ['unread', 'all', 'starred', 'survol', 'edition'];

function hashDeLEtat() {
  // La vue n'accompagne une source, un dossier ou une étiquette que si elle
  // n'est pas celle par défaut : une adresse courte se lit mieux.
  const vue = state.view !== 'unread' ? '/' + state.view : '';
  let base;
  if (state.q) base = '/recherche/' + encodeURIComponent(state.q);
  else if (state.feedId) base = '/source/' + state.feedId + vue;
  else if (state.tag) base = '/etiquette/' + encodeURIComponent(state.tag) + vue;
  else if (state.folder) base = '/dossier/' + encodeURIComponent(state.folder) + vue;
  else base = '/' + state.view;
  return '#' + base + (state.openId ? '/article/' + state.openId : '');
}

/** Vrai le temps d'écrire nous-mêmes : on ne réagit pas à notre propre trace. */
let ecritureInterne = false;

function ecrireAdresse({ remplacer = false } = {}) {
  const cible = hashDeLEtat();
  if (location.hash === cible) return;
  ecritureInterne = true;
  if (remplacer) history.replaceState(null, '', cible);
  else history.pushState(null, '', cible);
  ecritureInterne = false;
}

/** Les écrans qui ne sont pas des vues : ils gardent leur adresse à eux. */
const ECRANS = { '#/tags': ouvrirGestionTags, '#/reglages': ouvrirReglages, '#/shortcuts': () => openModal('#shortcutsModal') };

function lireAdresse(hash = location.hash) {
  const morceaux = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const etat = { view: 'unread', feedId: null, folder: null, tag: null, q: '', openId: null };

  // L'article se lit à la fin, quelle que soit la liste qui le porte — et
  // « #/article/482 » tout court reste une adresse valable.
  const i = morceaux.indexOf('article');
  if (i >= 0) {
    etat.openId = Number(morceaux[i + 1]) || null;
    morceaux.splice(i);
  }

  const [quoi, valeur, vue] = morceaux;
  const val = valeur ? decodeURIComponent(valeur) : '';
  if (quoi === 'source') etat.feedId = Number(val) || null;
  else if (quoi === 'dossier') etat.folder = val || null;
  else if (quoi === 'etiquette') etat.tag = val || null;
  else if (quoi === 'recherche') { etat.q = val; etat.view = 'all'; }
  else if (VUES.includes(quoi)) etat.view = quoi;
  if (VUES.includes(vue)) etat.view = vue;
  return etat;
}

/** Applique ce que dit l'adresse, sans la réécrire. */
function appliquerAdresse(etat) {
  const memeListe = etat.view === state.view && etat.feedId === state.feedId
    && etat.folder === state.folder && etat.tag === state.tag && etat.q === state.q;

  if (!memeListe) {
    Object.assign(state, { view: etat.view, feedId: etat.feedId, folder: etat.folder, tag: etat.tag, q: etat.q });
    $('#search').value = etat.q;
    renderIndex();
    loadArticles(true);
  }
  if (etat.openId && etat.openId !== state.openId) openArticle(etat.openId);
  else if (!etat.openId && state.openId) closeReader();
}

function applyLayout(layout) {
  state.layout = layout;
  $('#flux').className = 'flux ' + CLASSE_LAYOUT[layout];
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.layout === layout));
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('bublee.theme', theme);
}

function applyAccent(accent) {
  if (!accent) return;
  document.documentElement.style.setProperty('--accent', accent);
  localStorage.setItem('bublee.accent', accent);
  state.settings.accent = accent;
}

/* --------------------------------------------------------------- lecteur */

/**
 * `enchaine` : on vient d'un autre article (touche J, lien « suivant », glissé)
 * plutôt que de la liste. C'est ce qui distingue « revenir en arrière » de
 * « fermer » quand on glisse vers la droite.
 */
/* Les voisins, demandés d'avance.
   Au relâchement du doigt il ne doit plus rester que l'animation à faire. Tant
   que l'article suivant se téléchargeait à cet instant précis, le geste se
   figeait à mi-course, le temps d'un aller-retour réseau. On le demande donc
   pendant la lecture, avant que le doigt ne parte. */

const VOISINS_MAX = 16;
const enMain = new Map();   // id -> Promise<article>

function retenir(id, promesse) {
  enMain.delete(id);                       // le remettre en queue : les plus
  enMain.set(id, promesse);                // anciens sortent les premiers
  while (enMain.size > VOISINS_MAX) enMain.delete(enMain.keys().next().value);
  promesse.catch(() => enMain.delete(id)); // un échec ne se garde pas
  return promesse;
}

function chargerArticle(id) {
  return retenir(id, enMain.get(id) || api.article(id));
}

/** Vrai si l'article est déjà en main : le passage se fera sans attendre. */
const dejaEnMain = (id) => enMain.has(id);

/** L'image d'ouverture, mise au chaud dans le cache du navigateur. Avoir le
    texte en main ne sert à rien si la photo, elle, se télécharge encore
    pendant le passage : c'est elle qui occupe la moitié haute de l'écran. */
function prechargerImage(a) {
  if (!a || !a.image) return;
  const img = new Image();
  img.decoding = 'async';
  img.src = relais(a.image);
}

/** Deux articles d'avance plutôt qu'un : à lire vite, on rattrapait la
    préparation, et le glissé retombait sur une attente. */
const AVANCE = 2;

function preparerVoisins() {
  const i = state.articles.findIndex((a) => a.id === state.openId);
  if (i < 0) return;
  const autour = [];
  for (let n = 1; n <= AVANCE; n++) if (state.articles[i + n]) autour.push(state.articles[i + n]);
  if (i > 0) autour.push(state.articles[i - 1]);
  for (const v of autour) {
    if (enMain.has(v.id)) continue;
    chargerArticle(v.id).then(prechargerImage, () => {});
  }
}

async function openArticle(id, { enchaine = false } = {}) {
  state.profondeur = enchaine ? state.profondeur + 1 : 0;
  const index = indexParId.get(id);
  if (index !== undefined) setPointer(index, false);
  state.openId = id;
  ecrireAdresse({ remplacer: true });

  $('#readerShade').hidden = false;
  // Le panneau ne s'annonce qu'en venant de la liste. Enchaîné — glissé, touche
  // J, lien « suivant » — il est déjà là : seul son contenu change, et rejouer
  // son entrée écraserait l'animation du passage.
  $('#reader').style.animation = enchaine ? 'none' : '';
  $('#reader').hidden = false;
  $('#readerScroll').innerHTML = '';
  document.body.style.overflow = 'hidden';

  try {
    const article = await chargerArticle(id);
    if (state.openId !== id) return;
    renderReader(article);
    // Sans attendre : la requête part maintenant, son aller-retour recouvre une
    // animation qui de toute façon ne fait rien d'autre, et la lecture du JSON à
    // l'arrivée se compte en millisecondes. Différer était l'erreur inverse : à
    // lire vite, on rattrapait la préparation et le glissé butait sur elle.
    preparerVoisins();
    if (!article.read_at) { await marquerLu(id, true); article.read_at = Date.now(); }
    // Le texte complet remplacera le corps : la version courte ne vaut plus.
    if (article.should_fetch_full) { enMain.delete(id); completerArticle(article); }
  } catch (error) {
    toast('Article illisible : ' + error.message, 'bad');
    closeReader();
  }
}

function renderReader(a) {
  state.ouvert = a;
  const suivant = articleSuivant();
  const video = estVideo(a);
  const couleur = teinte(a.feed_title);

  $('#readerStar').classList.toggle('on', Boolean(a.starred));
  $('#readerFull').hidden = video || !a.url;
  const lien = $('#readerOpen');
  lien.href = a.url || '#';
  lien.hidden = !a.url;

  const d = video ? '' : laDuree(a);
  $('#readerInfos').textContent = [a.feed_title, d, a.word_count ? nombre(a.word_count) + ' mots' : '']
    .filter(Boolean).join(' · ');

  const meta = [esc(quand(a.published_at)), a.author ? esc(a.author) : '', a.url ? esc(hote(a.url)) : '']
    .filter(Boolean).join(' · ');

  const ouverture = a.image && !video
    ? `<div class="reader-hero" style="${fondImage(a)}">
         ${imgFondue(relais(a.image), { pressee: true })}
         <div class="voile"></div>
         <div class="reader-hero-corps"><div class="reader-hero-inner">
           ${a.has_full ? '<span class="reader-badge">Texte complet</span>' : ''}
           <div class="reader-meta">${meta}</div>
           <h1 class="reader-titre">${esc(a.title)}</h1>
         </div></div>
       </div>`
    : `<div class="reader-hero plaque-hero${video ? ' hero-video' : ''}"
            style="--teinte:${couleur};--sur-plaque:${contraste(couleur)}">
         <span class="plaque-initiale">${esc(initialeDe(a))}</span>
         <div class="reader-hero-corps"><div class="reader-hero-inner">
           ${a.has_full ? '<span class="reader-badge">Texte complet</span>' : ''}
           <div class="reader-meta">${meta}</div>
           <h1 class="reader-titre">${esc(a.title)}</h1>
         </div></div>
       </div>`;

  const corps = a.content && a.content.length > 40
    ? a.content
    : `<p>${esc(a.summary || 'Cet article ne fournit pas de contenu dans son flux.')}</p>`;

  const sources = a.also_in?.length
    ? `<p class="reader-sources">Aussi publié par ${a.also_in.map((s) => esc(s.feed_title)).join(', ')}</p>`
    : '';

  $('#readerScroll').innerHTML = `
    ${ouverture}
    <div class="reader-inner">
      <div class="tag-editor" id="tagEditor">${editeurTags(a)}</div>
      ${sources}
      <div class="full-state" id="fullState" hidden></div>
      <div class="reader-body">${corps}</div>
      <div class="reader-end">
        ${suivant ? `<button class="btn solid" data-next="${suivant.id}">Suivant →</button>` : ''}
        ${suivant ? `<span class="next-hint">${esc(suivant.title.slice(0, 60))}</span>` : ''}
      </div>
    </div>`;

  $('#readerScroll').scrollTop = 0;
  rattraperImages($('#readerScroll'));
  $('#readerProgress').style.width = '0%';

  // Toute image passe par le relais : la CSP n'en admet pas d'autre origine.
  // Les <source> d'un <picture> pointent chez l'éditeur : on les retire, l'<img>
  // en dessous suffit.
  $$('.reader-body picture source', $('#readerScroll')).forEach((s) => s.remove());
  $$('.reader-body video[poster]', $('#readerScroll')).forEach((v) => {
    const poster = v.getAttribute('poster');
    if (poster && !poster.startsWith('data:') && !poster.startsWith('/api/image')) v.poster = relais(poster);
  });
  $$('.reader-body img, .reader-hero img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (src && !src.startsWith('data:') && !src.startsWith('/api/image')) {
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      img.src = relais(src);
    }
    img.addEventListener('error', () => { img.style.display = 'none'; }, { once: true });
  });

  detournerLAudio(a);

  const premier = $$('.reader-body p').find((p) => {
    const t = p.textContent.trim();
    return t.length > 90 && !p.querySelector('img') && /^[\p{L}\p{N}]/u.test(t);
  });
  premier?.classList.add('lettrine');
}

function editeurTags(a) {
  const chips = (a.tags || []).map((nom) => `
    <span class="tag-chip" style="--teinte:${esc(couleurTag(nom))}">
      <button class="tag-jump" data-goto-tag="${esc(nom)}">${esc(nom)}</button>
      <button class="tag-off" data-untag="${esc(nom)}" aria-label="Retirer">✕</button>
    </span>`).join('');
  return chips + `
    <span class="actions-icones">
      <button type="button" id="readerTagBtn" title="Étiqueter (T)" aria-label="Étiqueter">
        <svg aria-hidden="true"><use href="#g-etiquette"/></svg>
      </button>
      <button type="button" id="readerShareBtn" title="Partager (P)" aria-label="Partager">
        <svg aria-hidden="true"><use href="#g-partage"/></svg>
      </button>
    </span>`;
}

async function etiqueter(id, action) {
  try {
    const article = await api.tag(id, action);
    const local = state.articles.find((a) => a.id === id);
    if (local) local.tags = article.tags;
    if (state.ouvert?.id === id) state.ouvert.tags = article.tags;
    if (state.openId === id) $('#tagEditor').innerHTML = editeurTags(article);
    majCompteurs(article);
    majPuces(article);
    if (popId === id) renderPopTags();
  } catch (error) {
    toast('Étiquette : ' + error.message, 'bad');
  }
}

/* ------------------------------------------- étiqueter sans ouvrir l'article */

let popId = null;

/** Colle le bouton au coin bas-droit de la carte survolée : en haut il passait
    sur le surtitre. Il vit dans le scroller, donc il suit la page sans qu'on
    ait à le repositionner au défilement. */
let carteSurvolee = null;

/** Marque la carte visée. On ne peut pas s'appuyer sur `:hover` : le bouton vit
    à côté de la carte, pas dedans, donc dès que la souris l'atteint la carte
    perdrait son survol — et la méta qu'on venait d'effacer réapparaîtrait sous
    le bouton. */
function marquerSurvol(carte) {
  if (carteSurvolee === carte) return;
  carteSurvolee?.classList.remove('survol');
  carteSurvolee = carte;
  carte?.classList.add('survol');
}

function survolCarte(carte) {
  const zone = $('#artActions');
  if (popId !== null || partageId !== null) return;  // un popover ouvert le fige
  if (!carte) { zone.hidden = true; marquerSurvol(null); return; }
  marquerSurvol(carte);

  const scroller = $('#scroller');
  const r = carte.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  zone.hidden = false;
  zone.dataset.id = carte.dataset.id;
  zone.classList.toggle('sur-depeche', carte.classList.contains('dep'));

  // Bas-droit dans un bloc ; centré à droite dans une ligne de dépêche, trop
  // basse pour qu'un coin veuille dire quelque chose.
  const h = zone.offsetHeight;
  const y = r.height > h + 16 ? r.bottom - h - 8 : r.top + (r.height - h) / 2;
  zone.style.top = Math.round(y - s.top + scroller.scrollTop) + 'px';
  zone.style.left = Math.round(r.right - s.left - zone.offsetWidth - 8) + 'px';
}

/** Un article ouvert par lien profond n'est pas dans la liste courante. */
const articleParId = (id) => state.articles.find((a) => a.id === id)
  || (state.ouvert?.id === id ? state.ouvert : null);

function renderPopTags() {
  const a = articleParId(popId);
  if (!a) return;
  const posees = new Set(a.tags || []);

  $('#tagPopTitre').textContent = a.title;
  $('#tagPopList').innerHTML = state.tags.length
    ? state.tags.map((t) => `
        <button type="button" class="tagpop-row${posees.has(t.name) ? ' on' : ''}"
                data-pop-tag="${esc(t.name)}" style="--teinte:${esc(t.color || 'var(--accent)')}">
          <span class="tag-square" aria-hidden="true"></span>
          <span class="tagpop-nom">${esc(t.name)}</span>
          <span class="tagpop-coche" aria-hidden="true">${posees.has(t.name) ? '✓' : ''}</span>
        </button>`).join('')
    : '<p class="tagpop-vide">Aucune étiquette encore. Tape un nom ci-dessous.</p>';
}

function ouvrirPopTags(id, ancre) {
  if (!articleParId(id)) return;
  fermerPartage();
  popId = id;
  const pop = $('#tagPop');
  pop.hidden = false;
  renderPopTags();

  poserContre(pop, ancre);

  $('#tagPopInput').value = '';
  $('#tagPopInput').focus();
}

function fermerPopTags() {
  if (popId === null) return;
  popId = null;
  $('#tagPop').hidden = true;
  $('#artActions').hidden = true;
  marquerSurvol(null);
}

/* ------------------------------------------------------------- partager --- */

let partageId = null;

/** Pose un popover contre son ancre : dessous s'il y a la place, dessus sinon. */
function poserContre(pop, ancre) {
  const r = ancre.getBoundingClientRect();
  const l = pop.offsetWidth;
  const h = pop.offsetHeight;
  pop.style.left = Math.round(Math.min(Math.max(10, r.right - l), innerWidth - l - 10)) + 'px';
  pop.style.top = Math.round(r.bottom + 8 + h < innerHeight ? r.bottom + 8 : Math.max(10, r.top - 8 - h)) + 'px';
}

function ouvrirPartage(id, ancre) {
  const a = articleParId(id);
  if (!a || !a.url) { toast('Cet article n’a pas de lien à partager.', 'bad'); return; }
  fermerPopTags();
  partageId = id;

  const pop = $('#sharePop');
  $('#sharePopTitre').textContent = a.title;
  // La feuille de partage du système n'existe pas partout : on ne propose la
  // ligne que si le navigateur la porte vraiment.
  $('[data-partage="systeme"]', pop).hidden = typeof navigator.share !== 'function';
  pop.hidden = false;
  poserContre(pop, ancre);
  $('[data-partage]:not([hidden])', pop)?.focus();
}

function fermerPartage() {
  if (partageId === null) return;
  partageId = null;
  $('#sharePop').hidden = true;
  $('#artActions').hidden = true;
  marquerSurvol(null);
}

/**
 * Ouvre un protocole applicatif (sgnl://). S'il n'est enregistré nulle part, le
 * navigateur ne signale rien : on guette la perte de focus, qui signe la prise
 * en charge par une application, et on prévient si elle ne vient pas.
 */
function ouvrirProtocole(href, secours) {
  let pris = false;
  const marquer = () => { pris = true; };
  addEventListener('blur', marquer, { once: true });
  addEventListener('pagehide', marquer, { once: true });
  document.addEventListener('visibilitychange', marquer, { once: true });
  location.href = href;
  setTimeout(() => {
    removeEventListener('blur', marquer);
    removeEventListener('pagehide', marquer);
    document.removeEventListener('visibilitychange', marquer);
    if (!pris) toast(secours, 'bad');
  }, 1600);
}

/**
 * Ouvre le canal choisi avec l'article pré-rempli. Rien n'est envoyé d'ici :
 * chaque destination ouvre sa propre fenêtre de rédaction, c'est toi qui postes.
 */
async function partager(canal) {
  const a = articleParId(partageId);
  if (!a) return;
  const titre = a.title;
  const lien = a.url;
  const texte = `${titre}\n${lien}`;

  if (canal === 'copier') {
    try {
      await navigator.clipboard.writeText(lien);
      toast('Lien copié.');
    } catch (error) {
      toast('Copie refusée par le navigateur : ' + error.message, 'bad');
    }
    fermerPartage();
    return;
  }

  if (canal === 'systeme') {
    try {
      await navigator.share({ title: titre, text: titre, url: lien });
    } catch (error) {
      // L'utilisateur qui referme la feuille lève AbortError : ce n'est pas une panne.
      if (error.name !== 'AbortError') toast('Partage : ' + error.message, 'bad');
    }
    fermerPartage();
    return;
  }

  const destinations = {
    mail: () => {
      location.href = `mailto:?subject=${encodeURIComponent(titre)}&body=${encodeURIComponent(texte)}`;
    },
    whatsapp: () => window.open('https://wa.me/?text=' + encodeURIComponent(texte), '_blank', 'noopener'),
    telegram: () => window.open(
      `https://t.me/share/url?url=${encodeURIComponent(lien)}&text=${encodeURIComponent(titre)}`,
      '_blank', 'noopener'
    ),
    // Signal n'a pas d'adresse web de partage : on passe par le protocole que
    // l'application installe. S'il n'est enregistré nulle part, rien ne se
    // passerait en silence — d'où le garde-fou.
    signal: () => ouvrirProtocole(
      'sgnl://send?text=' + encodeURIComponent(texte),
      'Signal n’a pas répondu — l’application n’est peut-être pas installée. Essaie « Partager… » ou copie le lien.'
    )
  };
  destinations[canal]?.();
  fermerPartage();
}

/** Ouvre le partage sur l'article au curseur — ce que fait `P` hors lecteur. */
function partageSurCurseur() {
  const id = articleCourant();
  if (id === null) return;
  // Lecteur ouvert : on s'ancre à sa barre, la carte est cachée derrière.
  const ancre = state.openId === id ? $('.reader-bar') : $(`.art[data-id="${id}"]`);
  if (ancre) ouvrirPartage(id, ancre);
}

/** Ouvre le popover sur l'article au curseur — c'est ce que fait `T` hors lecteur. */
function popSurCurseur() {
  const id = articleCourant();
  const carte = id !== null ? $(`.art[data-id="${id}"]`) : null;
  if (!carte) return;
  ouvrirPopTags(id, carte);
}

async function completerArticle(article, force = false) {
  const zone = $('#fullState');
  if (zone) { zone.hidden = false; zone.textContent = 'Récupération du texte complet…'; }
  try {
    const complet = await api.full(article.id, force);
    if (state.openId !== article.id) return;
    renderReader(complet);
  } catch (error) {
    if (state.openId !== article.id) return;
    const el = $('#fullState');
    if (!el) return;
    el.hidden = false;
    el.innerHTML = `Texte complet indisponible — ${esc(error.message)} <button class="link-btn" data-retry>réessayer</button>`;
  }
}

function articleSuivant() {
  const i = state.articles.findIndex((a) => a.id === state.openId);
  return i >= 0 ? state.articles[i + 1] : null;
}

function articlePrecedent() {
  const i = state.articles.findIndex((a) => a.id === state.openId);
  return i > 0 ? state.articles[i - 1] : null;
}

function closeReader() {
  fermerPopTags();
  fermerPartage();
  state.openId = null;
  state.ouvert = null;
  ecrireAdresse({ remplacer: true });
  $('#reader').hidden = true;
  $('#readerShade').hidden = true;
  document.body.style.overflow = '';
}

/* ------------------------------------------------ lu / non lu / favoris */

function patchLocal(id, patch) {
  const a = state.articles.find((x) => x.id === id);
  if (!a) return;
  Object.assign(a, patch);
  const el = $(`.art[data-id="${id}"]`);
  if (el) el.classList.toggle('read', Boolean(a.read_at));
}

async function marquerLu(id, lu) {
  patchLocal(id, { read_at: lu ? Date.now() : null });
  try {
    majCompteurs(await api.patch(id, { read: lu }));
  } catch (error) {
    toast('Échec : ' + error.message, 'bad');
  }
}

async function basculerFavori(id) {
  const a = state.articles.find((x) => x.id === id);
  const valeur = a ? !a.starred : true;
  patchLocal(id, { starred: valeur ? 1 : 0 });
  if (state.openId === id) $('#readerStar').classList.toggle('on', valeur);
  try {
    majCompteurs(await api.patch(id, { starred: valeur }));
    toast(valeur ? 'Ajouté aux favoris' : 'Retiré des favoris');
  } catch (error) {
    toast('Échec : ' + error.message, 'bad');
  }
}

/* --------------------------------------------------------------- clavier */

function setPointer(index, scroll = true) {
  const borne = Math.max(0, Math.min(index, state.articles.length - 1));
  $$('.cursor').forEach((c) => c.classList.remove('cursor'));
  state.pointer = borne;
  const el = $(`.art[data-index="${borne}"]`);
  if (el) {
    el.classList.add('cursor');
    if (scroll) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  if (borne > state.articles.length - 8) loadArticles();
}

const articleCourant = () => state.openId ?? state.articles[state.pointer]?.id ?? null;

function onKey(event) {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) {
    if (event.key === 'Escape') event.target.blur();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key;

  if (key === 'Escape') {
    if (!$('#lirePop').hidden) return fermerLirePop();
    if (partageId !== null) return fermerPartage();
    if (popId !== null) return fermerPopTags();
    if (!$('#reader').hidden) return closeReader();
    // Une fenêtre se ferme d'elle-même sur Échap : le navigateur s'en charge.
    if (unModalEstOuvert()) return;
    if (state.q) { $('#search').value = ''; state.q = ''; loadArticles(true); }
    return;
  }

  if (key === '/') { event.preventDefault(); $('#search').focus(); return; }
  if (key === 'a') { event.preventDefault(); openModal('#feedModal'); $('#feedUrl').focus(); return; }
  if (key === 'A') { event.preventDefault(); toutMarquerLu(); return; }
  if (key === 'U' || (key === 'a' && event.shiftKey)) { event.preventDefault(); toutMarquerLu(); return; }
  if (key === 'r') { event.preventDefault(); rafraichir(); return; }
  if (key === '?') { event.preventDefault(); openModal('#shortcutsModal'); return; }
  if (key === ',') { event.preventDefault(); ouvrirReglages(); return; }

  if (key === 'g') {
    event.preventDefault();
    const suite = ['magazine', 'list', 'compact'];
    const next = suite[(suite.indexOf(state.layout) + 1) % suite.length];
    applyLayout(next);
    renderFlux();
    api.settings({ layout: next }).catch(() => {});
    toast({ magazine: 'La une', list: 'Sommaire', compact: 'Dépêches' }[next]);
    return;
  }

  const vues = { 1: 'unread', 2: 'all', 3: 'starred' };
  if (vues[key] && !state.openId) { event.preventDefault(); setView({ view: vues[key] }); return; }

  if (key === 'j' || key === 'ArrowDown') {
    event.preventDefault();
    if (state.openId) { const s = articleSuivant(); if (s) openArticle(s.id, { enchaine: true }); return; }
    setPointer(state.pointer + 1);
    return;
  }
  if (key === 'k' || key === 'ArrowUp') {
    event.preventDefault();
    if (state.openId) {
      const i = state.articles.findIndex((a) => a.id === state.openId);
      if (i > 0) openArticle(state.articles[i - 1].id);
      return;
    }
    setPointer(Math.max(0, state.pointer - 1));
    return;
  }

  const id = articleCourant();
  if (!id) return;

  if (key === 'Enter' || key === 'o') { event.preventDefault(); if (!state.openId) openArticle(id); return; }
  if (key === 's') { event.preventDefault(); basculerFavori(id); return; }
  if (key === 'm') {
    event.preventDefault();
    marquerLu(id, !state.articles.find((a) => a.id === id)?.read_at);
    return;
  }
  if (key === 'v') {
    const a = state.articles.find((x) => x.id === id);
    if (a?.url) window.open(a.url, '_blank', 'noopener');
    return;
  }
  if (key === 'b' && !state.openId) { event.preventDefault(); plierIndex(!indexPlie()); return; }
  if (key === 'p') { event.preventDefault(); partageSurCurseur(); return; }

  // `T` étiquette : le champ du lecteur s'il est ouvert, sinon l'article au curseur.
  if (key === 't') {
    event.preventDefault();
    if (state.openId) ouvrirPopTags(state.openId, $('#readerTag')); else popSurCurseur();
    return;
  }
  if (key === 'f' && state.openId) { event.preventDefault(); completerArticle({ id: state.openId }, true); }
}

/* --------------------------------------------------------------- actions */

async function rafraichir() {
  const btn = $('#refreshBtn');
  btn.textContent = '…';
  try {
    const r = await api.refreshAll();
    await reloadState();
    if (r.added) { toast(`${nombre(r.added)} nouveaux articles`); await loadArticles(true); }
    else toast('Rien de neuf');
    if (r.errors?.length) toast(`${r.errors.length} sources injoignables`, 'bad');
  } catch (error) {
    toast('Rafraîchissement impossible : ' + error.message, 'bad');
  } finally {
    btn.textContent = 'Rafraîchir';
  }
}

/**
 * Marque comme lu ce que la vue montre. `jours` limite aux articles déjà
 * vieux : c'est le geste qu'on veut vraiment neuf fois sur dix, vider ce qui
 * a passé sans toucher à ce qui vient d'arriver.
 */
async function toutMarquerLu(jours = null) {
  const portee = state.feedId ? { feedId: state.feedId } : state.folder ? { folder: state.folder } : { all: true };
  const payload = jours ? { ...portee, olderThan: Date.now() - jours * 86400000 } : portee;
  try {
    const r = await api.markRead(payload);
    majCompteurs(r);
    if (!r.changed) { toast('Déjà tout lu'); return; }
    // Tout le lot porte le même horodatage : l'annulation le rend à NULL.
    toast(`${nombre(r.changed)} articles marqués lus`, '', {
      libelle: 'Annuler',
      faire: () => annulerLecture(r.stamp)
    });
    await loadArticles(true);
  } catch (error) {
    toast('Échec : ' + error.message, 'bad');
  }
}

async function annulerLecture(stamp) {
  try {
    majCompteurs(await api.annulerLecture(stamp));
    toast('Marquage annulé');
    await loadArticles(true);
  } catch (error) {
    toast('Échec : ' + error.message, 'bad');
  }
}

/* -------------------------------------------- la portée de « tout lire » */

function ouvrirLirePop(ancre) {
  fermerPopTags();
  fermerPartage();
  const pop = $('#lirePop');
  $('#lirePopTitre').textContent = state.feedId
    ? 'Marquer lu : ' + titreVue()
    : state.folder ? 'Marquer lu : ' + state.folder : 'Marquer tout comme lu';
  pop.hidden = false;
  poserContre(pop, ancre);
  $('[data-lire]', pop)?.focus();
}

const fermerLirePop = () => { $('#lirePop').hidden = true; };

/* -------------------------------------------------------------- fenêtres */

/* Les fenêtres sont des <dialog> : le navigateur pose lui-même le voile,
   piège le focus à l'intérieur et le rend à ce qui l'avait au moment de
   l'ouverture. C'était trois choses à écrire, et à tenir à jour. */

function openModal(sel) {
  closeModals();
  const fenetre = $(sel);
  if (!fenetre.open) fenetre.showModal();
}

function closeModals() {
  $$('dialog.modal[open]').forEach((m) => m.close());
}

const unModalEstOuvert = () => Boolean($('dialog.modal[open]'));
function closeRail() { $('#app').classList.remove('rail-on'); }

/* ---------------------------------------------------- gestion étiquettes */

function renderTagManager() {
  const palette = state.palette || [];
  $('#tagManager').innerHTML = state.tags.length
    ? state.tags.map((t) => `
      <div class="tag-manage" data-tag-id="${t.id}">
        <div class="tag-manage-head">
          <input class="tag-rename" value="${esc(t.name)}" maxlength="60" aria-label="Nom">
          <span class="tag-usage">${t.count ? nombre(t.count) + ' art.' : 'inutilisée'}</span>
          <button class="tag-delete" aria-label="Supprimer">✕</button>
        </div>
        <div class="tag-palette">
          ${palette.map((c) => `<button class="tag-swatch${t.color === c ? ' on' : ''}" data-color="${esc(c)}"
            style="--teinte:${esc(c)}" aria-label="Teinte"></button>`).join('')}
        </div>
      </div>`).join('')
    : '<p class="field-note">Aucune étiquette. Crée-en une, ou pose-en une depuis le lecteur.</p>';
}

async function ouvrirGestionTags() {
  await reloadState();
  renderTagManager();
  openModal('#tagsModal');
}

async function majTag(id, patch) {
  try {
    await api.updateTag(id, patch);
    await reloadState();
    renderTagManager();
    loadArticles(true);
  } catch (error) {
    toast('Étiquette : ' + error.message, 'bad');
  }
}

/* ------------------------------------------------ réparation des sources */

const LIBELLES = {
  repare: ['ok', 'réparée'], propose: ['nok', 'à confirmer'],
  doublon: ['nok', 'déjà présente'], introuvable: ['nok', 'introuvable'], echec: ['nok', 'échec']
};

function afficherRapport(rapport) {
  const resultats = rapport.results || [rapport];
  const auto = resultats.filter((r) => r.status === 'repare').length;
  const props = resultats.filter((r) => r.status === 'propose').length;

  $('#repairSummary').textContent = auto || props
    ? `${auto} réparées automatiquement · ${props} propositions à confirmer. Une proposition n’est appliquée que si tu l’adoptes.`
    : 'Aucune adresse de remplacement trouvée.';

  const ordre = { propose: 0, repare: 1, doublon: 2, introuvable: 3, echec: 4 };
  $('#repairList').innerHTML = resultats.slice().sort((a, b) => (ordre[a.status] ?? 9) - (ordre[b.status] ?? 9))
    .map((r) => {
      const [ton, libelle] = LIBELLES[r.status] || LIBELLES.echec;
      const detail = r.status === 'repare'
        ? `Nouvelle adresse : <b>${esc(r.toTitle || '')}</b><br><span class="repair-url">${esc(r.to)}</span>`
        : r.status === 'propose'
          ? r.candidates.map((c) => `<div class="repair-cand">
              <button class="btn" data-accept="${r.feedId}" data-url="${esc(c.url)}">Adopter</button>
              <span><b>${esc(c.title || 'sans titre')}</b> · ${c.confiance}% de ressemblance
              <br><span class="repair-url">${esc(c.url)}</span></span></div>`).join('')
          : `<span class="repair-url">${esc(r.from || '')}</span>`;
      return `<div class="repair-row" data-feed-row="${r.feedId}">
        <div><div class="repair-name">${esc(r.title || 'Source')}</div>
        <div class="repair-detail">${detail}</div></div>
        <span class="repair-tag ${ton}">${libelle}</span></div>`;
    }).join('');

  openModal('#repairModal');
}

async function adopterAdresse(feedId, url, bouton) {
  bouton.disabled = true;
  bouton.textContent = '…';
  try {
    const r = await api.repairFeed(feedId, url);
    await reloadState();
    const ligne = $(`[data-feed-row="${feedId}"]`);
    if (ligne) {
      $('.repair-detail', ligne).innerHTML = `Nouvelle adresse : <b>${esc(r.feed.title)}</b>`;
      $('.repair-tag', ligne).className = 'repair-tag ok';
      $('.repair-tag', ligne).textContent = 'réparée';
    }
    toast(`${r.feed.title} · ${nombre(r.added || 0)} articles`);
    loadArticles(true);
  } catch (error) {
    bouton.disabled = false;
    bouton.textContent = 'Adopter';
    toast('Échec : ' + error.message, 'bad');
  }
}

/* -------------------------------------------------------------- réglages */

function renderAccents() {
  $('#accentChoices').innerHTML = (state.accents || []).map((a) => `
    <button type="button" class="accent-swatch${state.settings.accent === a.valeur ? ' on' : ''}"
            data-accent="${esc(a.valeur)}" style="--teinte:${esc(a.valeur)}"
            title="${esc(a.nom)}" aria-label="${esc(a.nom)}"></button>`).join('');
}

function ouvrirReglages() {
  $('#setTheme').value = localStorage.getItem('bublee.theme') || 'auto';
  $('#setRefresh').value = String(state.settings.refreshMinutes ?? 30);
  $('#setRetention').value = String(state.settings.retentionDays ?? 90);
  $('#setFulltext').value = state.settings.fulltext ?? 'auto';
  renderAccents();
  renderMonCompte();
  chargerRegles();
  chargerDebit();
  openModal('#settingsModal');
}

async function enregistrerReglages(event) {
  event.preventDefault();
  const theme = $('#setTheme').value;
  applyTheme(theme);
  try {
    await api.settings({
      theme,
      accent: state.settings.accent,
      refreshMinutes: Number($('#setRefresh').value),
      retentionDays: Number($('#setRetention').value),
      fulltext: $('#setFulltext').value
    });
    state.settings.refreshMinutes = Number($('#setRefresh').value);
    state.settings.retentionDays = Number($('#setRetention').value);
    state.settings.fulltext = $('#setFulltext').value;
    closeModals();
    toast('Réglages enregistrés');
  } catch (error) {
    toast('Échec : ' + error.message, 'bad');
  }
}

/* ---------------------------------------------------------------- débit */

/* Le vrai problème d'un agrégateur n'est pas de collecter, c'est le débit.
   La base sait ce que chaque source apporte et ce qu'on en fait ; il suffisait
   de le montrer, et de proposer d'agir. */

let suggestions = [];

const LIBELLE_PRIORITE = { suivi: '', survol: 'survol', muet: 'muette' };

async function chargerDebit() {
  const resume = $('#debitResume');
  try {
    const d = await api.statsSources(90);
    suggestions = d.suggestions;
    const parJour = Math.round((d.recus / d.jours) * 10) / 10;
    resume.textContent = `Sur ${d.jours} jours : ${nombre(d.recus)} articles reçus, ${nombre(d.lus)} lus`
      + ` — ${parJour} par jour.`
      + (d.assezDeRecul
        ? ''
        : ' Trop peu de lectures pour comparer les sources entre elles : aucune suggestion tant que la'
          + ' bibliothèque n’a pas été parcourue.');

    // Les plus prolifiques d'abord : c'est là que se joue le débit. Les
    // suggestions remontent en tête, puisque c'est sur elles qu'on peut agir.
    const liste = d.sources.filter((s) => s.recus > 0)
      .sort((a, b) => (b.suggestion ? 1 : 0) - (a.suggestion ? 1 : 0) || b.recus - a.recus)
      .slice(0, 25);

    $('#debitListe').innerHTML = liste.map((s) => `
      <div class="debit-ligne${s.suggestion ? ' propose' : ''}" data-source="${s.id}">
        <span class="debit-nom">${esc(s.title)}${
  LIBELLE_PRIORITE[s.priority] ? ` <span class="debit-etat">${LIBELLE_PRIORITE[s.priority]}</span>` : ''}</span>
        <span class="debit-barre" aria-hidden="true"><span style="width:${Math.min(100, s.partLue)}%"></span></span>
        <span class="debit-chiffres">${nombre(s.recus)} reçus · ${s.partLue}% lus · ${s.parJour}/j</span>
        ${s.suggestion ? `<button type="button" data-survol="${s.id}">Survol</button>` : '<span></span>'}
      </div>`).join('') || '<p class="field-note">Rien reçu sur la période.</p>';

    $('#debitActions').hidden = !suggestions.length;
    if (suggestions.length) {
      $('#debitAppliquer').textContent = `Passer ${pluriel(suggestions.length, 'source')} en survol`;
    }
  } catch (error) {
    resume.textContent = 'Débit indisponible : ' + error.message;
  }
}

async function passerEnSurvol(ids) {
  try {
    majCompteurs(await api.priorites(ids, 'survol'));
    await reloadState();
    await chargerDebit();
    toast(`${pluriel(ids.length, 'source')} en survol`);
    loadArticles(true);
  } catch (error) {
    toast('Échec : ' + error.message, 'bad');
  }
}

/* ---------------------------------------------------------------- règles */

const LIBELLE_ACTION = { lu: 'marquer lu', favori: 'mettre en favori', etiquette: 'étiqueter' };
const LIBELLE_CHAMP = { titre: 'titre', corps: 'corps', auteur: 'auteur', partout: 'partout' };

function renderRegles(liste) {
  state.regles = liste;
  $('#reglesListe').innerHTML = liste.length
    ? liste.map((r) => `
      <div class="regle${r.actif ? '' : ' eteinte'}" data-regle="${r.id}">
        <span class="regle-quoi">
          <b>${esc(r.motif)}</b>
          <span class="regle-ou">${esc(LIBELLE_CHAMP[r.champ] || r.champ)}${
  r.feed_title ? ' · ' + esc(r.feed_title) : ''} → ${esc(LIBELLE_ACTION[r.action] || r.action)}${
  r.valeur ? ' « ' + esc(r.valeur) + ' »' : ''}</span>
        </span>
        <span class="regle-compte">${r.touches ? nombre(r.touches) + ' pris' : '—'}</span>
        <button type="button" data-bascule="${r.id}" data-actif="${r.actif ? 0 : 1}">${r.actif ? 'Suspendre' : 'Reprendre'}</button>
        <button type="button" class="lien-danger" data-suppr-regle="${r.id}">✕</button>
      </div>`).join('')
    : '<p class="field-note">Aucune règle. Le champ ci-dessous en pose une.</p>';
}

async function chargerRegles() {
  try { renderRegles((await api.regles()).rules); } catch { /* les réglages restent utilisables */ }
  // La liste des sources sert à borner une règle à l'une d'elles.
  $('#regleSource').innerHTML = '<option value="">de toutes les sources</option>'
    + state.feeds.map((f) => `<option value="${f.id}">${esc(f.title)}</option>`).join('');
}

/** Ce qu'on est en train d'écrire, sous forme de règle. */
const regleSaisie = () => ({
  motif: $('#regleMotif').value.trim(),
  champ: $('#regleChamp').value,
  action: $('#regleAction').value,
  valeur: $('#regleValeur').value.trim() || null,
  feedId: $('#regleSource').value || null
});

async function essayerRegle() {
  const regle = regleSaisie();
  const apercu = $('#regleApercu');
  if (!regle.motif) { apercu.hidden = true; return; }
  try {
    const r = await api.essayerRegle(regle);
    apercu.hidden = false;
    apercu.textContent = r.total
      ? `${nombre(r.total)} article(s) non lu(s) correspondent — par exemple : `
        + r.exemples.slice(0, 3).map((a) => `« ${a.title.slice(0, 60)} »`).join(', ')
      : 'Aucun article non lu ne correspond pour l’instant.';
  } catch (error) {
    apercu.hidden = false;
    apercu.textContent = 'Essai impossible : ' + error.message;
  }
}

/* --------------------------------------------------------- ajout de flux */

async function ajouterFlux(event) {
  event.preventDefault();
  const btn = $('#feedSubmit');
  const url = $('#feedUrl').value.trim();
  if (!url) return;
  btn.disabled = true;
  btn.textContent = 'Recherche…';
  try {
    const r = await api.addFeed(url, $('#feedFolder').value.trim());
    await reloadState();
    closeModals();
    $('#feedForm').reset();
    toast(`${r.feed.title} · ${nombre(r.added || 0)} articles`);
    setView({ view: 'unread', feedId: r.feed.id });
  } catch (error) {
    toast(error.message, 'bad');
    if (error.status === 409 && error.payload?.feedId) {
      closeModals();
      setView({ view: 'all', feedId: error.payload.feedId });
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Ajouter';
  }
}

async function ajouterSuggestion(index, element) {
  const s = SUGGESTIONS[index];
  element.classList.add('done');
  try {
    await api.addFeed(s.url, s.folder);
    await reloadState();
    toast(`${s.title} ajouté`);
    loadArticles(true);
  } catch (error) {
    element.classList.remove('done');
    toast(error.message, 'bad');
  }
}

async function importerOpml(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  event.target.value = '';
  try {
    const r = await api.importOpml(await file.text());
    await reloadState();
    closeModals();
    // Le serveur annoncera la fin du téléchargement : plus d'attente au jugé.
    if (!('EventSource' in window)) {
      toast(`${pluriel(r.added, 'source ajoutée', 'sources ajoutées')} — téléchargement en cours`);
      setTimeout(() => reloadState().then(() => loadArticles(true)), 8000);
    }
  } catch (error) {
    toast('Import impossible : ' + error.message, 'bad');
  }
}

/* --------------------------------------------------------- édition d'un flux */

function ouvrirEditionFlux(id) {
  const feed = state.feeds.find((f) => f.id === id);
  if (!feed) return;
  $('#editFeedId').value = id;
  $('#editFeedTitle').value = feed.custom_title || feed.title;
  $('#editFeedFolder').value = feed.folder || '';
  $('#editFeedUrl').value = feed.url;
  $('#editFeedPriority').value = feed.priority || 'suivi';
  $('#editFeedFulltext').value = feed.fulltext || 'auto';
  $('#editFeedError').textContent = feed.last_error ? '⚠ ' + feed.last_error : '';
  $('#repairFeed').hidden = !feed.last_error;
  openModal('#feedEditModal');
  $('#editFeedTitle').focus();
}

async function enregistrerFlux(event) {
  event.preventDefault();
  const id = Number($('#editFeedId').value);
  const feed = state.feeds.find((f) => f.id === id);
  const url = $('#editFeedUrl').value.trim();
  try {
    await api.updateFeed(id, {
      custom_title: $('#editFeedTitle').value.trim(),
      folder: $('#editFeedFolder').value.trim(),
      priority: $('#editFeedPriority').value,
      fulltext: $('#editFeedFulltext').value,
      ...(url && url !== feed?.url ? { url } : {})
    });
    if (url && url !== feed?.url) await api.refreshFeed(id);
    await reloadState();
    closeModals();
    loadArticles(true);
    toast('Source mise à jour');
  } catch (error) {
    toast('Échec : ' + error.message, 'bad');
  }
}

async function supprimerFlux() {
  const id = Number($('#editFeedId').value);
  const feed = state.feeds.find((f) => f.id === id);
  if (!confirm(`Supprimer « ${feed?.title} » et tous ses articles ?`)) return;
  try {
    await api.deleteFeed(id);
    await reloadState();
    closeModals();
    if (state.feedId === id) setView({ view: state.view }); else loadArticles(true);
    toast('Source supprimée');
  } catch (error) {
    toast('Échec : ' + error.message, 'bad');
  }
}

/* ------------------------------------------------------- largeur d'index */

const INDEX_MIN = 240;
const INDEX_MAX = 460;
const INDEX_DEFAUT = 266;

function largeurIndex(px) {
  const w = Math.round(Math.min(INDEX_MAX, Math.max(INDEX_MIN, px)));
  document.documentElement.style.setProperty('--index-w', w + 'px');
  try { localStorage.setItem('bublee.indexWidth', String(w)); } catch (e) {}
  return w;
}

/**
 * Replie l'index sur toute la largeur de la scène. On mémorise l'état comme la
 * largeur : c'est un réglage d'écran, pas de compte.
 */
function plierIndex(plie) {
  const app = $('#app');
  app.classList.toggle('plie', plie);
  $('#railCollapse').setAttribute('aria-expanded', String(!plie));
  try { localStorage.setItem('bublee.indexPlie', plie ? '1' : '0'); } catch (e) {}
}

const indexPlie = () => $('#app').classList.contains('plie');

function poigneeIndex() {
  const grip = $('#indexGrip');
  const app = $('#app');
  if (!grip) return;

  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    app.classList.add('redim');
    const bouge = (ev) => largeurIndex(ev.clientX);
    const fini = () => {
      app.classList.remove('redim');
      grip.removeEventListener('pointermove', bouge);
      grip.removeEventListener('pointerup', fini);
      grip.removeEventListener('pointercancel', fini);
    };
    grip.addEventListener('pointermove', bouge);
    grip.addEventListener('pointerup', fini);
    grip.addEventListener('pointercancel', fini);
  });

  // Double-clic : retour à la largeur d'origine.
  grip.addEventListener('dblclick', () => largeurIndex(INDEX_DEFAUT));

  // Au clavier, la poignée se règle aux flèches — 16 px par appui.
  grip.addEventListener('keydown', (e) => {
    const pas = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
    if (!pas) return;
    e.preventDefault();
    largeurIndex($('#rail').getBoundingClientRect().width + pas);
  });
}

/* -------------------------------- calcul des couleurs d'attente au vol --- */

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
function imageArrivee(img) {
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
function rattraperImages(racine = document) {
  $$('img.fondu', racine).forEach((img) => {
    if (img.complete && img.naturalWidth) imageArrivee(img);
  });
}

/* ------------------------------------------------ le glissé, au doigt --- */

/* Au téléphone, le lecteur occupe tout l'écran : le doigt est le seul moyen
   naturel d'aller et venir. Glisser à gauche avance d'un article ; glisser à
   droite revient au précédent — ou referme, quand on est revenu à celui qu'on
   avait ouvert depuis la liste. C'est le geste « retour » du téléphone. */

const SEUIL_GLISSE = 64;        // en deçà, c'est une hésitation, pas une intention
const PENTE_GLISSE = 1.4;       // l'horizontale doit l'emporter franchement
const T_PASSAGE = 240;          // la durée d'un glissé posé, sans élan
const T_MIN = 150, T_MAX = 320; // une chiquenaude vive ; un glissé lent
const DEBORD = 1.12;            // le sortant va un peu au-delà du bord
const ENTREE = 8;               // en %, le retard du suivant sur le sortant

/**
 * Combien de temps donner au passage.
 *
 * Une durée fixe ignore la main : après une chiquenaude vive, le contenu
 * ralentissait brutalement au relâchement, et l'animation devenait plus lente
 * que le doigt qui venait de la lancer. C'est ce décalage-là qu'on ressent
 * comme une résistance à l'arrivée. On prolonge donc l'élan plutôt que de le
 * remplacer : la durée est celle qu'il faudrait pour finir le chemin à la
 * vitesse du doigt, encadrée pour rester lisible.
 */
function dureePassage(reste, vitesse) {
  if (!vitesse) return T_PASSAGE;
  return Math.round(Math.min(T_MAX, Math.max(T_MIN, reste / vitesse)));
}

const douceur = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/** Vrai si le doigt est parti dans une zone qui défile déjà horizontalement —
    un tableau, un bloc de code : elle garde la priorité. */
function dansUnDefilementHorizontal(cible) {
  for (let el = cible; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const debordement = getComputedStyle(el).overflowX;
      if (debordement === 'auto' || debordement === 'scroll') return true;
    }
  }
  return false;
}

/**
 * Le passage d'un article à l'autre.
 *
 * Trois principes, chacun contre un défaut qu'on a vu à l'usage. Seul le contenu
 * bouge : déplacer le panneau entier découvrait le fond derrière lui, et faisait
 * bouger jusqu'à la barre, qui n'a aucune raison de suivre le doigt. L'article
 * qu'on quitte reste à l'écran pendant que le suivant se pose dessous, si bien
 * qu'il n'y a jamais de trou entre les deux. Et surtout : au relâchement du
 * doigt, il ne reste plus rien à calculer. Rien n'est cloné — le sortant garde
 * son propre corps, sa mise en page et ses images déjà décodées — et rien n'est
 * téléchargé, les voisins ayant été demandés pendant la lecture.
 */
async function glisserVers(article, sens, depart, vitesse = 0) {
  const ancien = $('#readerScroll');
  const barre = $('.reader-bar');

  if (!douceur()) {
    ancien.style.transform = '';
    ancien.style.willChange = '';
    await openArticle(article.id, { enchaine: true });
    return;
  }

  // L'article qu'on quitte ne devient pas une copie de lui-même : on lui retire
  // son rôle, il reste tel quel là où le doigt l'a laissé. Cloner tout un
  // article à cet instant précis coûtait le tiers de l'animation.
  const classes = ancien.className;
  const lu = ancien.scrollTop;
  ancien.removeAttribute('id');
  ancien.classList.add('reader-fantome');
  ancien.style.top = barre.offsetHeight + 'px';
  ancien.style.transition = 'none';
  ancien.style.transform = `translateX(${depart}px)`;

  // Le suivant prend sa place dans le flux, dessous.
  const neuf = document.createElement('div');
  neuf.id = 'readerScroll';
  neuf.className = classes;
  neuf.style.willChange = 'transform';
  ancien.after(neuf);

  // Sortir du flux lui fait oublier où on en était de sa lecture : on le lui
  // rappelle, sans le défilement doux qui transformerait le rappel en voyage.
  ancien.style.scrollBehavior = 'auto';
  ancien.scrollTop = lu;

  // Déjà en main : le rendu tient dans le même souffle, avant la première image
  // de l'animation. Sinon on part quand même — le sortant couvre l'attente.
  const ouverture = openArticle(article.id, { enchaine: true });
  if (dejaEnMain(article.id)) await ouverture;

  // Le sortant vise un peu au-delà du bord. Visant le bord pile, la courbe le
  // laissait traîner : elle fait 98 % du chemin en deux tiers du temps, et le
  // dernier tiers ne servait qu'à ramener les six derniers pixels — un liseré
  // de l'ancien article restait suspendu sur le côté. Avec ce débord il a
  // franchement quitté l'écran au tiers de l'animation. Et il ne s'efface plus :
  // il s'en va, c'est assez, et un plein écran translucide coûte à composer
  // autant qu'il se voyait mal.
  const duree = dureePassage(Math.max(80, innerWidth - Math.abs(depart)), vitesse);
  ancien.style.transition = `transform ${duree}ms var(--ease)`;
  ancien.style.transform = `translateX(${sens * 100 * DEBORD}%)`;

  neuf.style.transform = `translateX(${-sens * ENTREE}%)`;
  void neuf.offsetWidth;
  neuf.style.transition = `transform ${duree}ms var(--ease)`;
  neuf.style.transform = '';

  await attendre(duree);
  ancien.remove();
  neuf.style.transition = '';
  neuf.style.transform = '';
  neuf.style.willChange = '';
}

/** Fermer par le geste : le panneau entier s'en va, lui, puisqu'il disparaît. */
async function glisserDehors(depart = 0, vitesse = 0) {
  const lecteur = $('#reader');
  const scroll = $('#readerScroll');
  scroll.style.transition = 'none';
  scroll.style.transform = '';
  if (!douceur()) { closeReader(); return; }
  const duree = dureePassage(Math.max(80, innerWidth - Math.abs(depart)), vitesse);
  lecteur.style.transition = `transform ${duree}ms var(--ease), opacity ${duree}ms linear`;
  lecteur.style.transform = `translateX(${100 * DEBORD}%)`;
  lecteur.style.opacity = '0';
  await attendre(duree);
  closeReader();
  lecteur.style.transition = 'none';
  lecteur.style.transform = '';
  lecteur.style.opacity = '';
}

function glisseLecteur() {
  const lecteur = $('#reader');
  let x0 = 0, y0 = 0, actif = false, horizontal = null, occupe = false;
  // L'élan du doigt, tenu à jour d'une image à l'autre. Le lissage retient un
  // peu du passé : sans lui, un dernier relevé un peu court — le doigt qui
  // décolle — ferait passer une chiquenaude vive pour un glissé mou. Et on
  // écarte les intervalles trop brefs pour dire quoi que ce soit : la toute
  // première image après le contact rapporte parfois un saut franc en une
  // fraction de milliseconde, soit une vitesse absurde que le lissage
  // traînerait ensuite jusqu'au relâchement.
  const PAS_MESURABLE = 12;   // en ms
  let repere = { x: 0, t: 0 }, vitesse = 0, mesure = false;

  const suivreElan = (x, t) => {
    const dt = t - repere.t;
    if (dt < PAS_MESURABLE) return;   // le repère tient : l'écart s'accumulera
    const v = Math.min(4, Math.abs(x - repere.x) / dt);
    vitesse = mesure ? vitesse * 0.6 + v * 0.4 : v;
    mesure = true;
    repere = { x, t };
  };

  /** Un doigt arrêté avant de se lever ne lance rien : il n'a plus d'élan. */
  const elan = (t) => (!mesure || t - repere.t > 90 ? 0 : vitesse);

  const auDoigt = () => matchMedia('(max-width: 860px)').matches;

  const relacher = () => {
    const scroll = $('#readerScroll');
    // Retour au repos : un ressort plutôt qu'un rappel sec.
    scroll.style.transition = 'transform .3s cubic-bezier(.22, 1.2, .36, 1)';
    scroll.style.transform = '';
    setTimeout(() => { if (!actif) scroll.style.willChange = ''; }, 320);
    actif = false; horizontal = null;
  };

  lecteur.addEventListener('touchstart', (e) => {
    if (occupe || !auDoigt() || e.touches.length !== 1 || dansUnDefilementHorizontal(e.target)) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    actif = true; horizontal = null;
    repere = { x: x0, t: e.timeStamp }; vitesse = 0; mesure = false;
    // L'animation d'ouverture dure 340 ms et, tant qu'elle court, ses images
    // clés l'emportent sur le style en ligne : un doigt posé aussitôt ne
    // déplacerait rien. On la coupe net.
    lecteur.style.animation = 'none';
    $('#readerScroll').style.transition = 'none';
  }, { passive: true });

  lecteur.addEventListener('touchmove', (e) => {
    if (!actif) return;
    const dx = e.touches[0].clientX - x0;
    const dy = e.touches[0].clientY - y0;

    // On tranche une fois pour toutes au premier mouvement franc : sans ça, un
    // défilement vertical un peu oblique ferait trembler le contenu.
    if (horizontal === null) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      horizontal = Math.abs(dx) > Math.abs(dy) * PENTE_GLISSE;
      if (!horizontal) { relacher(); return; }
      $('#readerScroll').style.willChange = 'transform';
    }

    // Le contenu suit le doigt au point près, sauf là où le geste ne mène nulle
    // part : vers la gauche sans article suivant, il résiste comme un élastique
    // au lieu de promettre un passage qui n'aura pas lieu.
    const impasse = dx < 0 && !articleSuivant();
    const suivi = impasse ? Math.sign(dx) * Math.pow(Math.abs(dx), 0.62) : dx;
    $('#readerScroll').style.transform = `translateX(${suivi}px)`;
    suivreElan(e.touches[0].clientX, e.timeStamp);
  }, { passive: true });

  lecteur.addEventListener('touchend', async (e) => {
    if (!actif) return;
    const fin = e.changedTouches[0]?.clientX ?? x0;
    const dx = fin - x0;
    suivreElan(fin, e.timeStamp);
    const lance = elan(e.timeStamp);
    const franchi = horizontal && Math.abs(dx) >= SEUIL_GLISSE;
    actif = false; horizontal = null;

    if (!franchi) { relacher(); return; }

    const suivant = dx < 0 ? articleSuivant() : null;
    const precedent = dx > 0 && state.profondeur > 0 ? articlePrecedent() : null;

    occupe = true;
    try {
      if (dx < 0) {
        if (suivant) await glisserVers(suivant, -1, dx, lance);
        else { relacher(); toast('Dernier article de la liste'); }
      } else if (precedent) {
        const restant = state.profondeur - 1;
        await glisserVers(precedent, 1, dx, lance);
        state.profondeur = restant;
      } else {
        await glisserDehors(dx, lance);
      }
    } finally {
      occupe = false;
    }
  }, { passive: true });

  // Un doigt interrompu (appel entrant, geste système) ne laisse rien de travers.
  lecteur.addEventListener('touchcancel', () => { if (actif) relacher(); }, { passive: true });
}

/* ---------------------------------------------------------- branchements */

function wireEvents() {
  glisseLecteur();
  brancherBaladeur();
  brancherLecture();
  ecouterLeServeur();

  $('#nouveautes').addEventListener('click', () => {
    entrants = 0;
    $('#nouveautes').hidden = true;
    $('#scroller').scrollTop = 0;
    loadArticles(true);
  });

  /* --- compte et administration --- */
  $('#compteNouveau').addEventListener('input', (e) => {
    // Changer son mot de passe exige l'ancien : le champ n'apparaît qu'alors.
    $('#compteActuelChamp').hidden = !e.target.value;
  });

  $('#compteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nouveau = $('#compteNouveau').value;
    try {
      const r = await api.majMoi({
        nom: $('#compteNom').value.trim(),
        ...(nouveau ? { motDePasse: nouveau, motDePasseActuel: $('#compteActuel').value } : {})
      });
      state.moi = r.compte;
      $('#compteNouveau').value = '';
      $('#compteActuel').value = '';
      $('#compteActuelChamp').hidden = true;
      renderMonCompte();
      toast(nouveau ? 'Mot de passe changé' : 'Compte mis à jour');
    } catch (error) {
      toast('Compte : ' + error.message, 'bad');
    }
  });

  $('#deconnexion').addEventListener('click', async () => {
    await api.logout().catch(() => {});
    location.reload();
  });

  $('#nouveauCompteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.creerCompte({
        email: $('#ncEmail').value.trim(),
        nom: $('#ncNom').value.trim(),
        motDePasse: $('#ncPass').value,
        role: $('#ncRole').value
      });
      e.target.reset();
      renderComptes();
      toast('Compte créé — sa bibliothèque est vide');
    } catch (error) {
      toast('Création : ' + error.message, 'bad');
    }
  });

  $('#zoneComptes').addEventListener('change', async (e) => {
    const role = e.target.closest('[data-role-de]');
    if (!role) return;
    try {
      await api.majCompte(Number(role.dataset.roleDe), { role: role.value });
      renderComptes();
      toast('Rôle mis à jour');
    } catch (error) {
      toast('Rôle : ' + error.message, 'bad');
      renderComptes();
    }
  });

  $('#zoneComptes').addEventListener('click', async (e) => {
    const bascule = e.target.closest('[data-actif-de]');
    if (bascule) {
      try {
        await api.majCompte(Number(bascule.dataset.actifDe), { actif: bascule.dataset.actif === '1' });
        renderComptes();
      } catch (error) { toast(error.message, 'bad'); }
      return;
    }
    const suppr = e.target.closest('[data-supprimer-compte]');
    if (!suppr) return;
    // Suppression irréversible et silencieuse autrement : on nomme ce qui part.
    if (!confirm(`Supprimer le compte « ${suppr.dataset.nom} » ?

Ses sources, ses articles et ses étiquettes seront effacés. C’est définitif.`)) return;
    try {
      await api.supprimerCompte(Number(suppr.dataset.supprimerCompte));
      renderComptes();
      toast('Compte supprimé');
    } catch (error) { toast(error.message, 'bad'); }
  });

  // `load` ne remonte pas : on l'attrape a la descente. Le premier rendu a lieu
  // avant ce branchement — une image arrivee entre-temps n'aurait jamais recu
  // sa classe et serait restee invisible. D'ou le rattrapage juste apres.
  document.addEventListener('load', (e) => {
    if (e.target.tagName === 'IMG') imageArrivee(e.target);
  }, true);
  rattraperImages();
  // Le logo ramène à la une, comme le titre d'un journal qu'on replie.
  $('#logo').addEventListener('click', () => { closeReader(); setView({ view: 'unread' }); });
  poigneeIndex();
  $$('.view-row').forEach((b) => b.addEventListener('click', () => setView({ view: b.dataset.view })));
  $$('.tab').forEach((b) => b.addEventListener('click', () => {
    applyLayout(b.dataset.layout);
    renderFlux();
    api.settings({ layout: b.dataset.layout }).catch(() => {});
  }));

  $('#tagList').addEventListener('click', (e) => {
    const l = e.target.closest('[data-tag]');
    if (l) setView({ view: 'all', tag: state.tag === l.dataset.tag ? null : l.dataset.tag });
  });

  $('#feedList').addEventListener('click', (e) => {
    const open = e.target.closest('[data-open-folder]');
    if (open) { setView({ view: state.view, folder: open.dataset.openFolder }); return; }
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const n = toggle.dataset.toggle;
      collapsed.has(n) ? collapsed.delete(n) : collapsed.add(n);
      localStorage.setItem('bublee.collapsed', JSON.stringify([...collapsed]));
      renderFeedList();
      return;
    }
    const row = e.target.closest('[data-feed]');
    if (row) setView({ view: state.view === 'starred' ? 'all' : state.view, feedId: Number(row.dataset.feed) });
  });
  $('#feedList').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('[data-feed]');
    if (!row) return;
    e.preventDefault();
    ouvrirEditionFlux(Number(row.dataset.feed));
  });

  // Un dossier n'était qu'une chaîne portée par chaque source : il n'y avait
  // aucun moyen de le renommer sans reprendre les sources une à une.
  $('#feedList').addEventListener('dblclick', async (e) => {
    const nom = e.target.closest('[data-renommer]')?.dataset.renommer;
    if (!nom) return;
    e.preventDefault();
    const neuf = prompt(`Renommer le dossier « ${nom} » :\n\nLui donner le nom d’un autre dossier fusionne les deux.`, nom);
    if (neuf === null || neuf.trim() === nom) return;
    try {
      await api.renommerDossier(nom, neuf);
      if (state.folder === nom) state.folder = neuf.trim() || null;
      await reloadState();
      toast(neuf.trim() ? `Dossier renommé « ${neuf.trim()} »` : 'Sources sorties du dossier');
    } catch (error) { toast('Renommage : ' + error.message, 'bad'); }
  });

  glisserLesSources();

  /* --- étiqueter depuis les vues --- */
  const scroller = $('#scroller');
  $('#flux').addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;           // au doigt, le survol n'existe pas
    survolCarte(e.target.closest('.art'));
  });
  scroller.addEventListener('pointerleave', () => survolCarte(null));
  scroller.addEventListener('scroll', () => { fermerPopTags(); fermerPartage(); });

  $('#artTagBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    ouvrirPopTags(Number($('#artActions').dataset.id), $('#artActions'));
  });
  $('#artShareBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    ouvrirPartage(Number($('#artActions').dataset.id), $('#artActions'));
  });
  $('#sharePop').addEventListener('click', (e) => {
    const ligne = e.target.closest('[data-partage]');
    if (ligne) partager(ligne.dataset.partage);
  });

  $('#tagPop').addEventListener('click', (e) => {
    const ligne = e.target.closest('[data-pop-tag]');
    if (!ligne || popId === null) return;
    const nom = ligne.dataset.popTag;
    const posee = (articleParId(popId)?.tags || []).includes(nom);
    etiqueter(popId, posee ? { remove: [nom] } : { add: [nom] });
  });

  $('#tagPopInput').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); fermerPopTags(); $('#flux').focus(); return; }
    if (e.key !== 'Enter') return;
    const nom = e.target.value.trim();
    if (!nom || popId === null) return;
    e.target.value = '';
    etiqueter(popId, { add: [nom] });
  });

  // Un clic ailleurs referme — mais pas celui qui vient de l'ouvrir.
  document.addEventListener('pointerdown', (e) => {
    const dansUnPop = e.target.closest('#tagPop') || e.target.closest('#sharePop')
      || e.target.closest('#lirePop') || e.target.closest('#artActions') || e.target.closest('#markAllRead');
    if (dansUnPop) return;
    fermerPopTags();
    fermerPartage();
    fermerLirePop();
  });

  $('#flux').addEventListener('click', (e) => {
    // Le titre est un lien : un clic avec modificateur, ou du milieu, doit
    // ouvrir un onglet comme partout ailleurs. On ne détourne que le clic nu.
    const titre = e.target.closest('a.art-lien');
    if (titre) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openArticle(Number(titre.dataset.open));
      return;
    }
    // Ailleurs dans la carte : elle est cliquable en entier, comme avant.
    const carte = e.target.closest('.art');
    if (carte?.dataset.id) { openArticle(Number(carte.dataset.id)); return; }
    const suggest = e.target.closest('[data-suggest]');
    if (suggest) { ajouterSuggestion(Number(suggest.dataset.suggest), suggest); return; }
    if (e.target.closest('[data-add-feed]')) { openModal('#feedModal'); $('#feedUrl').focus(); return; }
    if (e.target.closest('[data-import-opml]')) { $('#opmlFile').click(); return; }
    if (e.target.closest('[data-refresh]')) { rafraichir(); return; }
    if (e.target.closest('[data-clear-search]')) { $('#search').value = ''; state.q = ''; loadArticles(true); return; }
    const goto = e.target.closest('[data-goto-view]');
    if (goto) setView({ view: goto.dataset.gotoView });
  });

  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !state.loading && !state.done && state.articles.length) loadArticles();
  }, { root: $('#scroller'), rootMargin: '700px' }).observe($('#sentinel'));

  const chercher = debounce(() => {
    const avant = state.q;
    state.q = $('#search').value.trim();
    if (state.q) { state.feedId = null; state.folder = null; state.tag = null; state.view = 'all'; renderIndex(); }
    // La recherche s'ouvre comme une vue — elle s'empile une fois, pour qu'on
    // puisse en revenir. Les lettres suivantes remplacent : chacune n'est pas
    // une étape de l'historique.
    ecrireAdresse({ remplacer: Boolean(avant) });
    loadArticles(true);
  }, 300);
  $('#search').addEventListener('input', chercher);

  $('#triRecherche').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tri]');
    if (!b || b.dataset.tri === state.tri) return;
    state.tri = b.dataset.tri;
    loadArticles(true);
  });

  // Le bouton « précédent » du navigateur ramène à la vue d'avant.
  addEventListener('popstate', () => {
    if (ecritureInterne) return;
    const ecran = ECRANS[location.hash];
    if (ecran) { ecran(); return; }
    closeModals();
    appliquerAdresse(lireAdresse());
  });

  $('#refreshBtn').addEventListener('click', rafraichir);
  $('#markAllRead').addEventListener('click', (e) => ouvrirLirePop(e.currentTarget));
  $('#lirePop').addEventListener('click', (e) => {
    const ligne = e.target.closest('[data-lire]');
    if (!ligne) return;
    fermerLirePop();
    toutMarquerLu(ligne.dataset.lire === 'tout' ? null : Number(ligne.dataset.lire));
  });
  $('#addFeedBtn').addEventListener('click', () => { openModal('#feedModal'); $('#feedUrl').focus(); });
  $('#addFeedRail').addEventListener('click', () => { openModal('#feedModal'); $('#feedUrl').focus(); });
  // Sous 860 px l'index est un tiroir : le ☰ l'ouvre. Au-dessus, il le déplie.
  $('#railOpen').addEventListener('click', () => {
    if (matchMedia('(max-width: 860px)').matches) $('#app').classList.add('rail-on');
    else plierIndex(false);
  });
  $('#railClose').addEventListener('click', closeRail);
  $('#railCollapse').addEventListener('click', () => plierIndex(true));

  $('#readerClose').addEventListener('click', closeReader);
  // Cliquer la liste, à côté du panneau, referme la lecture.
  $('#readerShade').addEventListener('click', closeReader);
  $('#readerStar').addEventListener('click', () => state.openId && basculerFavori(state.openId));
  $('#readerTag').addEventListener('click', (e) => ouvrirPopTags(state.openId, e.currentTarget));
  $('#readerFull').addEventListener('click', () => state.openId && completerArticle({ id: state.openId }, true));
  $('#readerUnread').addEventListener('click', async () => {
    if (!state.openId) return;
    const id = state.openId;
    closeReader();
    await marquerLu(id, false);
    toast('Marqué non lu');
  });

  $('#readerScroll').addEventListener('click', (e) => {
    if (e.target.closest('#readerTagBtn')) { ouvrirPopTags(state.openId, e.target.closest('#readerTagBtn')); return; }
    if (e.target.closest('#readerShareBtn')) { ouvrirPartage(state.openId, e.target.closest('#readerShareBtn')); return; }
    const off = e.target.closest('[data-untag]');
    if (off && state.openId) { etiqueter(state.openId, { remove: [off.dataset.untag] }); return; }
    const jump = e.target.closest('[data-goto-tag]');
    if (jump) { closeReader(); setView({ view: 'all', tag: jump.dataset.gotoTag }); return; }
    if (e.target.closest('[data-retry]') && state.openId) { completerArticle({ id: state.openId }, true); return; }
    const next = e.target.closest('[data-next]');
    if (next) openArticle(Number(next.dataset.next), { enchaine: true });
  });
  $('#readerScroll').addEventListener('scroll', () => {
    // Un popover ancré à la ligne d'étiquettes ne doit pas rester en l'air.
    fermerPopTags();
    fermerPartage();
    const el = $('#readerScroll');
    const max = el.scrollHeight - el.clientHeight;
    $('#readerProgress').style.width = (max > 0 ? (el.scrollTop / max) * 100 : 0) + '%';
  });

  // Cliquer le voile ferme : le clic tombe alors sur le <dialog> lui-même,
  // et non sur un de ses enfants.
  $$('dialog.modal').forEach((fenetre) => {
    fenetre.addEventListener('click', (e) => { if (e.target === fenetre) fenetre.close(); });
  });
  $$('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
  $('#openSettings').addEventListener('click', ouvrirReglages);
  $('#shortcutsBtn').addEventListener('click', () => openModal('#shortcutsModal'));
  $('#openShortcuts').addEventListener('click', () => openModal('#shortcutsModal'));

  // L'accent se garde au clic : sans cela, fermer la fenêtre sans valider
  // laissait la copie locale et le serveur en désaccord.
  $('#accentChoices').addEventListener('click', (e) => {
    const s = e.target.closest('[data-accent]');
    if (!s) return;
    applyAccent(s.dataset.accent);
    renderAccents();
    api.settings({ accent: s.dataset.accent }).catch(() => {});
  });

  $('#feedForm').addEventListener('submit', ajouterFlux);
  $('#importOpml').addEventListener('click', () => $('#opmlFile').click());
  $('#opmlFile').addEventListener('change', importerOpml);
  $('#settingsForm').addEventListener('submit', enregistrerReglages);
  $('#feedEditForm').addEventListener('submit', enregistrerFlux);
  $('#deleteFeed').addEventListener('click', supprimerFlux);

  /* --- débit --- */
  $('#debitAppliquer').addEventListener('click', () => suggestions.length && passerEnSurvol(suggestions));
  $('#debitListe').addEventListener('click', (e) => {
    const b = e.target.closest('[data-survol]');
    if (b) passerEnSurvol([Number(b.dataset.survol)]);
  });

  /* --- règles --- */
  // Le nom de l'étiquette n'a de sens que pour l'action qui étiquette.
  $('#regleAction').addEventListener('change', (e) => {
    $('#regleValeur').hidden = e.target.value !== 'etiquette';
  });
  $('#regleEssai').addEventListener('click', essayerRegle);
  $('#regleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api.creerRegle(regleSaisie());
      majCompteurs(r);
      $('#regleMotif').value = '';
      $('#regleValeur').value = '';
      $('#regleApercu').hidden = true;
      await chargerRegles();
      const n = (r.rejoue?.lus || 0) + (r.rejoue?.favoris || 0) + (r.rejoue?.etiquetes || 0);
      toast(n ? `Règle posée — ${nombre(n)} article(s) traité(s)` : 'Règle posée');
      if (n) loadArticles(true);
    } catch (error) {
      toast('Règle : ' + error.message, 'bad');
    }
  });
  $('#reglesListe').addEventListener('click', async (e) => {
    const bascule = e.target.closest('[data-bascule]');
    const suppr = e.target.closest('[data-suppr-regle]');
    try {
      if (bascule) await api.majRegle(Number(bascule.dataset.bascule), { actif: bascule.dataset.actif === '1' });
      else if (suppr) await api.supprimerRegle(Number(suppr.dataset.supprRegle));
      else return;
      await chargerRegles();
    } catch (error) { toast('Règle : ' + error.message, 'bad'); }
  });

  $('#manageTags').addEventListener('click', ouvrirGestionTags);
  $('#tagCreateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nom = $('#newTagName').value.trim();
    if (!nom) return;
    try {
      await api.createTag(nom);
      $('#newTagName').value = '';
      await reloadState();
      renderTagManager();
    } catch (error) { toast('Étiquette : ' + error.message, 'bad'); }
  });
  $('#tagManager').addEventListener('click', async (e) => {
    const bloc = e.target.closest('[data-tag-id]');
    if (!bloc) return;
    const id = Number(bloc.dataset.tagId);
    const teinteBtn = e.target.closest('[data-color]');
    if (teinteBtn) { majTag(id, { color: teinteBtn.dataset.color }); return; }
    if (e.target.closest('.tag-delete')) {
      const nom = $('.tag-rename', bloc).value;
      if (!confirm(`Supprimer l’étiquette « ${nom} » ?`)) return;
      try {
        await api.deleteTag(id);
        if (state.tag === nom) setView({ view: 'all' });
        await reloadState();
        renderTagManager();
      } catch (error) { toast('Échec : ' + error.message, 'bad'); }
    }
  });
  $('#tagManager').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.tag-rename')) { e.preventDefault(); e.target.blur(); }
  });
  $('#tagManager').addEventListener('focusout', (e) => {
    if (!e.target.matches('.tag-rename')) return;
    const id = Number(e.target.closest('[data-tag-id]').dataset.tagId);
    const ancien = state.tags.find((t) => t.id === id)?.name;
    const nouveau = e.target.value.trim();
    if (nouveau && nouveau !== ancien) majTag(id, { name: nouveau });
  });

  $('#repairAll').addEventListener('click', async () => {
    const btn = $('#repairAll');
    btn.disabled = true;
    btn.textContent = 'Recherche…';
    try { afficherRapport(await api.repairAll()); await reloadState(); }
    catch (error) { toast('Réparation impossible : ' + error.message, 'bad'); }
    finally { btn.disabled = false; btn.textContent = 'Réparer les sources'; }
  });
  $('#repairFeed').addEventListener('click', async (e) => {
    const id = Number($('#editFeedId').value);
    e.target.disabled = true;
    try { afficherRapport(await api.repairFeed(id)); await reloadState(); }
    catch (error) { toast('Réparation impossible : ' + error.message, 'bad'); }
    finally { e.target.disabled = false; }
  });
  $('#repairList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-accept]');
    if (b) adopterAdresse(Number(b.dataset.accept), b.dataset.url, b);
  });
  $('#dedupeAll').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api.dedupe(true);
      await reloadState();
      toast(r.linked ? `${r.linked} doublons regroupés` : 'Aucun doublon');
      loadArticles(true);
    } catch (error) { toast('Échec : ' + error.message, 'bad'); }
    finally { e.target.disabled = false; }
  });

  document.addEventListener('keydown', onKey);
}

boot();
