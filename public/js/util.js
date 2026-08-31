// Petites fonctions partagees : echappement, dates en francais, images.

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

/** « à l'instant », « il y a 12 min », « hier », « 4 mars », « 4 mars 2022 ». */
export function quand(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const diff = Date.now() - ms;
  const minutes = Math.round(diff / 60000);

  // Beaucoup d'editeurs datent leurs articles avec quelques heures d'avance :
  // afficher « à venir » n'aurait aucun sens pour un lecteur.
  if (diff < 0) return 'à l’instant';
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;

  const heures = Math.round(minutes / 60);
  if (heures < 24) return `il y a ${heures} h`;

  const jours = Math.floor(diff / 86400000);
  if (jours === 1) return 'hier';
  if (jours < 7) return `il y a ${jours} jours`;

  const jour = date.getDate();
  const mois = MOIS[date.getMonth()];
  const annee = date.getFullYear();
  return annee === new Date().getFullYear() ? `${jour} ${mois}` : `${jour} ${mois} ${annee}`;
}

export function dateLongue(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  return `${date.getDate()} ${MOIS[date.getMonth()]} ${date.getFullYear()} · ${
    String(date.getHours()).padStart(2, '0')}h${String(date.getMinutes()).padStart(2, '0')}`;
}

/** ~230 mots/minute, arrondi a la minute superieure. */
export function tempsLecture(mots) {
  if (!mots || mots < 40) return '';
  return `${Math.max(1, Math.round(mots / 230))} min de lecture`;
}

/** Passe l'image par le relais local : evite les blocages de hotlink. */
export function relais(url) {
  if (!url) return '';
  if (url.startsWith('data:')) return url;
  return '/api/image?url=' + encodeURIComponent(url);
}

export function hote(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function debounce(fn, delay = 280) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function pluriel(n, singulier, plurielMot = singulier + 's') {
  return `${n} ${n > 1 ? plurielMot : singulier}`;
}

/** « 38 min d'écoute », « 1 h 05 d'écoute ». */
export function duree(secondes) {
  if (!secondes || secondes < 30) return '';
  const minutes = Math.round(secondes / 60);
  if (minutes < 60) return minutes + ' min d’écoute';
  const h = Math.floor(minutes / 60);
  const reste = minutes % 60;
  return reste ? h + ' h ' + String(reste).padStart(2, '0') + ' d’écoute' : h + ' h d’écoute';
}

/** « 14:32 » — l'heure seule, pour les dépêches. */
export function heure(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** « SAM. 31 AOÛT 2026 » — la date de l'édition. */
export function dateJournal(ms = Date.now()) {
  const d = new Date(ms);
  const jours = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
  const mois = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
    'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  return `${jours[d.getDay()]} ${d.getDate()} ${mois[d.getMonth()]} ${d.getFullYear()}`;
}

/** Espace fine insécable pour les milliers : 2 478. */
export function nombre(n) {
  return String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
}
