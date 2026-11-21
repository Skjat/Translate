// Состояние приложения: настройки, лента, избранное, прочитанное. Хранится в localStorage.
import { TRUSTED_DOMAINS, TOPIC_IDS } from './topics.js';
import { DEFAULT_MODEL } from './claude-core.js';
import { sanitizeArticle, normalizeUrl } from './util.js';

const PREFIX = 'kz.';

export const ls = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (err) {
      console.warn('localStorage:', err);
    }
  },
  del(key) {
    try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
  },
};

export const DEFAULT_SETTINGS = {
  apiKey: '',
  apiBase: '',
  model: DEFAULT_MODEL,
  translateModel: DEFAULT_MODEL,
  translateEngine: 'google', // google | mymemory | claude
  tapTranslate: true,
  autoDiscover: true,
  discoverCount: 8,
  discoverLang: 'mix',
  trustedOnly: true,
  domains: TRUSTED_DOMAINS.join('\n'),
  chatWebSearch: true,
  fontSize: 18,
  readerProxy: 'https://r.jina.ai/{url}',
  readerKey: '',
};

export const settings = { ...DEFAULT_SETTINGS, ...ls.get('settings', {}) };

export function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  ls.set('settings', settings);
  emit('settings');
}

export const domainsList = () =>
  settings.domains.split(/[\s,]+/).map((d) => d.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')).filter(Boolean);

// ---- подписки на изменения ----
const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
export function emit(event, payload) {
  for (const fn of listeners.get(event) || []) {
    try { fn(payload); } catch (err) { console.error(err); }
  }
}

// ---- лента ----
const state = {
  remote: ls.get('feed', { updated_at: null, articles: [] }),
  local: ls.get('local', []), // найденные в приложении через Claude
  saved: ls.get('saved', {}), // id -> { ts, article }
  read: ls.get('read', {}), // id -> ts
  firstSeen: ls.get('firstSeen', null), // id -> ts (для метки «новое»)
  meta: ls.get('meta', { fetchedAt: 0, lastDiscoverAt: 0 }),
};

let libraryCache = null;

export function library() {
  if (libraryCache) return libraryCache;
  const byKey = new Map();
  for (const raw of [...state.local, ...(state.remote.articles || [])]) {
    const a = sanitizeArticle(raw, TOPIC_IDS);
    if (!a) continue;
    const key = normalizeUrl(a.url);
    if (!byKey.has(key)) byKey.set(key, a);
  }
  libraryCache = [...byKey.values()].sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  return libraryCache;
}

const sortKey = (a) => (a.published || a.added || '0000') + (a.added || '');

export const getArticle = (id) => library().find((a) => a.id === id) || state.saved[id]?.article || null;

function touchLibrary() {
  libraryCache = null;
  const now = Date.now();
  // Первый запуск — стартовую ленту не помечаем как «новое».
  const first = !state.firstSeen || Object.keys(state.firstSeen).length === 0;
  state.firstSeen = state.firstSeen || {};
  for (const a of library()) if (!(a.id in state.firstSeen)) state.firstSeen[a.id] = first ? 0 : now;
  ls.set('firstSeen', state.firstSeen);
  emit('library');
}

export function isNew(a) {
  const ts = state.firstSeen?.[a.id];
  return !!ts && Date.now() - ts < 3 * 864e5 && !state.read[a.id];
}

export const feedUpdatedAt = () => state.remote.updated_at;
export const meta = () => state.meta;
export function setMeta(patch) {
  Object.assign(state.meta, patch);
  ls.set('meta', state.meta);
}

/** Загружает общую ленту data/articles.json. Возвращает число новых статей. */
export async function fetchRemoteFeed() {
  const before = new Set(library().map((a) => a.id));
  const res = await fetch('data/articles.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('Лента недоступна: ' + res.status);
  const data = await res.json();
  if (!data || !Array.isArray(data.articles)) throw new Error('Неверный формат ленты');
  state.remote = { updated_at: data.updated_at || null, articles: data.articles };
  ls.set('feed', state.remote);
  setMeta({ fetchedAt: Date.now() });
  touchLibrary();
  return library().filter((a) => !before.has(a.id)).length;
}

/** Добавляет статьи, найденные в приложении. Возвращает реально новые. */
export function addLocalArticles(articles) {
  const known = new Set(library().map((a) => normalizeUrl(a.url)));
  const fresh = articles.filter((a) => !known.has(normalizeUrl(a.url)));
  state.local = [...fresh, ...state.local].slice(0, 400);
  ls.set('local', state.local);
  touchLibrary();
  return fresh;
}

// ---- избранное и прочитанное ----
export const isSaved = (id) => !!state.saved[id];
export const isRead = (id) => !!state.read[id];

export function toggleSaved(article) {
  if (state.saved[article.id]) delete state.saved[article.id];
  else state.saved[article.id] = { ts: Date.now(), article };
  ls.set('saved', state.saved);
  emit('saved', article.id);
  return !!state.saved[article.id];
}

export function markRead(id, value = true) {
  if (value) state.read[id] = Date.now();
  else delete state.read[id];
  ls.set('read', state.read);
  emit('read', id);
}

export const savedArticles = () =>
  Object.values(state.saved).sort((a, b) => b.ts - a.ts).map((s) => getArticle(s.article.id) || s.article);

export const readArticles = () =>
  Object.entries(state.read).sort((a, b) => b[1] - a[1]).map(([id]) => getArticle(id)).filter(Boolean);

export function init() {
  touchLibrary();
}

export function resetAll() {
  for (const key of ['feed', 'local', 'saved', 'read', 'firstSeen', 'meta', 'settings', 'tcache']) ls.del(key);
}
