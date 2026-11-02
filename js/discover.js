// Обновление ленты: общая лента с сервера + поиск свежих статей через Claude прямо в приложении.
import { discoverArticles, pickStaleTopics } from './discover-core.js';
import { getClient, hasKey } from './claude.js';
import * as store from './store.js';
import { estimateCost, describeError } from './claude-core.js';

let running = null; // { controller, promise, label }

export const isRunning = () => !!running;
export const runningLabel = () => running?.label || '';

/**
 * Ищет статьи через Claude и добавляет их в ленту.
 * opts: { topics?, count?, lang?, query?, onEvent? }
 * Возвращает { added, rejected, cost, searches }.
 */
export async function runDiscovery(opts = {}) {
  if (running) throw new Error('Поиск статей уже идёт — дождитесь окончания.');
  const s = store.settings;
  const lib = store.library();
  const controller = new AbortController();
  const query = (opts.query || '').trim();
  const label = query ? `Ищу статьи: «${query}»` : 'Ищу свежие статьи';
  const onEvent = (ev) => {
    store.emit('discover-event', ev);
    opts.onEvent?.(ev);
  };

  const promise = (async () => {
    const client = getClient();
    const result = await discoverArticles(client, {
      model: s.model,
      topics: opts.topics?.length ? opts.topics : pickStaleTopics(lib, 4),
      count: opts.count || s.discoverCount,
      lang: opts.lang || s.discoverLang,
      query,
      exclude: lib.map((a) => a.url),
      trustedOnly: s.trustedOnly,
      domains: store.domainsList(),
      signal: controller.signal,
    }, onEvent);
    const added = store.addLocalArticles(result.articles);
    store.setMeta({ lastDiscoverAt: Date.now() });
    return {
      added,
      rejected: result.rejected,
      searches: result.searches,
      cost: estimateCost(s.model, result.usage),
    };
  })();

  running = { controller, promise, label };
  store.emit('discover-state', { running: true, label });
  try {
    return await promise;
  } finally {
    running = null;
    store.emit('discover-state', { running: false });
  }
}

export function cancelDiscovery() {
  running?.controller.abort();
}

/** Загружает общую ленту; молча игнорирует ошибки сети. */
export async function refreshRemote() {
  try {
    return await store.fetchRemoteFeed();
  } catch (err) {
    console.warn('Не удалось обновить ленту:', err);
    return -1;
  }
}

/**
 * Автообновление при запуске: раз в сутки ищем свежие статьи через Claude,
 * но только если общая лента (GitHub Action) давно не обновлялась — чтобы не тратить ключ дважды.
 */
export async function maybeAutoDiscover() {
  const s = store.settings;
  if (!s.autoDiscover || !hasKey() || !navigator.onLine || running) return null;
  const DAY = 864e5;
  const { lastDiscoverAt } = store.meta();
  const feedAge = Date.now() - (Date.parse(store.feedUpdatedAt() || 0) || 0);
  if (Date.now() - (lastDiscoverAt || 0) < 20 * 3600e3) return null;
  if (feedAge < 1.25 * DAY) return null;
  try {
    return await runDiscovery({ count: Math.min(8, s.discoverCount) });
  } catch (err) {
    console.warn('Автопоиск статей:', describeError(err));
    store.setMeta({ lastDiscoverAt: Date.now() - 18 * 3600e3 }); // повторим не раньше чем через пару часов
    return null;
  }
}
