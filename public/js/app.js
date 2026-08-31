import { api } from './api.js';
import { esc, quand, dateLongue, tempsLecture, relais, hote, debounce, pluriel } from './util.js';

const $ = (sel, scope = document) => scope.querySelector(sel);
const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];

/* ------------------------------------------------------------------- etat */

const state = {
  view: 'unread',        // unread | all | starred
  feedId: null,
  folder: null,
  q: '',
  layout: 'magazine',    // magazine | list | compact
  articles: [],
  cursor: null,          // curseur de pagination
  loading: false,
  done: false,
  pointer: -1,           // index selectionne au clavier
  openId: null,
  feeds: [],
  folders: [],
  counts: { unread: 0, starred: 0, total: 0 },
  settings: {}
};

const collapsed = new Set(JSON.parse(localStorage.getItem('bublee.collapsed') || '[]'));

const SUGGESTIONS = [
  { title: 'Le Monde — Une',   url: 'https://www.lemonde.fr/rss/une.xml',                 folder: 'Actualité' },
  { title: 'France Info',      url: 'https://www.francetvinfo.fr/titres.rss',             folder: 'Actualité' },
  { title: 'Radio-Canada',     url: 'https://ici.radio-canada.ca/rss/4159',               folder: 'Actualité' },
  { title: 'Numerama',         url: 'https://www.numerama.com/feed/',                     folder: 'Tech' },
  { title: 'Korben',           url: 'https://korben.info/feed',                           folder: 'Tech' },
  { title: 'Hacker News',      url: 'https://hnrss.org/frontpage',                        folder: 'Tech' },
  { title: 'Ars Technica',     url: 'https://feeds.arstechnica.com/arstechnica/index',    folder: 'Tech' },
  { title: 'The Verge',        url: 'https://www.theverge.com/rss/index.xml',             folder: 'Tech' }
];

/* ----------------------------------------------------------------- toasts */

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, kind === 'bad' ? 4600 : 2800);
}

/* --------------------------------------------------------------- demarrage */

async function boot() {
  applyTheme(localStorage.getItem('bublee.theme') || 'auto');
  try {
    const data = await api.state();
    absorb(data);
    state.layout = data.settings.layout || 'magazine';
    applyLayout(state.layout);
    await loadArticles(true);
  } catch (error) {
    toast('Le serveur ne répond pas : ' + error.message, 'bad');
  }
  wireEvents();

  // Lien direct vers un article : #/article/482
  const cible = /^#\/article\/(\d+)$/.exec(location.hash);
  if (cible) openArticle(Number(cible[1]));
}

function absorb(data) {
  state.feeds = data.feeds;
  state.folders = data.folders;
  state.counts = data.counts;
  state.settings = data.settings;
  renderRail();
}

async function reloadState() {
  absorb(await api.state());
}

/* ------------------------------------------------------------ colonne gauche */

function renderRail() {
  $('#countUnread').textContent = state.counts.unread;
  $('#countUnread').classList.toggle('zero', !state.counts.unread);
  $('#countAll').textContent = state.counts.total;
  $('#countStarred').textContent = state.counts.starred;
  $('#countStarred').classList.toggle('zero', !state.counts.starred);

  $$('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', !state.feedId && !state.folder && btn.dataset.view === state.view);
  });

  $('#lastRefresh').textContent = state.counts.lastRefreshAt
    ? 'Màj ' + quand(state.counts.lastRefreshAt)
    : '';

  $('#folderOptions').innerHTML = state.folders
    .map((f) => `<option value="${esc(f.name)}"></option>`).join('');

  renderFeedList();
}

