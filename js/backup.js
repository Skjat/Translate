// Резервная копия: экспорт и импорт избранного, прочитанного, словаря, чатов и настроек.
import { ls } from './store.js';
import { kv } from './db.js';
import { mergeWords } from './vocab.js';
import { sanitizeArticle, normalizeUrl } from './util.js';
import { TOPIC_IDS } from './topics.js';

const FORMAT = 1;

export async function buildBackup({ includeKeys = false } = {}) {
  const settings = { ...ls.get('settings', {}) };
  if (!includeKeys) {
    delete settings.apiKey;
    delete settings.readerKey;
  }
  const chats = {};
  for (const key of await kv.keys('chat:')) {
    const conv = await kv.get(key);
    if (conv?.messages?.length) chats[key] = conv;
  }
  return {
    app: 'krugozor',
    format: FORMAT,
    exported_at: new Date().toISOString(),
    settings,
    saved: ls.get('saved', {}),
    read: ls.get('read', {}),
    progress: ls.get('progress', {}),
    vocab: ls.get('vocab', []),
    local: ls.get('local', []),
    chats,
  };
}

/**
 * Сохраняет копию в файл. На iPhone — через меню «Поделиться» (там есть «Сохранить в Файлы»),
 * иначе — обычной загрузкой. Возвращает 'shared' | 'downloaded' | 'cancelled'.
 */
export async function exportBackup(opts) {
  const data = await buildBackup(opts);
  const name = `krugozor-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Резервная копия «Кругозора»' });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
      // иначе пробуем обычную загрузку
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  return 'downloaded';
}

const clean = (a) => sanitizeArticle(a, TOPIC_IDS);

/** Импорт с объединением: ничего из текущих данных не теряется. Возвращает сводку. */
export async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('это не файл резервной копии (неверный JSON)');
  }
  if (data?.app !== 'krugozor') throw new Error('это не резервная копия «Кругозора»');
  const stats = { saved: 0, read: 0, words: 0, chats: 0, articles: 0 };

  // Настройки: берём из копии, но ключи и адрес API — только если на этом устройстве их ещё нет.
  // Иначе чужой файл мог бы перенаправить ваш ключ на свой сервер.
  const cur = ls.get('settings', {});
  const inc = data.settings && typeof data.settings === 'object' ? data.settings : {};
  const merged = { ...cur, ...inc };
  const keyFromBackup = !cur.apiKey && !!inc.apiKey;
  merged.apiKey = cur.apiKey || inc.apiKey || '';
  merged.readerKey = cur.readerKey || inc.readerKey || '';
  merged.apiBase = keyFromBackup && /^https:\/\//.test(inc.apiBase || '') ? inc.apiBase : cur.apiBase || '';
  merged.readerProxy = /^https:\/\/r\.jina\.ai\//.test(inc.readerProxy || '') ? inc.readerProxy : cur.readerProxy || 'https://r.jina.ai/{url}';
  ls.set('settings', merged);

  // Избранное: объединяем, статьи проверяем (только https-ссылки и т. п.).
  const saved = ls.get('saved', {});
  for (const [id, v] of Object.entries(data.saved || {})) {
    const article = clean(v?.article);
    if (!article) continue;
    if (!saved[article.id]) stats.saved++;
    if (!saved[article.id] || (v.ts || 0) > (saved[article.id].ts || 0)) saved[article.id] = { ts: Number(v.ts) || Date.now(), article };
  }
  ls.set('saved', saved);

  const read = ls.get('read', {});
  for (const [id, ts] of Object.entries(data.read || {})) {
    if (typeof ts !== 'number') continue;
    if (!read[id]) stats.read++;
    read[id] = Math.max(read[id] || 0, ts);
  }
  ls.set('read', read);

  const progress = ls.get('progress', {});
  for (const [id, pr] of Object.entries(data.progress || {})) {
    if (typeof pr?.p !== 'number') continue;
    if (!progress[id] || (pr.ts || 0) > (progress[id].ts || 0)) progress[id] = { p: pr.p, para: pr.para | 0, ts: pr.ts || 0 };
  }
  ls.set('progress', progress);

  stats.words = mergeWords(Array.isArray(data.vocab) ? data.vocab.filter((w) => typeof w?.word === 'string' && typeof w?.translation === 'string') : []);

  // Найденные статьи: добавляем те, которых ещё нет.
  const local = ls.get('local', []);
  const known = new Set(local.map((a) => normalizeUrl(a.url)));
  for (const raw of Array.isArray(data.local) ? data.local : []) {
    const a = clean(raw);
    if (!a || known.has(normalizeUrl(a.url))) continue;
    known.add(normalizeUrl(a.url));
    local.push(raw.query ? { ...a, query: String(raw.query).slice(0, 120) } : a);
    stats.articles++;
  }
  ls.set('local', local.slice(0, 600));

  // Чаты: более свежая версия побеждает.
  for (const [key, conv] of Object.entries(data.chats || {})) {
    if (!/^chat:[\w-]+$/.test(key) || !Array.isArray(conv?.messages)) continue;
    const mine = await kv.get(key);
    if (mine && (mine.updated || 0) >= (conv.updated || 0)) continue;
    await kv.set(key, { ...conv, article: conv.article ? clean(conv.article) : null });
    stats.chats++;
  }
  return stats;
}

/** Состояние хранилища: постоянное ли оно (Safari может стереть данные неустановленного сайта). */
export async function storageStatus() {
  try {
    const persisted = await navigator.storage?.persisted?.();
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    return { persisted: !!persisted, standalone: !!standalone };
  } catch {
    return { persisted: false, standalone: false };
  }
}
