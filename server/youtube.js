// YouTube ne propose pas de bouton « flux RSS », mais il en publie un pour
// chaque chaine et chaque liste de lecture. Ce module transforme n'importe
// quelle adresse YouTube en cette adresse-la.
import { httpGet, decodeBody } from './http.js';

const HOTES = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|m\.youtube\.com)$/i;

export function estYouTube(input) {
  try { return HOTES.test(new URL(String(input)).hostname); } catch { return false; }
}

const fluxChaine = (id) => 'https://www.youtube.com/feeds/videos.xml?channel_id=' + id;
const fluxListe = (id) => 'https://www.youtube.com/feeds/videos.xml?playlist_id=' + id;

/** Retrouve l'identifiant de chaine (UC…) dans le HTML d'une page YouTube. */
function identifiantDansLaPage(html) {
  const motifs = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{20,})/i,
    /<meta[^>]+itemprop=["'](?:identifier|channelId)["'][^>]+content=["'](UC[\w-]{20,})["']/i,
    /"(?:externalId|channelId)"\s*:\s*"(UC[\w-]{20,})"/,
    /\/channel\/(UC[\w-]{20,})/
  ];
  for (const motif of motifs) {
    const m = motif.exec(html);
    if (m) return m[1];
  }
  return null;
}

/**
 * Transforme une adresse YouTube en adresse de flux.
 * Accepte : /channel/UC…, /@pseudo, /c/nom, /user/nom, /playlist?list=…,
 * une adresse de video, et le flux lui-meme.
 * Retourne null si ce n'est pas exploitable.
 */
export async function resoudreFluxYouTube(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  if (!HOTES.test(url.hostname)) return null;

  // Deja un flux.
  if (url.pathname.startsWith('/feeds/videos.xml')) return url.href;

  // Liste de lecture.
  const liste = url.searchParams.get('list');
  if (liste) return fluxListe(liste);

  // Chaine par identifiant : rien a telecharger.
  const parId = /^\/channel\/(UC[\w-]{20,})/.exec(url.pathname);
  if (parId) return fluxChaine(parId[1]);

  // Tout le reste (pseudo, nom personnalise, video) demande de lire la page.
  const { res, buffer } = await httpGet(url.href, { navigateur: true, timeout: 20000 });
  if (!res.ok) return null;

  const id = identifiantDansLaPage(decodeBody(buffer, res.headers.get('content-type')));
  return id ? fluxChaine(id) : null;
}

/**
 * Compose le contenu d'une video : le lecteur, puis la description.
 * Le flux YouTube ne fournit qu'un texte brut, sans mise en forme.
 */
export function contenuVideo(videoId, description) {
  const echappe = (t) => String(t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Le referent : le site est en « no-referrer », mais YouTube verifie qui
  // l'integre et, sans lui, refuse de jouer — c'est son erreur 153. On rend
  // l'origine, et elle seule : jamais l'adresse de l'article.
  const lecteur = `<p><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}"`
    + ' width="560" height="315" allowfullscreen'
    + ' allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture"'
    + ' referrerpolicy="strict-origin-when-cross-origin"'
    + ' title="Lecteur vidéo"></iframe></p>';

  if (!description || !String(description).trim()) return lecteur;

  // Les adresses collees dans une description deviennent cliquables.
  const paragraphes = String(description)
    .split(/\n{2,}/)
    .map((bloc) => echappe(bloc.trim())
      .replace(/\n/g, '<br>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>'))
    .filter(Boolean)
    .map((bloc) => '<p>' + bloc + '</p>')
    .join('');

  return lecteur + paragraphes;
}