function renderFeedList() {
  const groups = new Map();
  for (const feed of state.feeds) {
    const key = feed.folder || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(feed);
  }

  const monogramme = (titre) => (String(titre).match(/[\p{L}\p{N}]/u)?.[0] || '•').toUpperCase();

  const feedRow = (feed) => `
    <button class="feed-row${state.feedId === feed.id ? ' active' : ''}${feed.last_error ? ' error' : ''}"
            data-feed="${feed.id}" title="${esc(feed.last_error ? feed.title + ' — ' + feed.last_error : feed.title)}">
      ${feed.icon
        ? `<img class="feed-icon" src="${esc(feed.icon)}" alt="" loading="lazy">`
        : `<span class="feed-icon mono">${esc(monogramme(feed.title))}</span>`}
      <span class="feed-name">${esc(feed.title)}</span>
      ${feed.last_error ? '<span class="feed-warn" aria-label="Source injoignable">!</span>' : ''}
      <span class="feed-count">${feed.unread || ''}</span>
      <span class="feed-edit" data-edit="${feed.id}" title="Modifier">
        <svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/></svg>
      </span>
    </button>`;

  const blocks = [];
  const loose = groups.get('') || [];
  if (loose.length) blocks.push(`<div class="folder-body">${loose.map(feedRow).join('')}</div>`);

  for (const [name, feeds] of [...groups].filter(([k]) => k).sort(([a], [b]) => a.localeCompare(b, 'fr'))) {
    const unread = feeds.reduce((sum, f) => sum + f.unread, 0);
    const isClosed = collapsed.has(name);
    blocks.push(`
      <div class="folder${isClosed ? ' collapsed' : ''}" data-folder="${esc(name)}">
        <button class="folder-head${state.folder === name ? ' active' : ''}" data-toggle="${esc(name)}">
          <span class="chev"><svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg></span>
          <span class="folder-name" data-open-folder="${esc(name)}">${esc(name)}</span>
          <span class="folder-rule"></span>
          <span class="folder-count">${unread || ''}</span>
        </button>
        <div class="folder-body">${feeds.map(feedRow).join('')}</div>
      </div>`);
  }

  $('#feedList').innerHTML = blocks.join('') ||
    '<p class="field-note" style="padding:8px 10px">Aucune source pour l’instant.</p>';
}

/* ------------------------------------------------------------ chargement */

function titreVue() {
  if (state.q) return `« ${state.q} »`;
  if (state.feedId) {
    const feed = state.feeds.find((f) => f.id === state.feedId);
    return feed ? feed.title : 'Source';
  }
  if (state.folder) return state.folder;
  return { unread: 'Non lus', all: 'Tout', starred: 'Favoris' }[state.view];
}

