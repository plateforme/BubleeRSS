// Ce que tous les modules partagent : l'état de la page, deux raccourcis vers
// le DOM, la palette du kiosque, et le message passager.
//
// Un seul objet `state`, muté sur place plutôt que remplacé : les modules en
// tiennent la même référence, et personne n'a à s'abonner à rien.

export const $ = (sel, scope = document) => scope.querySelector(sel);
export const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];

export const state = {
  view: 'unread',        // unread | all | starred | survol | edition
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

export const CLASSE_LAYOUT = { magazine: 'l-une', list: 'l-sommaire', compact: 'l-depeches' };

/** Palette fermée du kiosque : six teintes, deux neutres. */
const TEINTES_SOURCE = [
  '#e2452a', '#1b3fd8', '#f0a91d',
  '#10604a', '#6a2fd0', '#d81e73',
  '#a9a69d', '#f6f5f1'
];

/** Les dossiers repliés dans l'index : un réglage d'écran, pas de compte. */
export const collapsed = new Set(JSON.parse(localStorage.getItem('bublee.collapsed') || '[]'));

export const SUGGESTIONS = [
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
export function teinte(texte) {
  let h = 0;
  for (const c of String(texte || '')) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return TEINTES_SOURCE[h % TEINTES_SOURCE.length];
}

/** Encre ou papier sur une teinte, selon sa luminance perceptuelle. */
export function contraste(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const lum = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
  return lum > 150 ? '#1b1a17' : '#f6f5f1';
}

export function rgba(hex, alpha) {
  const n = parseInt(String(hex).slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** La teinte d'une étiquette, telle que le compte l'a choisie. */
export function couleurTag(nom) {
  return state.tags.find((t) => t.name === nom)?.color || 'var(--accent)';
}

/** Un article de la liste courante — ou celui qu'on lit, ouvert par un lien
    profond et donc absent de la liste. */
export const articleParId = (id) => state.articles.find((a) => a.id === id)
  || (state.ouvert?.id === id ? state.ouvert : null);

/* ----------------------------------------------------------------- toasts */

/**
 * Un message passager. `action` y pose un bouton — « Annuler » après un
 * marquage en masse : le geste le plus lourd de l'application est aussi le
 * seul qui n'avait pas de filet.
 */
export function toast(message, kind = '', action = null) {
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
