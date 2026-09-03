// Les cartes, et la composition de la une.
//
// Tout ce qui transforme un article en HTML vit ici : les huit gabarits, le
// découpage de la liste en blocs de journal, et le rendu — qui ajoute une page
// à la suite plutôt que de tout refaire.
import {
  state, $, $$, teinte, contraste, rgba, couleurTag, CLASSE_LAYOUT, SUGGESTIONS
} from './etat.js';
import { esc, quand, heure, tempsLecture, duree, relais, nombre } from './util.js';
import { rattraperImages } from './couleurs.js';


export const estVideo = (a) => /(^|\/\/)(www\.)?(youtube\.com\/watch|youtu\.be\/)/.test(a.url || '');
const estAudio = (a) => !estVideo(a) && Boolean(a.duration);

export function laDuree(a) {
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
export function fondImage(a) {
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
export const imgFondue = (src, { pressee = false } = {}) => `<img class="fondu" src="${esc(src)}" alt=""` +
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

export function majPuces(a) {
  $$(`.art[data-id="${a.id}"] .art-etiqs`).forEach((el) => { el.innerHTML = pastilles(a); });
}

/* --- les blocs de la mise en page « la une » ----------------------------- */

function blocUne(a) {
  const couleur = teinte(a.feed_title);
  const fond = a.image
    ? imgFondue(relais(a.image, 900), { pressee: true })
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
        ${imgFondue(relais(a.image, 400))}
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

export const initialeDe = (a) => (String(a.title).match(/[\p{L}\p{N}]/u)?.[0] || '§').toUpperCase();

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
export function renderFlux({ depuis = 0 } = {}) {
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
  const vignette = a.image ? imgFondue(relais(a.image, 160)) : '';
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

/** L’index d’un article dans la liste courante — le curseur clavier s’en sert. */
export const indexDe = (id) => indexParId.get(id);