function sousTitre() {
  const n = state.articles.length;
  if (state.loading && !n) return 'Chargement…';
  if (!n) return '';
  const suffixe = state.done ? '' : '+';
  return pluriel(n, 'article') + suffixe;
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
      limit: state.layout === 'compact' ? 60 : 30,
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

/* -------------------------------------------------------------- rendu flux */

function renderSkeleton() {
  const bloc = `
    <article class="card skeleton">
      <div class="sk media"></div>
      <div class="sk line short"></div>
      <div class="sk line title"></div>
      <div class="sk line"></div>
      <div class="sk line short"></div>
    </article>`;
  $('#flux').innerHTML = bloc.repeat(6);
  $('#endNote').hidden = true;
}

/** Teinte stable par source : une même source garde toujours la sienne. */
function teinte(texte) {
  let h = 0;
  for (const c of String(texte || '')) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h % 5;
}

/**
 * Quand aucune illustration n'existe (l'éditeur n'en fournit pas, ou son
 * site refuse les robots), on compose une plaque typographique : grande
 * initiale de l'article, nom de la source, teinte de la source.
 */
function plaque(article) {
  const initiale = (String(article.title).match(/[\p{L}\p{N}]/u)?.[0] || '§').toUpperCase();
  return `
    <div class="card-media plate" data-plate="${teinte(article.feed_title)}" aria-hidden="true">
      <span class="plate-mark">${esc(initiale)}</span>
      <span class="plate-source">${esc(article.feed_title)}</span>
    </div>`;
}

function carte(article, index) {
  const classes = ['card'];
  if (article.read_at) classes.push('read');
  if (index === 0) classes.push('hero');
  else if (index > 3 && (index - 4) % 7 === 0) classes.push('wide');
  if (index === state.pointer) classes.push('cursor');

  const media = article.image
    ? `<div class="card-media"><img src="${esc(relais(article.image))}" alt="" loading="lazy"></div>`
    : plaque(article);

  const lecture = tempsLecture(article.word_count);

  return `
    <article class="${classes.join(' ')}" data-id="${article.id}" data-index="${index}">
      ${media}
      <div class="card-body">
        <div class="card-kicker">
          <span class="src">${esc(article.feed_title)}</span>
          <span class="dot"></span>
          <span class="when">${esc(quand(article.published_at))}</span>
        </div>
        <h2 class="card-title">${esc(article.title)}</h2>
        ${article.summary ? `<p class="card-dek">${esc(article.summary)}</p>` : ''}
      </div>
      <div class="card-foot">
        ${lecture ? `<span>${lecture}</span>` : '<span></span>'}
        <button class="star${article.starred ? ' on' : ''}" data-star="${article.id}"
                title="${article.starred ? 'Retirer des favoris' : 'Mettre en favori'}" aria-label="Favori">
          <svg viewBox="0 0 24 24"><path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/></svg>
        </button>
      </div>
    </article>`;
}

function renderFlux() {
  const flux = $('#flux');

  if (!state.articles.length) {
    flux.innerHTML = etatVide();
    $('#endNote').hidden = true;
    return;
  }

  flux.innerHTML = state.articles.map(carte).join('');
  $('#endNote').hidden = !state.done;

  // Une image qui ne charge pas cede la place a la plaque typographique.
  $$('.card-media img', flux).forEach((img) => {
    img.addEventListener('error', () => {
      const carteParente = img.closest('.card');
      const media = img.closest('.card-media');
      const article = state.articles.find((a) => a.id === Number(carteParente?.dataset.id));
      if (!media || !article) return;
      media.outerHTML = plaque(article);
    }, { once: true });
  });
}

function etatVide() {
  if (state.q) {
    return `<div class="empty">
      <h2>Rien pour « ${esc(state.q)} »</h2>
      <p>Essaie un autre mot, ou élargis la vue à « Tout ».</p>
      <div class="empty-actions"><button class="ghost-btn" data-clear-search>Effacer la recherche</button></div>
    </div>`;
  }

  if (!state.feeds.length) {
    return `<div class="empty">
      <div class="empty-glyph"><svg viewBox="0 0 100 100" fill="currentColor" stroke="none">
        <circle cx="26" cy="74" r="10"/><path d="M18 44a38 38 0 0 1 38 38H42a24 24 0 0 0-24-24z"/>
        <path d="M18 16a66 66 0 0 1 66 66H70A52 52 0 0 0 18 30z"/></svg></div>
      <h2>Ton kiosque est vide</h2>
      <p>Ajoute une source, ou importe ton export OPML depuis Feedly pour tout récupérer d’un coup.</p>
      <div class="empty-actions">
        <button class="accent-btn" data-add-feed>＋ Ajouter une source</button>
        <button class="ghost-btn" data-import-opml>Importer un OPML</button>
      </div>
      <div class="suggestions">
        <h3>Pour commencer</h3>
        <div class="suggestion-grid">
          ${SUGGESTIONS.map((s, i) => `
            <button class="suggestion" data-suggest="${i}">
              <span>${esc(s.title)}</span><span class="plus">＋</span>
            </button>`).join('')}
        </div>
      </div>
    </div>`;
  }

  if (state.view === 'unread') {
    return `<div class="empty">
      <div class="empty-glyph"><svg viewBox="0 0 24 24"><path d="m5 13 4 4L19 7"/></svg></div>
      <h2>Tout est lu</h2>
      <p>Belle discipline. Reviens plus tard, ou relis ce qui est passé.</p>
      <div class="empty-actions">
        <button class="ghost-btn" data-goto-view="all">Voir tous les articles</button>
        <button class="ghost-btn" data-refresh>Rafraîchir</button>
      </div>
    </div>`;
  }

  if (state.view === 'starred') {
    return `<div class="empty">
      <div class="empty-glyph"><svg viewBox="0 0 24 24"><path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/></svg></div>
      <h2>Aucun favori</h2>
      <p>Appuie sur <kbd>S</kbd> sur un article pour le garder sous la main.</p>
    </div>`;
  }

  return `<div class="empty"><h2>Rien à afficher</h2>
    <p>Cette source n’a pas encore d’article. Un rafraîchissement peut aider.</p>
    <div class="empty-actions"><button class="ghost-btn" data-refresh>Rafraîchir</button></div></div>`;
}

/* ------------------------------------------------------------------ vues */

function setView({ view, feedId = null, folder = null }) {
  state.view = view ?? state.view;
  state.feedId = feedId;
  state.folder = folder;
  closeRail();
  renderRail();
  loadArticles(true);
}

function applyLayout(layout) {
  state.layout = layout;
  $('#flux').className = 'flux ' + layout;
  $$('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.layout === layout));
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('bublee.theme', theme);
}

/* --------------------------------------------------------------- lecteur */

async function openArticle(id) {
  const index = state.articles.findIndex((a) => a.id === id);
  if (index >= 0) setPointer(index, false);
  state.openId = id;
  history.replaceState(null, '', '#/article/' + id);

  $('#readerShade').hidden = false;
  $('#reader').hidden = false;
  $('#readerScroll').innerHTML = `<div class="reader-loading">
    <div class="skeleton"><div class="sk line short"></div><div class="sk line title"></div>
    <div class="sk line title"></div><div class="sk line"></div><div class="sk line"></div>
    <div class="sk line"></div><div class="sk line short"></div></div></div>`;
  document.body.style.overflow = 'hidden';

  try {
    const article = await api.article(id);
    if (state.openId !== id) return;
    renderReader(article);
    if (!article.read_at) await marquerLu(id, true);

    // Flux qui ne publient qu'un aperçu : on va chercher la suite chez l'editeur.
    if (article.should_fetch_full) completerArticle(article);
  } catch (error) {
    toast('Article illisible : ' + error.message, 'bad');
    closeReader();
  }
}

/** Recupere le texte complet et rejoue le rendu du lecteur. */
async function completerArticle(article, force = false) {
  const zone = $('#fullState');
  if (zone) {
    zone.hidden = false;
    zone.className = 'full-state';
    zone.textContent = 'Récupération du texte complet…';
  }
  try {
    const complet = await api.full(article.id, force);
    if (state.openId !== article.id) return;
    renderReader(complet);
  } catch (error) {
    if (state.openId !== article.id) return;
    const el = $('#fullState');
    if (!el) return;
    el.hidden = false;
    el.className = 'full-state bad';
    el.innerHTML = `Texte complet indisponible — ${esc(error.message)} `
      + '<button class="link-btn" data-retry>réessayer</button>';
  }
}

function renderReader(article) {
  const suivant = articleSuivant();

  $('#readerStar').classList.toggle('on', Boolean(article.starred));
  const lien = $('#readerOpen');
  lien.href = article.url || '#';
  lien.style.visibility = article.url ? '' : 'hidden';

  const meta = [];
  if (article.author) meta.push(`<span class="author">${esc(article.author)}</span>`);
  meta.push(esc(dateLongue(article.published_at)));
  const lecture = tempsLecture(article.word_count);
  if (lecture) meta.push(esc(lecture));
  if (article.url) meta.push(esc(hote(article.url)));

  const corps = article.content && article.content.length > 40
    ? article.content
    : `<p>${esc(article.summary || 'Cet article ne fournit pas de contenu dans son flux.')}</p>
       ${article.url ? `<p><a href="${esc(article.url)}" target="_blank" rel="noopener">Lire sur le site d’origine ↗</a></p>` : ''}`;

  // Les autres flux qui relaient la meme histoire.
  const sources = article.also_in?.length
    ? `<p class="reader-sources">Aussi publié par ${
      article.also_in.map((s) => `<strong>${esc(s.feed_title)}</strong>`).join(', ')}</p>`
    : '';

  // On ne repete pas l'image d'ouverture si elle est deja dans le corps.
  const heroDansCorps = article.image && article.content?.includes(article.image);
  const hero = article.image && !heroDansCorps
    ? `<figure class="reader-hero"><img src="${esc(relais(article.image))}" alt=""></figure>`
    : '';

  $('#readerScroll').innerHTML = `
    <div class="reader-inner">
      <div class="reader-kicker">
        ${article.feed_icon ? `<img src="${esc(article.feed_icon)}" alt="">` : ''}
        <span>${esc(article.feed_title)}</span>
        <span class="when">· ${esc(quand(article.published_at))}</span>
      </div>
      <h1 class="reader-title">${esc(article.title)}</h1>
      <div class="reader-byline">
        ${meta.join('<span class="sep"></span>')}
        ${article.has_full ? '<span class="tag">texte complet</span>' : ''}
      </div>
      ${sources}
      ${hero}
      <div class="full-state" id="fullState" hidden></div>
      <div class="reader-body">${corps}</div>
      <div class="reader-end">
        ${article.url ? `<a class="ghost-btn" href="${esc(article.url)}" target="_blank" rel="noopener">Article original ↗</a>` : ''}
        ${suivant ? `<button class="accent-btn" data-next="${suivant.id}">Article suivant →</button>` : ''}
        ${suivant ? `<span class="next-hint">${esc(suivant.title.slice(0, 60))}${suivant.title.length > 60 ? '…' : ''}</span>` : ''}
      </div>
    </div>`;

  $('#readerScroll').scrollTop = 0;
  $('#readerProgress').style.width = '0%';

  // Toutes les images passent par le relais : beaucoup d'hebergeurs refusent
  // le hotlink, et cela evite d'exposer le lecteur aux traceurs des editeurs.
  $$('.reader-body img, .reader-hero img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (src && !src.startsWith('data:') && !src.startsWith('/api/image')) {
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      img.src = relais(src);
    }
    img.addEventListener('error', () => {
      const figure = img.closest('.reader-hero');
      if (figure) figure.remove(); else img.style.display = 'none';
    }, { once: true });
  });

  // La lettrine se pose sur le premier vrai paragraphe de texte.
  // Pas de `>` : Readability enveloppe son extraction dans un conteneur.
  const premier = $$('.reader-body p').find((p) => {
    const texte = p.textContent.trim();
    return texte.length > 90 && !p.querySelector('img') && /^[\p{L}\p{N}]/u.test(texte);
  });
  premier?.classList.add('lettrine');
}

