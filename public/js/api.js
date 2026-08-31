// Acces au serveur. Toutes les erreurs remontent sous forme d'Error(message).

async function call(url, options = {}) {
  const res = await fetch(url, options);
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

const json = (method, url, body) => call(url, {
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
});

export const api = {
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
