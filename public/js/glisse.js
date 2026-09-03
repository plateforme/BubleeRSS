// Le glissé du lecteur, au doigt.
//
// Ce module ne connaît pas le lecteur : tout ce dont il a besoin — l’article
// suivant, le précédent, comment en ouvrir un, comment fermer — lui est passé
// à l’installation. C’est ce qui évite un cycle entre lui et app.js, et ce qui
// rend le geste lisible sans lire le reste.
import { state, $, toast } from './etat.js';

/* Ce que le lecteur prête au geste, posé à l'installation. Le glissé n'a pas
   à savoir comment un article s'ouvre : seulement qu'il peut le demander. */
let lecteur = null;


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
  // On s'arrête au panneau de lecture : lui défile verticalement, et son
  // éventuel débord horizontal — une image large, une URL insécable — n'est pas
  // une zone qu'on fait glisser du doigt. Le laisser dans la remontée revenait à
  // lui confisquer le geste : un seul article un peu large et le glissé mourait
  // dessus, dans les deux sens. Seules comptent les zones internes faites pour
  // défiler de côté : un tableau, un bloc de code.
  const panneau = document.getElementById('readerScroll');
  for (let el = cible; el && el !== panneau && el !== document.body; el = el.parentElement) {
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
    await lecteur.openArticle(article.id, { enchaine: true });
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

  // On lance l'ouverture et on anime tout de suite, sans jamais l'attendre.
  // Attendre l'article — qu'il soit encore en route, ou déjà là mais suivi de
  // son « marquer lu » sur le réseau — figeait le glissé là où le doigt l'avait
  // laissé, parfois plusieurs secondes. Le contenu se pose dans le panneau
  // entrant dès qu'il arrive : pendant l'animation s'il est en cache, juste
  // après sinon, et le sortant couvre l'attente.
  lecteur.openArticle(article.id, { enchaine: true });

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
  const panneau = $('#reader');
  const scroll = $('#readerScroll');
  scroll.style.transition = 'none';
  scroll.style.transform = '';
  if (!douceur()) { lecteur.closeReader(); return; }
  const duree = dureePassage(Math.max(80, innerWidth - Math.abs(depart)), vitesse);
  panneau.style.transition = `transform ${duree}ms var(--ease), opacity ${duree}ms linear`;
  panneau.style.transform = `translateX(${100 * DEBORD}%)`;
  panneau.style.opacity = '0';
  await attendre(duree);
  lecteur.closeReader();
  panneau.style.transition = 'none';
  panneau.style.transform = '';
  panneau.style.opacity = '';
}

export function glisseLecteur(voisins) {
  lecteur = voisins;
  const panneau = $('#reader');
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

  panneau.addEventListener('touchstart', (e) => {
    if (occupe || !auDoigt() || e.touches.length !== 1 || dansUnDefilementHorizontal(e.target)) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    actif = true; horizontal = null;
    repere = { x: x0, t: e.timeStamp }; vitesse = 0; mesure = false;
    // L'animation d'ouverture dure 340 ms et, tant qu'elle court, ses images
    // clés l'emportent sur le style en ligne : un doigt posé aussitôt ne
    // déplacerait rien. On la coupe net.
    panneau.style.animation = 'none';
    $('#readerScroll').style.transition = 'none';
  }, { passive: true });

  panneau.addEventListener('touchmove', (e) => {
    if (!actif) return;
    const dx = e.touches[0].clientX - x0;
    const dy = e.touches[0].clientY - y0;

    // On tranche une fois pour toutes au premier mouvement franc : sans ça, un
    // défilement vertical un peu oblique ferait trembler le contenu.
    if (horizontal === null) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      horizontal = Math.abs(dx) > Math.abs(dy) * PENTE_GLISSE;
      if (!horizontal) { relacher(); return; }   // vertical : on rend la main au défilement natif
      $('#readerScroll').style.willChange = 'transform';
    }

    // Une fois le geste reconnu horizontal, Bublee le réclame. Sans ce
    // preventDefault, le navigateur continue de guetter un défilement vertical
    // et finit par reprendre la main au milieu du glissé : le contenu se fige,
    // et le doigt relâché retombe sous le seuil, donc revient en arrière — le
    // glissé « se bloquait à mi-course ». Le listener est non passif exprès :
    // c'est ce qui autorise l'appel.
    e.preventDefault();

    // Le contenu suit le doigt au point près, sauf là où le geste ne mène nulle
    // part : vers la gauche sans article suivant, il résiste comme un élastique
    // au lieu de promettre un passage qui n'aura pas lieu.
    const impasse = dx < 0 && !lecteur.articleSuivant();
    const suivi = impasse ? Math.sign(dx) * Math.pow(Math.abs(dx), 0.62) : dx;
    $('#readerScroll').style.transform = `translateX(${suivi}px)`;
    suivreElan(e.touches[0].clientX, e.timeStamp);
  }, { passive: false });

  panneau.addEventListener('touchend', async (e) => {
    if (!actif) return;
    const fin = e.changedTouches[0]?.clientX ?? x0;
    const dx = fin - x0;
    suivreElan(fin, e.timeStamp);
    const lance = elan(e.timeStamp);
    const franchi = horizontal && Math.abs(dx) >= SEUIL_GLISSE;
    actif = false; horizontal = null;

    if (!franchi) { relacher(); return; }

    const suivant = dx < 0 ? lecteur.articleSuivant() : null;
    const precedent = dx > 0 && state.profondeur > 0 ? lecteur.articlePrecedent() : null;

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
  panneau.addEventListener('touchcancel', () => { if (actif) relacher(); }, { passive: true });
}