function articleSuivant() {
  const index = state.articles.findIndex((a) => a.id === state.openId);
  return index >= 0 ? state.articles[index + 1] : null;
}

function closeReader() {
  state.openId = null;
  history.replaceState(null, '', location.pathname);
  $('#reader').hidden = true;
  $('#readerShade').hidden = true;
  document.body.style.overflow = '';
}

/* -------------------------------------------------- lu / non lu / favoris */

function patchLocal(id, patch) {
  const article = state.articles.find((a) => a.id === id);
  if (!article) return;
  Object.assign(article, patch);
  const card = $(`.card[data-id="${id}"]`);
  if (!card) return;
  card.classList.toggle('read', Boolean(article.read_at));
  const star = $('.star', card);
  if (star) star.classList.toggle('on', Boolean(article.starred));
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
  const article = state.articles.find((a) => a.id === id);
  const valeur = article ? !article.starred : true;
  patchLocal(id, { starred: valeur ? 1 : 0 });
  if (state.openId === id) $('#readerStar').classList.toggle('on', valeur);
  try {
    await api.patch(id, { starred: valeur });
    state.counts.starred += valeur ? 1 : -1;
    renderRail();
    toast(valeur ? 'Ajouté aux favoris' : 'Retiré des favoris');
  } catch (error) {
    toast('Échec : ' + error.message, 'bad');
  }
}

