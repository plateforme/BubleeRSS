import { api } from './api.js';
import { esc, quand, heure, dateLongue, dateJournal, tempsLecture, duree, relais, hote, debounce, pluriel, nombre } from './util.js';

const $ = (sel, scope = document) => scope.querySelector(sel);
const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];

/* ------------------------------------------------------------------- etat */

const state = {
  view: 'unread',        // unread | all | starred
  feedId: null,
  folder: null,
  q: '',
  tag: null,
  layout: 'magazine',    // magazine (la une) | list (sommaire) | compact (dépêches)
  articles: [],
  cursor: null,
  loading: false,
  done: false,
  pointer: -1,
  openId: null,
  feeds: [],
  folders: [],
  counts: { unread: 0, starred: 0, total: 0 },
  tags: [],
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
  return lum > 150 ? '#0d0d0c' : '#f6f5f1';
}

function rgba(hex, alpha) {
  const n = parseInt(String(hex).slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/* ----------------------------------------------------------------- toasts */

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, kind === 'bad' ? 4600 : 2800);
}

/* --------------------------------------------------------------- demarrage */

async function boot() {
  applyTheme(localStorage.getItem('bublee.theme') || 'auto');
  $('#indexDate').textContent = dateJournal();
  $('#mastheadDate').textContent = dateJournal();

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

  const article = /^#\/article\/(\d+)$/.exec(location.hash);
  if (article) openArticle(Number(article[1]));
  else if (location.hash === '#/tags') ouvrirGestionTags();
  else if (location.hash === '#/shortcuts') openModal('#shortcutsModal');
  else if (location.hash === '#/reglages') ouvrirReglages();
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

function renderIndex() {
  $('#countUnread').textContent = nombre(state.counts.unread);
  $('#countAll').textContent = nombre(state.counts.total);
  $('#countStarred').textContent = nombre(state.counts.starred);

  const neutre = !state.feedId && !state.folder && !state.tag;
  $$('.view-row').forEach((b) => b.classList.toggle('active', neutre && b.dataset.view === state.view));

  $('#lastRefresh').textContent = state.counts.lastRefreshAt ? 'Màj ' + quand(state.counts.lastRefreshAt) : '';
  $('#tagCount').textContent = String(state.tags.length).padStart(2, '0');
  $('#toolbarCount').textContent =
    `${nombre(state.counts.unread)} non lus · ${nombre(state.feeds.length)} sources`;

  $('#folderOptions').innerHTML = state.folders.map((f) => `<option value="${esc(f.name)}"></option>`).join('');

  renderTagList();
  renderFeedList();
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

/** La pastille de type : rien pour un article, une marque pour la vidéo et le son. */
function pastilleType(kind) {
  if (kind === 'video') {
    return `<span class="feed-badge"><svg viewBox="0 0 12 12" aria-hidden="true">
      <rect width="12" height="12" fill="#d63a2a"/><path d="M4.4 3.2 8.6 6 4.4 8.8Z" fill="#fff"/></svg></span>`;
  }
  if (kind === 'podcast') {
    return `<span class="feed-badge"><svg viewBox="0 0 12 12" aria-hidden="true">
      <rect width="12" height="12" fill="#f0a91d"/>
      <rect x="2.5" y="4.5" width="1.2" height="3" fill="#0d0d0c"/>
      <rect x="5.4" y="2.6" width="1.2" height="6.8" fill="#0d0d0c"/>
      <rect x="8.3" y="4.5" width="1.2" height="3" fill="#0d0d0c"/></svg></span>`;
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
      ? `<img class="feed-icon" src="${esc(feed.icon)}" alt="" loading="lazy">`
      : `<span class="feed-icon mono-mark" style="--teinte:${couleur};--teinte-texte:${contraste(couleur)}">${esc(initiale(feed.title))}</span>`;

    return `
      <button class="feed-row${state.feedId === feed.id ? ' active' : ''}${feed.last_error ? ' error' : ''}"
              data-feed="${feed.id}" style="--teinte:${couleur}"
              title="${esc(feed.last_error ? feed.title + ' — ' + feed.last_error : feed.title)}">
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
        <button class="folder-head${state.folder === name ? ' active' : ''}" data-toggle="${esc(name)}">
          <span class="chev"><svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg></span>
          <span class="folder-name" data-open-folder="${esc(name)}">${esc(name)}</span>
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
  return { unread: 'Non lus', all: 'Tout', starred: 'Favoris' }[state.view];
}

function sousTitre() {
  const n = state.articles.length;
  if (state.loading && !n) return 'Chargement';
  if (!n) return '';
  return nombre(n) + (state.done ? '' : '+') + ' articles';
}

async function loadArticles(reset = false) {
  if (state.loading) return;
  if (reset) {
    state.articles = [];
    state.cursor = null;
    state.done = false;
    state.pointer = -1;
    $('#scroller').scrollTop = 0;
    renderSkeleton();
  }
  if (state.done) return;

  state.loading = true;
  $('#stageTitle').textContent = titreVue();
  $('#stageSub').textContent = sousTitre();

  try {
    const data = await api.articles({
      view: state.view,
      feed: state.feedId,
      folder: state.folder,
      q: state.q,
      tag: state.tag,
      limit: state.layout === 'compact' ? 60 : 34,
      before: state.cursor
    });
    state.articles.push(...data.articles);
    state.cursor = data.nextCursor;
    state.done = !data.nextCursor;
  } catch (error) {
    toast('Chargement impossible : ' + error.message, 'bad');
    state.done = true;
  } finally {
    state.loading = false;
    renderFlux();
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

function surtitre(a, { avecDuree = true } = {}) {
  const bouts = [`<b>${esc(a.feed_title)}</b>`, esc(quand(a.published_at))];
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

/* --- les blocs de la mise en page « la une » ----------------------------- */

function blocUne(a) {
  const couleur = teinte(a.feed_title);
  const fond = a.image
    ? `<img src="${esc(relais(a.image))}" alt="" loading="lazy">`
    : `<div class="plaque-initiale" style="color:${rgba(couleur, .2)}">${esc(initialeDe(a))}</div>`;

  return `
    <div class="bloc une art${classeLue(a)}${curseur(a)}" ${attrs(a)} style="--teinte:${couleur}">
      ${fond}
      <div class="une-voile"></div>
      <div class="une-tampon">La une</div>
      <button class="une-corps" data-open="${a.id}">
        <div class="une-sur">${surtitre(a)}</div>
        <h2 class="une-titre">${esc(a.title)}</h2>
        ${a.summary ? `<p class="une-chapo">${esc(a.summary)}</p>` : ''}
      </button>
    </div>`;
}

function blocColonnes(liste) {
  return `<div class="bloc cols">${liste.map((a) => `
    <button class="col art${classeLue(a)}${curseur(a)}" ${attrs(a)} data-open="${a.id}">
      <div class="sur">${esc(a.feed_title)} <span class="quand">· ${esc(quand(a.published_at))}</span></div>
      <h3 class="col-titre">${esc(a.title)}</h3>
      <div class="wipe"></div>
      ${a.summary ? `<p class="chapo">${esc(a.summary)}</p>` : ''}
      <div class="col-pied">${esc(laDuree(a) || 'à lire')}</div>
    </button>`).join('')}</div>`;
}

function blocMur(liste) {
  return `<div class="bloc wall">${liste.map((a) => {
    const badge = estVideo(a)
      ? `<span class="badge video">▶ ${esc(duree(a.duration) || 'vidéo')}</span>`
      : estAudio(a)
        ? `<span class="badge audio">◆ ${esc(duree(a.duration))}</span>`
        : '<span class="badge">Photo</span>';
    return `
      <button class="tuile art${classeLue(a)}${curseur(a)}" ${attrs(a)} data-open="${a.id}">
        <img src="${esc(relais(a.image))}" alt="" loading="lazy">
        <span class="tuile-voile"></span>
        ${badge}
        <span class="tuile-corps">
          <span class="tuile-sur">${esc(a.feed_title)} · ${esc(quand(a.published_at))}</span>
          <span class="tuile-titre">${esc(a.title)}</span>
        </span>
      </button>`;
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
    <button class="aplat art${classeLue(large)}${curseur(large)}" ${attrs(large)} data-open="${large.id}"
            style="--teinte:${couleur};color:${contraste(couleur)}">
      <span class="aplat-initiale">${esc(initialeDe(large))}</span>
      <span class="sur">${esc(large.feed_title)} · ${esc(quand(large.published_at))}
        ${large.has_full ? '<span class="aplat-badge">Texte complet</span>' : ''}</span>
      <span class="aplat-titre">${esc(large.title)}</span>
      <span class="aplat-pied">
        ${large.summary ? `<span class="aplat-chapo">${esc(large.summary)}</span>` : '<span></span>'}
        <span class="aplat-duree">${esc(laDuree(large))}</span>
      </span>
    </button>`;

  return `<div class="bloc aplats">${bloc}${plaques.map(blocPlaque).join('')}</div>`;
}

function blocPlaque(a, i = 0) {
  const couleur = teinte(a.feed_title);
  const sombre = i % 2 === 1;
  return `
    <button class="plaque art ${sombre ? 'sombre' : 'claire'}${classeLue(a)}${curseur(a)}" ${attrs(a)}
            data-open="${a.id}" style="--teinte:${couleur};--teinte-douce:${rgba(couleur, .22)}">
      <span class="plaque-initiale">${esc(initialeDe(a))}</span>
      <span class="plaque-source">${esc(a.feed_title)}</span>
      <span class="plaque-corps">
        <span class="sur">${esc(quand(a.published_at))} · sans illustration</span>
        <span class="plaque-titre">${esc(a.title)}</span>
        <span class="wipe"></span>
        <span class="plaque-pied">${esc(laDuree(a) || 'texte indisponible')}</span>
      </span>
    </button>`;
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
        <button class="fil art${classeLue(a)}${curseur(a)}" ${attrs(a)} data-open="${a.id}">
          <span class="fil-heure">${esc(heure(a.published_at))}</span>
          <span class="fil-titre">${esc(a.title)}</span>
          <span class="fil-source">${esc(a.feed_title)}</span>
        </button>`).join('')}</div>
    </div>`;
}

/**
 * Découpe la liste en blocs de journal. Les blocs qui ont besoin d'une image
 * la réclament en priorité, sans jamais bloquer si personne n'en a.
 */
function composerUne(articles) {
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

  let premier = true;
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

function renderFlux() {
  const flux = $('#flux');
  flux.className = 'flux ' + CLASSE_LAYOUT[state.layout];

  indexParId = new Map(state.articles.map((a, i) => [a.id, i]));

  if (!state.articles.length) {
    flux.innerHTML = etatVide();
    $('#endNote').hidden = true;
    return;
  }

  if (state.layout === 'compact') flux.innerHTML = state.articles.map(ligneDepeche).join('');
  else if (state.layout === 'list') flux.innerHTML = state.articles.map(ligneSommaire).join('');
  else {
    flux.innerHTML = composerUne(state.articles).map((b) => {
      if (b.type === 'une') return b.liste.length ? blocUne(b.liste[0]) : '';
      if (b.type === 'cols') return blocColonnes(b.liste);
      if (b.type === 'wall') return blocMur(b.liste);
      if (b.type === 'aplats') return blocAplats(b.liste);
      return blocFils(b.liste);
    }).join('');
  }

  $('#endNote').hidden = !state.done;

  // Une illustration qui ne charge pas laisse la place à sa teinte.
  $$('img', flux).forEach((img) => {
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; }, { once: true });
  });
}

function ligneSommaire(a, i) {
  const couleur = teinte(a.feed_title);
  const vignette = a.image
    ? `<img src="${esc(relais(a.image))}" alt="" loading="lazy">`
    : '';
  return `
    <button class="som art${classeLue(a)}${curseur(a)}" ${attrs(a)} data-open="${a.id}">
      <span class="som-num">${String(i + 1).padStart(2, '0')}</span>
      <span>
        <span class="sur">${esc(a.feed_title)} <span class="quand">· ${esc(quand(a.published_at))}${laDuree(a) ? ' · ' + esc(laDuree(a)) : ''}</span></span>
        <span class="som-titre">${esc(a.title)}</span>
        ${a.summary ? `<span class="som-chapo">${esc(a.summary)}</span>` : ''}
      </span>
      <span class="som-thumb" style="--teinte:${couleur}">${vignette}</span>
    </button>`;
}

function ligneDepeche(a) {
  return `
    <button class="dep art${classeLue(a)}${curseur(a)}" ${attrs(a)} data-open="${a.id}">
      <span class="dep-puce" aria-hidden="true"></span>
      <span class="dep-heure">${esc(heure(a.published_at))}</span>
      <span class="dep-titre">${esc(a.title)}</span>
      <span class="dep-source">${esc(a.feed_title)}</span>
      <span class="dep-duree">${esc(a.duration ? '◆ ' + Math.round(a.duration / 60) + ' min' : '')}</span>
    </button>`;
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
  loadArticles(true);
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

async function openArticle(id) {
  const index = indexParId.get(id);
  if (index !== undefined) setPointer(index, false);
  state.openId = id;
  history.replaceState(null, '', '#/article/' + id);

  $('#reader').hidden = false;
  $('#readerScroll').innerHTML = '';
  document.body.style.overflow = 'hidden';

  try {
    const article = await api.article(id);
    if (state.openId !== id) return;
    renderReader(article);
    if (!article.read_at) await marquerLu(id, true);
    if (article.should_fetch_full) completerArticle(article);
  } catch (error) {
    toast('Article illisible : ' + error.message, 'bad');
    closeReader();
  }
}

function renderReader(a) {
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
    ? `<div class="reader-hero">
         <img src="${esc(relais(a.image))}" alt="">
         <div class="voile"></div>
         <div class="reader-hero-corps"><div class="reader-hero-inner">
           ${a.has_full ? '<span class="reader-badge">Texte complet</span>' : ''}
           <div class="reader-meta">${meta}</div>
           <h1 class="reader-titre">${esc(a.title)}</h1>
         </div></div>
       </div>`
    : `<div class="reader-hero plaque-hero" style="--teinte:${couleur}">
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
  $('#readerProgress').style.width = '0%';

  $$('.reader-body img, .reader-hero img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (src && !src.startsWith('data:') && !src.startsWith('/api/image')) {
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      img.src = relais(src);
    }
    img.addEventListener('error', () => { img.style.display = 'none'; }, { once: true });
  });

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
  return chips + `<input class="tag-input" id="tagInput" list="tagOptions" autocomplete="off"
    placeholder="+ étiquette" aria-label="Ajouter une étiquette" maxlength="60">`;
}

async function etiqueter(id, action) {
  try {
    const article = await api.tag(id, action);
    const local = state.articles.find((a) => a.id === id);
    if (local) local.tags = article.tags;
    if (state.openId === id) $('#tagEditor').innerHTML = editeurTags(article);
    await reloadState();
  } catch (error) {
    toast('Étiquette : ' + error.message, 'bad');
  }
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

function closeReader() {
  state.openId = null;
  history.replaceState(null, '', location.pathname);
  $('#reader').hidden = true;
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
    await api.patch(id, { read: lu });
    await reloadState();
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
    await api.patch(id, { starred: valeur });
    await reloadState();
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
    if (!$('#reader').hidden) return closeReader();
    if (!$('#modalShade').hidden) return closeModals();
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
    if (state.openId) { const s = articleSuivant(); if (s) openArticle(s.id); return; }
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
  if (key === 't' && state.openId) { event.preventDefault(); $('#tagInput')?.focus(); return; }
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

async function toutMarquerLu() {
  const payload = state.feedId ? { feedId: state.feedId } : state.folder ? { folder: state.folder } : { all: true };
  try {
    const r = await api.markRead(payload);
    await reloadState();
    toast(r.changed ? `${nombre(r.changed)} articles marqués lus` : 'Déjà tout lu');
    await loadArticles(true);
  } catch (error) {
    toast('Échec : ' + error.message, 'bad');
  }
}

/* -------------------------------------------------------------- fenêtres */

function openModal(sel) {
  closeModals();
  $('#modalShade').hidden = false;
  $(sel).hidden = false;
}
function closeModals() {
  $('#modalShade').hidden = true;
  $$('.modal').forEach((m) => (m.hidden = true));
}
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
    toast(`${esc(r.feed.title)} · ${nombre(r.added || 0)} articles`);
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
    toast(`${r.added} sources ajoutées — téléchargement en cours`);
    setTimeout(() => reloadState().then(() => loadArticles(true)), 8000);
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

/* ---------------------------------------------------------- branchements */

function wireEvents() {
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

  $('#flux').addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open) { openArticle(Number(open.dataset.open)); return; }
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
    state.q = $('#search').value.trim();
    if (state.q) { state.feedId = null; state.folder = null; state.tag = null; state.view = 'all'; renderIndex(); }
    loadArticles(true);
  }, 300);
  $('#search').addEventListener('input', chercher);

  $('#refreshBtn').addEventListener('click', rafraichir);
  $('#markAllRead').addEventListener('click', toutMarquerLu);
  $('#addFeedBtn').addEventListener('click', () => { openModal('#feedModal'); $('#feedUrl').focus(); });
  $('#addFeedRail').addEventListener('click', () => { openModal('#feedModal'); $('#feedUrl').focus(); });
  $('#railOpen').addEventListener('click', () => $('#app').classList.add('rail-on'));
  $('#railClose').addEventListener('click', closeRail);

  $('#readerClose').addEventListener('click', closeReader);
  $('#readerStar').addEventListener('click', () => state.openId && basculerFavori(state.openId));
  $('#readerTag').addEventListener('click', () => $('#tagInput')?.focus());
  $('#readerFull').addEventListener('click', () => state.openId && completerArticle({ id: state.openId }, true));
  $('#readerUnread').addEventListener('click', async () => {
    if (!state.openId) return;
    const id = state.openId;
    closeReader();
    await marquerLu(id, false);
    toast('Marqué non lu');
  });

  $('#readerScroll').addEventListener('click', (e) => {
    const off = e.target.closest('[data-untag]');
    if (off && state.openId) { etiqueter(state.openId, { remove: [off.dataset.untag] }); return; }
    const jump = e.target.closest('[data-goto-tag]');
    if (jump) { closeReader(); setView({ view: 'all', tag: jump.dataset.gotoTag }); return; }
    if (e.target.closest('[data-retry]') && state.openId) { completerArticle({ id: state.openId }, true); return; }
    const next = e.target.closest('[data-next]');
    if (next) openArticle(Number(next.dataset.next));
  });
  $('#readerScroll').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches('#tagInput')) return;
    e.preventDefault();
    const noms = e.target.value.split(',').map((n) => n.trim()).filter(Boolean);
    e.target.value = '';
    if (noms.length && state.openId) etiqueter(state.openId, { add: noms });
  });
  $('#readerScroll').addEventListener('scroll', () => {
    const el = $('#readerScroll');
    const max = el.scrollHeight - el.clientHeight;
    $('#readerProgress').style.width = (max > 0 ? (el.scrollTop / max) * 100 : 0) + '%';
  });

  $('#modalShade').addEventListener('click', closeModals);
  $$('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
  $('#openSettings').addEventListener('click', ouvrirReglages);
  $('#shortcutsBtn').addEventListener('click', () => openModal('#shortcutsModal'));
  $('#openShortcuts').addEventListener('click', () => openModal('#shortcutsModal'));

  $('#accentChoices').addEventListener('click', (e) => {
    const s = e.target.closest('[data-accent]');
    if (!s) return;
    applyAccent(s.dataset.accent);
    renderAccents();
  });

  $('#feedForm').addEventListener('submit', ajouterFlux);
  $('#importOpml').addEventListener('click', () => $('#opmlFile').click());
  $('#opmlFile').addEventListener('change', importerOpml);
  $('#settingsForm').addEventListener('submit', enregistrerReglages);
  $('#feedEditForm').addEventListener('submit', enregistrerFlux);
  $('#deleteFeed').addEventListener('click', supprimerFlux);

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
