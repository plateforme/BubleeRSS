import { api } from './api.js';
import { esc, quand, dateJournal, relais, hote, debounce, pluriel, nombre } from './util.js';
import {
  state, $, $$, CLASSE_LAYOUT, collapsed, SUGGESTIONS, teinte, contraste, couleurTag,
  articleParId, toast
} from './etat.js';
import {
  renderFlux, majPuces, indexDe, estVideo, laDuree, fondImage, imgFondue, initialeDe
} from './cartes.js';
import { rattraperImages, imageArrivee } from './couleurs.js';
import { brancherBaladeur, detournerLAudio } from './baladeur.js';
import { glisseLecteur } from './glisse.js';

/* --------------------------------------------------------------- demarrage */

/* ================================================== connexion et comptes === */

/**
 * La porte : premier écran quand personne n'est connecté. Elle sert aussi à
 * l'installation — le tout premier compte devient super et reprend la
 * bibliothèque d'avant les comptes.
 */
/**
 * Affiche la porte et attend la connexion. `etat` vient de `api.etatAuth()`,
 * déjà demandé par `boot` en même temps que le reste : on ne le refait pas.
 */
function montrerLaPorte(etat) {
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
  // Quand une version plus récente prend la main — un nouvel habillage vient
  // d'être mis en cache —, on recharge une fois pour l'adopter aussitôt, au lieu
  // d'attendre la prochaine ouverture (et de tourner un chargement en retard).
  // Seulement si une version contrôlait déjà la page : au tout premier passage,
  // rien n'est périmé, et recharger serait un clignotement inutile. Le drapeau
  // borne à un seul rechargement : pas de boucle.
  if (navigator.serviceWorker.controller) {
    let recharge = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (recharge) return;
      recharge = true;
      location.reload();
    });
  }
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

  // La vue de départ est décidée avant tout — et avant même la connexion :
  // sinon le titre « Non lus » du HTML s'affiche, puis l'aller-retour réseau
  // le fait basculer sur l'édition, ce qui clignote. On pose donc tout de
  // suite le bon titre, et on ne le corrigera qu'un jour sans édition.
  //
  // Une ouverture « maison » vise l'édition du jour plutôt que les non-lus :
  // une pile finie qu'on peut terminer, pas un fond qui se dérobe. Sont
  // « maison » l'ouverture nue et les deux vues d'accueil — c'est aussi ce
  // par quoi la version installée démarre. Un lien précis vers une source, un
  // dossier, une étiquette ou une recherche, lui, est respecté.
  const ecran = ECRANS[location.hash];
  const depart = ecran ? null : lireAdresse();
  const accueil = location.hash.replace(/^#\/?/, '');
  const neutre = Boolean(depart) && (accueil === '' || accueil === 'unread' || accueil === 'edition');
  if (depart) {
    Object.assign(state, {
      view: neutre ? 'edition' : depart.view,
      feedId: depart.feedId, folder: depart.folder, tag: depart.tag, q: depart.q
    });
    $('#search').value = depart.q;
    $('#stageTitle').textContent = titreVue();
  }

  // Tout part en même temps : l'identité, l'état de l'index et les articles.
  // Pour un retour — session valide —, les trois arrivent ensemble, en un
  // seul aller-retour au lieu de trois enchaînés. Si on n'est pas connecté,
  // l'état et les articles échouent sans dommage (401), et la porte reprend
  // la main ; on les refait alors une fois entré.
  const params = {
    view: state.view, feed: state.feedId, folder: state.folder, q: state.q, tag: state.tag,
    limit: state.layout === 'compact' ? 60 : 34
  };
  const pEtat = api.etatAuth().catch((error) => ({ erreur: error }));
  let pState = api.state().catch((error) => ({ erreur: error }));
  let pArticles = api.articles(params).catch((error) => ({ erreur: error }));

  $('#indexDate').textContent = dateJournal();
  $('#mastheadDate').textContent = dateJournal();
  renderSkeleton();

  const etat = await pEtat;
  if (etat.erreur || !etat.compte) {
    await montrerLaPorte(etat.erreur ? { installe: true } : etat);
    pState = api.state();
    pArticles = api.articles(params);
  } else {
    state.moi = etat.compte;
  }

  try {
    const data = await pState;
    if (data.erreur) throw data.erreur;
    // Les jours sans édition — rien de neuf chez les sources suivies — on
    // retombe sur les non-lus, pour ne pas ouvrir sur un écran vide.
    const videEdition = neutre && !data.counts.edition;
    if (videEdition) state.view = 'unread';
    absorb(data);
    applyAccent(data.settings.accent);
    applyLayout(data.settings.layout || 'magazine');

    if (videEdition) {
      // L'optimisme était faux : la fournée en vol visait l'édition, on la
      // laisse tomber et on charge la bonne vue.
      Promise.resolve(pArticles).catch(() => {});
      await loadArticles(true);
    } else {
      let fournee = await pArticles;
      if (fournee?.erreur) fournee = await api.articles(params);   // filet, rare
      state.articles = fournee.articles || [];
      state.cursor = fournee.nextCursor;
      state.done = !fournee.nextCursor;
      state.edition = fournee.edition || null;
      state.loading = false;
      renderFlux({ depuis: 0 });
      $('#stageTitle').textContent = titreVue();
      $('#stageSub').textContent = sousTitre();
      $('#triRecherche').hidden = !state.q;
    }
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
  // La ligne s'affiche dès qu'il y a une édition aujourd'hui, et y reste la
  // journée durant — même une fois tous ses articles lus. La faire disparaître
  // au dernier lu était déroutant : l'édition semblait perdue alors qu'elle
  // n'était que finie. Le compteur montre ce qu'il reste ; terminée, un ✓ dit
  // « à jour » plutôt qu'un zéro muet.
  const resteEdition = state.counts.edition || 0;
  const aUneEdition = (state.counts.editionTotal || 0) > 0;
  $('#countEdition').textContent = aUneEdition && !resteEdition ? '✓' : nombre(resteEdition);
  $('#rowEdition').classList.toggle('finie', aUneEdition && !resteEdition);
  $('#rowEdition').hidden = !aUneEdition && state.view !== 'edition';
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
      ? `<img class="feed-icon" src="${esc(relais(feed.icon, 32))}" alt="" loading="lazy">`
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

/** L'image d'ouverture, mise au chaud dans le cache du navigateur. Avoir le
    texte en main ne sert à rien si la photo, elle, se télécharge encore
    pendant le passage : c'est elle qui occupe la moitié haute de l'écran. */
function prechargerImage(a) {
  if (!a || !a.image) return;
  const img = new Image();
  img.decoding = 'async';
  img.src = relais(a.image, 900);
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
  const index = indexDe(id);
  if (index !== undefined) setPointer(index, false);
  state.openId = id;
  ecrireAdresse({ remplacer: true });

  $('#readerShade').hidden = false;
  // Le panneau ne s'annonce qu'en venant de la liste. Enchaîné — glissé, touche
  // J, lien « suivant » — il est déjà là : seul son contenu change, et rejouer
  // son entrée écraserait l'animation du passage.
  $('#reader').style.animation = enchaine ? 'none' : '';
  $('#reader').hidden = false;
  document.body.style.overflow = 'hidden';

  // Un aperçu tout de suite, tiré de la liste : elle porte déjà le titre,
  // l'image et le résumé. Le panneau n'est donc jamais blanc pendant que le
  // texte complet se récupère — il le remplacera à l'arrivée, en cache pendant
  // l'animation, juste après sinon. Sans article en liste (lien direct), on
  // repart d'un panneau vide, le cas est rare.
  const apercu = state.articles.find((a) => a.id === id);
  if (apercu) renderReader(apercu); else $('#readerScroll').innerHTML = '';

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
         ${imgFondue(relais(a.image, 900), { pressee: true })}
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
    if (poster && !poster.startsWith('data:') && !poster.startsWith('/api/image')) v.poster = relais(poster, 900);
  });
  $$('.reader-body img, .reader-hero img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (src && !src.startsWith('data:') && !src.startsWith('/api/image')) {
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      img.src = relais(src, 900);
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

/* L'ordre à l'écran, pas celui des données. En « une », la mise en page remonte
   le premier article illustré et réordonne le reste en blocs : la carte du haut
   n'est pas state.articles[0]. Le lecteur doit suivre ce que l'œil suit —
   « suivant », c'est la carte suivante sur la page. Sinon, depuis une une posée
   tard dans les données, on butait après deux ou trois articles alors qu'il en
   restait douze en dessous. Hors liste rendue (lien direct), on retombe sur
   l'ordre des données. */
function ordreAffiche() {
  const ids = $$('#flux .art[data-id]').map((el) => Number(el.dataset.id));
  return ids.length ? ids : state.articles.map((a) => a.id);
}

function voisinAffiche(pas) {
  const ordre = ordreAffiche();
  const i = ordre.indexOf(state.openId);
  if (i < 0) return null;
  const id = ordre[i + pas];
  return id == null ? null : state.articles.find((a) => a.id === id) || null;
}

function articleSuivant() { return voisinAffiche(1); }
function articlePrecedent() { return voisinAffiche(-1); }

function closeReader() {
  fermerPopTags();
  fermerPartage();
  state.openId = null;
  state.ouvert = null;
  ecrireAdresse({ remplacer: true });
  $('#reader').hidden = true;
  $('#readerShade').hidden = true;
  // Masquer ne suffit pas : une iframe de lecture — YouTube, Vimeo — ou une
  // <video> continuent de jouer derrière le panneau caché, et le son tourne
  // alors sans aucune commande pour l'arrêter, puisqu'elles sont hors de vue.
  // On vide donc le panneau, ce qui les retire et coupe net. Une écoute au
  // baladeur n'est pas concernée : il vit en pied de page, hors du lecteur, et
  // survivre à la fermeture est précisément sa raison d'être.
  $('#readerScroll').innerHTML = '';
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

/* ---------------------------------------------------------- branchements */

function wireEvents() {
  // Le geste ne connaît pas le lecteur : on lui prête ce dont il a besoin.
  glisseLecteur({ openArticle, closeReader, articleSuivant, articlePrecedent });
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