/* --------------------------------------------------------------- clavier */

function setPointer(index, scroll = true) {
  const borne = Math.max(0, Math.min(index, state.articles.length - 1));
  $$('.card.cursor').forEach((c) => c.classList.remove('cursor'));
  state.pointer = borne;
  const card = $(`.card[data-index="${borne}"]`);
  if (card) {
    card.classList.add('cursor');
    if (scroll) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  // Precharge la suite quand on approche de la fin.
  if (borne > state.articles.length - 6) loadArticles();
}

function articleCourant() {
  if (state.openId) return state.openId;
  return state.articles[state.pointer]?.id ?? null;
}

function onKey(event) {
  const tag = event.target.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) {
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
    const article = state.articles.find((a) => a.id === id);
    marquerLu(id, !article?.read_at);
    return;
  }
  if (key === 'v') {
    const article = state.articles.find((a) => a.id === id);
    if (article?.url) window.open(article.url, '_blank', 'noopener');
    return;
  }
  if (key === 'f' && state.openId) { event.preventDefault(); completerArticle({ id: state.openId }, true); }
}

/* ------------------------------------------------------------- actions */

async function rafraichir() {
  const btn = $('#refreshBtn');
  btn.classList.add('spin');
  try {
    const result = await api.refreshAll();
    await reloadState();
    if (result.added) {
      toast(`${pluriel(result.added, 'nouvel article', 'nouveaux articles')}`);
      await loadArticles(true);
    } else {
      toast('Rien de neuf');
    }
    if (result.errors?.length) {
      toast(`${pluriel(result.errors.length, 'source injoignable')}`, 'bad');
    }
  } catch (error) {
    toast('Rafraîchissement impossible : ' + error.message, 'bad');
  } finally {
    btn.classList.remove('spin');
  }
}

async function toutMarquerLu() {
  const payload = state.feedId ? { feedId: state.feedId }
    : state.folder ? { folder: state.folder }
      : { all: true };
  try {
    const result = await api.markRead(payload);
    await reloadState();
    toast(result.changed ? `${pluriel(result.changed, 'article')} marqué${result.changed > 1 ? 's' : ''} comme lu${result.changed > 1 ? 's' : ''}` : 'Déjà tout lu');
    await loadArticles(true);
  } catch (error) {
    toast('Échec : ' + error.message, 'bad');
  }
}

/* ------------------------------------------------------------- fenetres */

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

/* -------------------------------------------------------------- branchements */

