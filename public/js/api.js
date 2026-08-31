// Acces au serveur. Toutes les erreurs remontent sous forme d'Error(message).

async function call(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await res.json() : await res.text();

  if (!res.ok) {
    const error = new Error(payload?.error || `Erreur ${res.status}`);
    error.status = res.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

/* Les requetes portent le cookie de session : sans `credentials`, le navigateur
   ne l'enverrait pas sur une origine differente, et l'API repondrait 401. */
const json = (method, url, body) => call(url, {
  credentials: 'same-origin',
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
});

export const api = {
  /* --- comptes --- */
  etatAuth:   () => call('/api/auth/etat'),
  installer:  (corps) => json('POST', '/api/auth/installer', corps),
  login:      (email, motDePasse) => json('POST', '/api/auth/login', { email, motDePasse }),
  logout:     () => json('POST', '/api/auth/logout'),
  moi:        () => call('/api/auth/moi'),
  majMoi:     (patch) => json('PATCH', '/api/auth/moi', patch),
  comptes:    () => call('/api/users'),
  creerCompte: (corps) => json('POST', '/api/users', corps),
  majCompte:  (id, patch) => json('PATCH', '/api/users/' + id, patch),
  supprimerCompte: (id) => json('DELETE', '/api/users/' + id),

  state:    () => call('/api/state'),
  settings: (patch) => json('PUT', '/api/settings', patch),

  articles(params) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') query.set(key, value);
    }
    return call('/api/articles?' + query);
  },
  article:  (id) => call('/api/articles/' + id),
  full:     (id, force = false) => json('POST', `/api/articles/${id}/full${force ? '?force=1' : ''}`),
  patch:    (id, patch) => json('PATCH', '/api/articles/' + id, patch),
  markRead: (payload) => json('POST', '/api/articles/read', payload),
  tag:      (id, action) => json('POST', `/api/articles/${id}/tags`, action),
  couleur:  (id, color) => json('POST', `/api/articles/${id}/color`, { color }),
  tags:      () => call('/api/tags'),
  createTag: (name) => json('POST', '/api/tags', { name }),
  updateTag: (id, patch) => json('PATCH', '/api/tags/' + id, patch),
  deleteTag: (id) => json('DELETE', '/api/tags/' + id),

  addFeed:     (url, folder, title) => json('POST', '/api/feeds', { url, folder, title }),
  updateFeed:  (id, patch) => json('PATCH', '/api/feeds/' + id, patch),
  deleteFeed:  (id) => json('DELETE', '/api/feeds/' + id),
  refreshFeed: (id) => json('POST', `/api/feeds/${id}/refresh`),
  repairFeed:  (id, url) => json('POST', `/api/feeds/${id}/repair`, url ? { url } : {}),
  repairAll:   () => json('POST', '/api/feeds/repair'),
  dedupe:      (rebuild = false) => json('POST', `/api/dedupe${rebuild ? '?rebuild=1' : ''}`),
  refreshAll:  () => json('POST', '/api/refresh'),

  importOpml: (xml) => call('/api/opml/import', {
    method: 'POST',
    headers: { 'content-type': 'application/xml' },
    body: xml
  })
};
