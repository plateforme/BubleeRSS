// Spotify ne publie aucun flux. Mais la plupart des podcasts qu'on y ecoute ne
// lui appartiennent pas : ils y sont seulement repris depuis un flux RSS public,
// heberge ailleurs — Simplecast, Acast, Megaphone. Ce module remonte donc le
// lien Spotify jusqu'a ce flux-la, et c'est lui qu'on suit.
//
// L'interet n'est pas de contourner Spotify, c'est d'avoir mieux : les episodes
// entrent dans la liste, le baladeur joue le fichier directement, la position et
// la vitesse sont gardees, et rien ne demande de compte.
//
// Le chemin tient en deux temps. La page Spotify annonce le nom de l'emission ;
// un annuaire de podcasts, interroge sur ce nom, rend l'adresse de son flux.
// Deux annuaires plutot qu'un : Apple pour sa couverture, gpodder pour ce
// qu'Apple ne publie pas — et il n'en publie pas peu, notamment sur Radio
// France. Aucun des deux ne demande de cle. Rien n'est pris sur parole :
// `discoverFeeds` telecharge le candidat et le rejette s'il ne repond pas comme
// un flux.
//
// Reste une limite qu'aucun annuaire ne leve : les exclusivites Spotify n'ont de
// flux nulle part, elles n'existent que chez Spotify. On renvoie alors null, et
// l'ajout retombe sur la decouverte ordinaire plutot que d'inventer.
import { httpGet, decodeBody } from './http.js';
import { decodeEntities } from './html.js';

const HOTES = /(^|\.)spotify\.(com|link)$/i;

export function estSpotify(input) {
  try { return HOTES.test(new URL(String(input)).hostname); } catch { return false; }
}

/** Ce que Spotify accroche a ses titres, et qui n'est pas le nom de l'emission. */
const SUFFIXES = /\s*[|·-]\s*(?:podcast(?:\s+on\s+spotify)?|spotify)\s*$/i;

/** Le nom de l'emission, tel que la page l'annonce. */
function titreDansLaPage(html) {
  const motifs = [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
    /<title[^>]*>([^<]+)<\/title>/i
  ];
  for (const motif of motifs) {
    const m = motif.exec(html);
    if (!m) continue;
    const titre = decodeEntities(m[1]).replace(SUFFIXES, '').trim();
    if (titre) return titre;
  }
  return null;
}

/** Deux titres se comparent sans casse, sans accents ni ponctuation. */
const simplifier = (t) => String(t || '')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Est-ce bien la meme emission ?
 *
 * Assez souple pour absorber un sous-titre ou une mention d'editeur, assez
 * stricte pour ne pas confondre deux emissions voisines : l'un des deux noms
 * doit commencer par l'autre, pas seulement le contenir quelque part.
 */
function memeEmission(cherche, trouve) {
  const a = simplifier(cherche);
  const b = simplifier(trouve);
  if (!a || !b) return false;
  return a === b || a.startsWith(b + ' ') || b.startsWith(a + ' ');
}

async function jsonDe(url) {
  const { res, buffer } = await httpGet(url, { timeout: 10000 });
  if (!res.ok) return null;
  try { return JSON.parse(decodeBody(buffer, res.headers.get('content-type'))); } catch { return null; }
}

/**
 * Le meilleur flux parmi des candidats d'annuaire.
 *
 * Le nom exact d'abord, le nom approchant seulement ensuite. Sans cet ordre, une
 * emission voisine — « … Show » la ou l'on cherche « … » — passerait devant
 * celle qu'on demande, au seul motif qu'elle, elle livre son flux.
 */
async function meilleurFlux(titre, candidats, fluxDe) {
  const exact = (c) => simplifier(titre) === simplifier(c.nom);
  for (const retenir of [exact, (c) => memeEmission(titre, c.nom)]) {
    for (const candidat of candidats) {
      if (!retenir(candidat)) continue;
      const flux = await fluxDe(candidat);
      if (flux) return flux;
    }
  }
  return null;
}

/**
 * L'annuaire d'Apple : le plus large, mais avare de l'adresse du flux.
 *
 * La recherche ne la donne plus — Apple l'a retiree de cette reponse-la —, et la
 * fiche detaillee ne la porte que pour une partie du catalogue. On interroge
 * donc la fiche des meilleures correspondances, l'une apres l'autre.
 */
async function fluxChezApple(titre) {
  const recherche = await jsonDe(
    'https://itunes.apple.com/search?media=podcast&entity=podcast&limit=5&term=' + encodeURIComponent(titre)
  );
  const candidats = (recherche?.results || []).map((c) => ({ nom: c.collectionName, fiche: c }));

  return meilleurFlux(titre, candidats, async ({ fiche }) => {
    if (fiche.feedUrl) return fiche.feedUrl;
    if (!fiche.collectionId) return null;
    const detail = await jsonDe(
      'https://itunes.apple.com/lookup?entity=podcast&id=' + encodeURIComponent(fiche.collectionId)
    );
    return detail?.results?.[0]?.feedUrl || null;
  });
}

/**
 * gpodder : un annuaire ouvert, qui donne l'adresse du flux sans rien demander.
 *
 * Il prend le relais la ou Apple se tait — et il se tait beaucoup, notamment sur
 * Radio France : « Affaires sensibles » comme « Le code a change » n'ont chez lui
 * aucune adresse de flux, meme interroge sur sa boutique francaise, quand gpodder
 * les rend tous les deux.
 */
async function fluxChezGpodder(titre) {
  const trouves = await jsonDe('https://gpodder.net/search.json?q=' + encodeURIComponent(titre));
  const candidats = (Array.isArray(trouves) ? trouves : []).map((c) => ({ nom: c.title, url: c.url }));
  return meilleurFlux(titre, candidats, async ({ url }) => url || null);
}

/**
 * L'adresse du flux, d'ou qu'elle vienne. Apple d'abord, pour sa couverture ;
 * gpodder ensuite, pour ce qu'Apple ne publie pas. L'un ou l'autre indisponible
 * n'empeche rien : on passe au suivant, et faute des deux on renonce.
 */
async function fluxDuTitre(titre) {
  return (await fluxChezApple(titre).catch(() => null))
    || (await fluxChezGpodder(titre).catch(() => null));
}

/**
 * Transforme une adresse d'emission Spotify en adresse de flux.
 *
 * Seules les emissions — /show/… — sont traitees : l'adresse d'un episode
 * annonce le titre de l'episode, pas celui de l'emission, et chercher sur lui
 * ne menerait nulle part. Retourne null des que le chemin se perd.
 */
export async function resoudreFluxSpotify(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  if (!HOTES.test(url.hostname)) return null;
  if (!/^\/(?:intl-[a-z]{2}\/)?show\//i.test(url.pathname)) return null;

  // Surtout pas l'agent « navigateur » ici, contrairement aux sites de presse :
  // Spotify reserve ses metadonnees aux robots et sert aux vrais navigateurs une
  // coquille que seul JavaScript remplit. En annoncant Bublee pour ce qu'il est,
  // on recoit la page qui porte le nom de l'emission ; en se faisant passer pour
  // Chrome, on recoit une page vide titree « Spotify – Web Player ».
  const { res, buffer } = await httpGet(url.href, { timeout: 20000 });
  if (!res.ok) return null;

  const titre = titreDansLaPage(decodeBody(buffer, res.headers.get('content-type')));
  return titre ? fluxDuTitre(titre) : null;
}

export const _pourLesTests = { titreDansLaPage, memeEmission, simplifier, meilleurFlux };