function wireEvents() {
  // --- vues
  $$('.nav-item').forEach((btn) =>
    btn.addEventListener('click', () => setView({ view: btn.dataset.view })));

  // --- sources
  $('#feedList').addEventListener('click', (event) => {
    const edit = event.target.closest('[data-edit]');
    if (edit) {
      event.stopPropagation();
      ouvrirEditionFlux(Number(edit.dataset.edit));
      return;
    }
    // Le nom ouvre le dossier ; le chevron (et le reste de l'en-tete) le replie.
    const openFolder = event.target.closest('[data-open-folder]');
    if (openFolder) {
      setView({ view: state.view, folder: openFolder.dataset.openFolder });
      return;
    }
    const toggle = event.target.closest('[data-toggle]');
    if (toggle) {
      const name = toggle.dataset.toggle;
      collapsed.has(name) ? collapsed.delete(name) : collapsed.add(name);
      localStorage.setItem('bublee.collapsed', JSON.stringify([...collapsed]));
      renderFeedList();
      return;
    }
    const row = event.target.closest('[data-feed]');
    if (row) setView({ view: state.view === 'starred' ? 'all' : state.view, feedId: Number(row.dataset.feed) });
  });

  // --- mise en page
  $$('.seg button').forEach((btn) => btn.addEventListener('click', () => {
    applyLayout(btn.dataset.layout);
    renderFlux();
    api.settings({ layout: btn.dataset.layout }).catch(() => {});
  }));

  // --- flux d'articles
  $('#flux').addEventListener('click', (event) => {
    const star = event.target.closest('[data-star]');
    if (star) { event.stopPropagation(); basculerFavori(Number(star.dataset.star)); return; }

    const card = event.target.closest('.card');
    if (card && !card.classList.contains('skeleton')) { openArticle(Number(card.dataset.id)); return; }

    const suggest = event.target.closest('[data-suggest]');
    if (suggest) { ajouterSuggestion(Number(suggest.dataset.suggest), suggest); return; }

    if (event.target.closest('[data-add-feed]')) { openModal('#feedModal'); $('#feedUrl').focus(); return; }
    if (event.target.closest('[data-import-opml]')) { $('#opmlFile').click(); return; }
    if (event.target.closest('[data-refresh]')) { rafraichir(); return; }
    if (event.target.closest('[data-clear-search]')) { $('#search').value = ''; state.q = ''; loadArticles(true); return; }
    const goto = event.target.closest('[data-goto-view]');
    if (goto) setView({ view: goto.dataset.gotoView });
  });

  // --- defilement infini
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !state.loading && !state.done && state.articles.length) loadArticles();
  }, { root: $('#scroller'), rootMargin: '600px' }).observe($('#sentinel'));

  // --- recherche
  const chercher = debounce(() => {
    state.q = $('#search').value.trim();
    if (state.q) { state.feedId = null; state.folder = null; state.view = 'all'; renderRail(); }
    loadArticles(true);
  }, 300);
  $('#search').addEventListener('input', chercher);

  // --- barre du haut
  $('#refreshBtn').addEventListener('click', rafraichir);
  $('#markAllRead').addEventListener('click', toutMarquerLu);
  $('#addFeedBtn').addEventListener('click', () => { openModal('#feedModal'); $('#feedUrl').focus(); });
  $('#addFeedRail').addEventListener('click', () => { openModal('#feedModal'); $('#feedUrl').focus(); });
  $('#railOpen').addEventListener('click', () => $('#app').classList.add('rail-on'));
  $('#railClose').addEventListener('click', closeRail);

  // --- lecteur
  $('#readerClose').addEventListener('click', closeReader);
  $('#readerShade').addEventListener('click', closeReader);
  $('#readerStar').addEventListener('click', () => state.openId && basculerFavori(state.openId));
  $('#readerUnread').addEventListener('click', async () => {
    if (!state.openId) return;
    const id = state.openId;
    closeReader();
    await marquerLu(id, false);
    toast('Marqué comme non lu');
  });
  $('#readerFull').addEventListener('click', () => {
    if (state.openId) completerArticle({ id: state.openId }, true);
  });
  $('#readerScroll').addEventListener('click', (event) => {
    if (event.target.closest('[data-retry]')) {
      if (state.openId) completerArticle({ id: state.openId }, true);
      return;
    }
    const next = event.target.closest('[data-next]');
    if (next) openArticle(Number(next.dataset.next));
  });
  $('#readerScroll').addEventListener('scroll', () => {
    const el = $('#readerScroll');
    const max = el.scrollHeight - el.clientHeight;
    $('#readerProgress').style.width = (max > 0 ? (el.scrollTop / max) * 100 : 0) + '%';
  });

  // --- fenetres
  $('#modalShade').addEventListener('click', closeModals);
  $$('[data-close]').forEach((btn) => btn.addEventListener('click', closeModals));
  $('#openSettings').addEventListener('click', ouvrirReglages);

  $('#feedForm').addEventListener('submit', ajouterFlux);
  $('#importOpml').addEventListener('click', () => $('#opmlFile').click());
  $('#opmlFile').addEventListener('change', importerOpml);
  $('#settingsForm').addEventListener('submit', enregistrerReglages);
  $('#feedEditForm').addEventListener('submit', enregistrerFlux);
  $('#deleteFeed').addEventListener('click', supprimerFlux);

  $('#repairAll').addEventListener('click', reparerTout);
  $('#repairFeed').addEventListener('click', async (event) => {
    const id = Number($('#editFeedId').value);
    event.target.disabled = true;
    event.target.textContent = 'Recherche…';
    try {
      afficherRapport(await api.repairFeed(id));
      await reloadState();
    } catch (error) {
      toast('Réparation impossible : ' + error.message, 'bad');
    } finally {
      event.target.disabled = false;
      event.target.textContent = 'Réparer';
    }
  });
  $('#repairList').addEventListener('click', (event) => {
    const bouton = event.target.closest('[data-accept]');
    if (bouton) adopterAdresse(Number(bouton.dataset.accept), bouton.dataset.url, bouton);
  });

  $('#dedupeAll').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const resultat = await api.dedupe(true);
      await reloadState();
      toast(resultat.linked
        ? `${pluriel(resultat.linked, 'doublon')} regroupé${resultat.linked > 1 ? 's' : ''}`
        : 'Aucun doublon trouvé');
      loadArticles(true);
    } catch (error) {
      toast('Échec : ' + error.message, 'bad');
    } finally {
      event.target.disabled = false;
    }
  });

  document.addEventListener('keydown', onKey);
}

