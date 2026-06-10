/*
 * Frameline API client — drop-in replacement for the prototype's `Store` layer.
 *
 * In sports-photography-platform.html, the app persists via a `Store` object
 * (window.storage -> localStorage -> memory) and an in-memory `state`. To go
 * live, point the app at this client instead: fetch resources from the API on
 * load, and send mutations to the API. Below is the wrapper + a sketch of the swap.
 *
 * 1) Set API_BASE to your deployed API (e.g. https://api.yourstudio.com).
 * 2) After login, keep the token (localStorage is fine for the token itself).
 * 3) Replace reads/writes of `state.<resource>` with the calls below.
 */

const API_BASE = 'http://localhost:4000';

const Api = {
  token: localStorage.getItem('frameline_token') || '',

  setToken(t) { this.token = t; localStorage.setItem('frameline_token', t); },
  clearToken() { this.token = ''; localStorage.removeItem('frameline_token'); },

  async _fetch(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    const res = await fetch(API_BASE + path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
    return data;
  },

  // --- Auth ---
  async register(email, password, studio) {
    const d = await this._fetch('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, studio }) });
    this.setToken(d.token); return d;
  },
  async login(email, password) {
    const d = await this._fetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    this.setToken(d.token); return d;
  },
  me() { return this._fetch('/me'); },

  // --- Generic CRUD (resource = 'clients','teams','athletes','galleries','orders',
  //     'appointments','tasks','documents','templates','packages','picture-days') ---
  list(resource, query = {}) {
    const qs = new URLSearchParams(query).toString();
    return this._fetch(`/${resource}${qs ? '?' + qs : ''}`);
  },
  get(resource, id) { return this._fetch(`/${resource}/${id}`); },
  create(resource, body) { return this._fetch(`/${resource}`, { method: 'POST', body: JSON.stringify(body) }); },
  update(resource, id, body) { return this._fetch(`/${resource}/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); },
  remove(resource, id) { return this._fetch(`/${resource}/${id}`, { method: 'DELETE' }); },

  // --- Photos ---
  async uploadPhotos(galleryId, fileList) {
    const fd = new FormData();
    [...fileList].forEach((f) => fd.append('files', f));
    const headers = {}; if (this.token) headers.Authorization = 'Bearer ' + this.token;
    const res = await fetch(`${API_BASE}/galleries/${galleryId}/photos`, { method: 'POST', headers, body: fd });
    if (!res.ok) throw new Error('upload failed');
    return res.json();
  },
  listPhotos(galleryId) { return this._fetch(`/galleries/${galleryId}/photos`); },

  // --- Email / AI / Payments ---
  sendEmail(payload) { return this._fetch('/emails/send', { method: 'POST', body: JSON.stringify(payload) }); },
  emails(query = {}) { const qs = new URLSearchParams(query).toString(); return this._fetch(`/emails${qs ? '?' + qs : ''}`); },
  aiDraftEmail(payload) { return this._fetch('/ai/draft-email', { method: 'POST', body: JSON.stringify(payload) }); },
  aiGenerateContract(payload) { return this._fetch('/ai/generate-contract', { method: 'POST', body: JSON.stringify(payload) }); },
  aiAssistant(message) { return this._fetch('/ai/assistant', { method: 'POST', body: JSON.stringify({ message }) }); },
  checkout(orderId) { return this._fetch(`/orders/${orderId}/checkout`, { method: 'POST' }); },
};

/*
 * SKETCH — how the swap looks in the prototype:
 *
 *   // before:  await Store.set(MAIN, state);
 *   // after :  (each mutation calls the API)
 *
 *   async function loadState() {
 *     const [clients, galleries, orders, appointments, tasks, documents, templates, packages, teams, athletes, pictureDays] =
 *       await Promise.all([
 *         Api.list('clients'), Api.list('galleries'), Api.list('orders'),
 *         Api.list('appointments'), Api.list('tasks'), Api.list('documents'),
 *         Api.list('templates'), Api.list('packages'), Api.list('teams'),
 *         Api.list('athletes'), Api.list('picture-days'),
 *       ]);
 *     state.schools = clients; // note: API column is `client_id`, prototype uses `schoolId`
 *     // ...map fields, then render()
 *   }
 *
 *   // saving a client:  Api.create('clients', { name, contract_status, ... })  /  Api.update('clients', id, {...})
 *   // sending email:    Api.sendEmail({ clientId, to, subject, body, attachments })
 *   // uploading photos: Api.uploadPhotos(galleryId, fileInput.files)
 *
 * Field-name note: the API uses snake_case + `client_id`; the prototype uses
 * camelCase + `schoolId`. Add a thin mapping layer (apiToState / stateToApi) or
 * rename in the prototype — either works, mapping is less invasive.
 */

if (typeof module !== 'undefined') module.exports = { Api };
