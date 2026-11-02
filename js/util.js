// Небольшие общие утилиты (браузер + Node).

/** Нормализует URL для сравнения и дедупликации: без протокола, www, якоря, utm-меток и слеша в конце. */
export function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|yclid|ref$|ref_src|mc_|cmpid|src$)/i.test(key)) u.searchParams.delete(key);
    }
    const host = u.hostname.replace(/^(www|m|amp)\./, '').toLowerCase();
    let path = u.pathname.replace(/\/amp\/?$/, '/').replace(/\/+$/, '');
    const qs = u.searchParams.toString();
    return host + path + (qs ? '?' + qs : '');
  } catch {
    return String(raw || '').trim().toLowerCase();
  }
}

/** Короткий стабильный id по URL (FNV-1a, 32 бита, hex). */
export function articleId(url) {
  const s = normalizeUrl(url);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 'a' + (h >>> 0).toString(16).padStart(8, '0');
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Проверяет и чистит статью, пришедшую от Claude или из файла ленты.
 * Возвращает нормализованный объект или null, если статья непригодна.
 */
export function sanitizeArticle(a, topicIds) {
  if (!a || typeof a !== 'object') return null;
  const str = (v, max = 600) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const url = str(a.url, 1000);
  if (!/^https:\/\/[^\s]+$/i.test(url)) return null;
  try {
    const u = new URL(url);
    // Главные страницы и разделы — не статьи.
    if (u.pathname.replace(/\/+$/, '').split('/').filter(Boolean).length < 1) return null;
  } catch { return null; }
  const title = str(a.title, 300);
  if (!title) return null;
  const topic = topicIds.includes(a.topic) ? a.topic : null;
  if (!topic) return null;
  const lang = a.lang === 'ru' || a.lang === 'en' ? a.lang : (/[а-яё]/i.test(title) ? 'ru' : 'en');
  const tags = Array.isArray(a.tags)
    ? [...new Set(a.tags.map((t) => str(t, 40).toLowerCase()).filter(Boolean))].slice(0, 5)
    : [];
  const published = typeof a.published === 'string' && ISO_DATE.test(a.published.slice(0, 10)) ? a.published.slice(0, 10) : null;
  let minutes = Number.parseInt(a.reading_minutes, 10);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) minutes = null;
  return {
    id: articleId(url),
    title,
    title_ru: str(a.title_ru, 300) || title,
    url,
    source: str(a.source, 80) || hostOf(url),
    lang,
    topic,
    tags,
    summary: str(a.summary, 900),
    published,
    reading_minutes: minutes,
    kind: a.kind === 'longread' ? 'longread' : 'fresh',
    added: typeof a.added === 'string' && ISO_DATE.test(a.added.slice(0, 10)) ? a.added.slice(0, 10) : null,
    ...(str(a.query, 120) ? { query: str(a.query, 120) } : {}),
  };
}

export function todayISO(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