/* ------------------------------------------------------------ ajout de flux */

async function ajouterFlux(event) {
  event.preventDefault();
  const btn = $('#feedSubmit');
  const url = $('#feedUrl').value.trim();
  if (!url) return;

  btn.disabled = true;
  btn.textContent = 'Recherche…';
  try {
    const result = await api.addFeed(url, $('#feedFolder').value.trim());
    await reloadState();
    closeModals();
    $('#feedForm').reset();
    toast(`« ${result.feed.title || url} » ajouté · ${pluriel(result.added || 0, 'article')}`);
    setView({ view: 'unread', feedId: result.feed.id });
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
  const suggestion = SUGGESTIONS[index];
  element.classList.add('done');
  element.querySelector('.plus').textContent = '…';
  try {
    await api.addFeed(suggestion.url, suggestion.folder);
    await reloadState();
    element.querySelector('.plus').textContent = '✓';
    toast(`« ${suggestion.title} » ajouté`);
    loadArticles(true);
  } catch (error) {
    element.classList.remove('done');
    element.querySelector('.plus').textContent = '＋';
    toast(error.message, 'bad');
  }
}

async function importerOpml(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  event.target.value = '';
  try {
    const xml = await file.text();
    const result = await api.importOpml(xml);
    await reloadState();
    closeModals();
    toast(`${pluriel(result.added, 'source ajoutée', 'sources ajoutées')}${result.skipped ? ` · ${result.skipped} ignorée${result.skipped > 1 ? 's' : ''}` : ''} — téléchargement en cours…`);
    setTimeout(() => reloadState().then(() => loadArticles(true)), 8000);
  } catch (error) {
    toast('Import impossible : ' + error.message, 'bad');
  }
}

/* --------------------------------------------------------- edition d'un flux */

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
  try {
    const feed = state.feeds.find((f) => f.id === id);
    const url = $('#editFeedUrl').value.trim();

    await api.updateFeed(id, {
      custom_title: $('#editFeedTitle').value.trim(),
      folder: $('#editFeedFolder').value.trim(),
      ...(url && url !== feed?.url ? { url } : {})
    });
    // Adresse changée à la main : on va voir tout de suite si elle répond.
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
    if (state.feedId === id) setView({ view: state.view });
    else loadArticles(true);
    toast('Source supprimée');
  } catch (error) {
    toast('Échec : ' + error.message, 'bad');
  }
}

