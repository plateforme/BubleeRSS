// Les plateformes qui publient un flux sans jamais le dire.
//
// YouTube a son module a lui, la resolution y demandant parfois de lire la
// page. Celles-ci se deduisent de l'adresse seule : coller le profil suffit.
//
// Une deduction n'est jamais appliquee sur parole — `discoverFeeds` telecharge
// et analyse le candidat avant de le retenir, et retombe sur la decouverte
// ordinaire s'il ne repond pas.

/** Mastodon : n'importe quelle instance sert le profil en RSS. */
function mastodon(url) {
  const m = /^\/@([\w.-]+)\/?$/.exec(url.pathname);
  if (!m) return null;
  // Medium partage la forme /@pseudo mais pas la convention.
  if (/(^|\.)medium\.com$/i.test(url.hostname)) return url.origin + '/feed/@' + m[1];
  return url.origin + '/@' + m[1] + '.rss';
}

/** Bluesky : le flux d'un profil, par son identifiant complet. */
function bluesky(url) {
  if (!/(^|\.)bsky\.app$/i.test(url.hostname)) return null;
  const m = /^\/profile\/([^/]+)/.exec(url.pathname);
  return m ? `https://bsky.app/profile/${m[1]}/rss` : null;
}

/** Reddit : un sous-forum, un profil, une recherche — tout a son .rss. */
function reddit(url) {
  if (!/(^|\.)reddit\.com$/i.test(url.hostname)) return null;
  const m = /^\/(r|user|u)\/([^/]+)/.exec(url.pathname);
  if (!m) return null;
  const quoi = m[1] === 'u' ? 'user' : m[1];
  return `https://www.reddit.com/${quoi}/${m[2]}/.rss`;
}

/** GitHub : les publications d'un depot, ou l'activite d'un compte. */
function github(url) {
  if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;
  const m = /^\/([^/]+)(?:\/([^/]+))?/.exec(url.pathname);
  if (!m || ['orgs', 'topics', 'features', 'about', 'settings', 'sponsors'].includes(m[1])) return null;
  if (m[2]) return `https://github.com/${m[1]}/${m[2].replace(/\.git$/, '')}/releases.atom`;
  return `https://github.com/${m[1]}.atom`;
}

const REGLES = [mastodon, bluesky, reddit, github];

/**
 * L'adresse de flux qu'une adresse de plateforme laisse deviner, ou null.
 * Accepte aussi la forme « @pseudo@instance », qu'on copie d'un profil.
 */
export function fluxDePlateforme(entree) {
  const brut = String(entree || '').trim();

  const fediverse = /^@([\w.-]+)@([\w.-]+\.[a-z]{2,})$/i.exec(brut);
  if (fediverse) return `https://${fediverse[2]}/@${fediverse[1]}.rss`;

  let url;
  try { url = new URL(/^https?:\/\//i.test(brut) ? brut : 'https://' + brut); } catch { return null; }

  for (const regle of REGLES) {
    const flux = regle(url);
    if (flux) return flux;
  }
  return null;
}