/* --------------------------------------------- reparation des sources */

const LIBELLES = {
  repare: ['ok', 'réparée'],
  propose: ['nok', 'à confirmer'],
  doublon: ['nok', 'déjà présente'],
  introuvable: ['nok', 'introuvable'],
  echec: ['nok', 'échec']
};

function ligneReparation(r) {
  const [ton, libelle] = LIBELLES[r.status] || LIBELLES.echec;

  const detail = r.status === 'repare'
    ? `Nouvelle adresse : <b>${esc(r.toTitle || '')}</b><br><span class="repair-url">${esc(r.to)}</span>`
    : r.status === 'propose'
      ? r.candidates.map((c) => `
          <div class="repair-cand">
            <button class="ghost-btn" data-accept="${r.feedId}" data-url="${esc(c.url)}">Adopter</button>
            <span><b>${esc(c.title || 'sans titre')}</b> · ${c.confiance}% de ressemblance
              <br><span class="repair-url">${esc(c.url)}</span></span>
          </div>`).join('')
      : `<span class="repair-url">${esc(r.from || '')}</span>`;

  return `
    <div class="repair-row" data-feed-row="${r.feedId}">
      <div>
        <div class="repair-name">${esc(r.title || 'Source ' + r.feedId)}</div>
        <div class="repair-detail">${detail}</div>
      </div>
      <span class="repair-tag ${ton}">${libelle}</span>
    </div>`;
}

function afficherRapport(rapport) {
  const resultats = rapport.results || [rapport];
  const auto = resultats.filter((r) => r.status === 'repare').length;
  const props = resultats.filter((r) => r.status === 'propose').length;

  $('#repairSummary').innerHTML = auto || props
    ? `${auto ? pluriel(auto, 'source réparée', 'sources réparées') + ' automatiquement' : 'Aucune réparation automatique'}`
      + `${props ? ` · ${pluriel(props, 'proposition')} à confirmer` : ''}.`
      + ' Une proposition n’est appliquée que si tu l’adoptes : le flux trouvé peut être'
      + ' celui du site entier plutôt que la rubrique d’origine.'
    : 'Aucune adresse de remplacement trouvée pour ces sources.';

  // Les cas actionnables d'abord.
  const ordre = { propose: 0, repare: 1, doublon: 2, introuvable: 3, echec: 4 };
  $('#repairList').innerHTML = resultats
    .slice()
    .sort((a, b) => (ordre[a.status] ?? 9) - (ordre[b.status] ?? 9))
    .map(ligneReparation).join('');

  openModal('#repairModal');
}

async function reparerTout() {
  const btn = $('#repairAll');
  btn.disabled = true;
  btn.textContent = 'Recherche en cours…';
  try {
    afficherRapport(await api.repairAll());
    await reloadState();
  } catch (error) {
    toast('Réparation impossible : ' + error.message, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Réparer les sources injoignables';
  }
}

async function adopterAdresse(feedId, url, bouton) {
  bouton.disabled = true;
  bouton.textContent = 'Adoption…';
  try {
    const resultat = await api.repairFeed(feedId, url);
    await reloadState();
    const ligne = $(`[data-feed-row="${feedId}"]`);
    if (ligne) {
      $('.repair-detail', ligne).innerHTML =
        `Nouvelle adresse : <b>${esc(resultat.feed.title)}</b><br><span class="repair-url">${esc(url)}</span>`;
      $('.repair-tag', ligne).className = 'repair-tag ok';
      $('.repair-tag', ligne).textContent = 'réparée';
    }
    toast(`« ${resultat.feed.title} » · ${pluriel(resultat.added || 0, 'article')}`);
    if (state.feedId === feedId || !state.feedId) loadArticles(true);
  } catch (error) {
    bouton.disabled = false;
    bouton.textContent = 'Adopter';
    toast('Échec : ' + error.message, 'bad');
  }
}

/* -------------------------------------------------------------- reglages */

function ouvrirReglages() {
  $('#setTheme').value = localStorage.getItem('bublee.theme') || 'auto';
  $('#setRefresh').value = String(state.settings.refreshMinutes ?? 30);
  $('#setRetention').value = String(state.settings.retentionDays ?? 90);
  $('#setFulltext').value = state.settings.fulltext ?? 'auto';
  openModal('#settingsModal');
}

async function enregistrerReglages(event) {
  event.preventDefault();
  const theme = $('#setTheme').value;
  applyTheme(theme);
  try {
    await api.settings({
      theme,
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

boot();
