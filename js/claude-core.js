// Общая логика запросов к Claude API (браузер + Node).
// Клиент — официальный SDK @anthropic-ai/sdk; сюда он передаётся снаружи.

export const DEFAULT_MODEL = 'claude-opus-5-5';

// price — $ за 1M токенов (вход / выход).
// fallbacks — серверный фолбэк при отказе классификаторов (beta server-side-fallback-2026-07-01).
// updates — короткие заметки о ходе работы между вызовами инструментов (beta thinking-display-updates).
// binding — мягкая обработка несовпадения истории (beta thinking-binding-controls).
// dynamicWeb — версии web_search/web_fetch с динамической фильтрацией (_20260209).
export const MODELS = [
  { id: 'claude-opus-5-5',   label: 'Claude Opus 5.5',   note: 'по умолчанию, лучший баланс',  price: [4, 20],    fallbacks: true,  updates: true,  binding: true,  dynamicWeb: true },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'быстрее и дешевле',            price: [2, 10],    fallbacks: true,  updates: true,  binding: true,  dynamicWeb: true },
  { id: 'claude-haiku-5-5',  label: 'Claude Haiku 5.5',  note: 'самый быстрый и дешёвый',      price: [0.1, 0.5], fallbacks: false, updates: false, binding: false, dynamicWeb: false },
  { id: 'claude-fable-5-1',  label: 'Claude Fable 5.1',  note: 'самый мощный, дорогой',        price: [10, 50],   fallbacks: true,  updates: true,  binding: true,  dynamicWeb: false },
];

export const modelInfo = (id) => MODELS.find((m) => m.id === id) || { id, label: id, price: [0, 0] };

export function webTools(model, { search = {}, fetch = null } = {}) {
  const dyn = modelInfo(model).dynamicWeb;
  const tools = [{ type: dyn ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', ...search }];
  if (fetch) tools.push({ type: dyn ? 'web_fetch_20260209' : 'web_fetch_20250910', name: 'web_fetch', ...fetch });
  return tools;
}

/**
 * Собирает параметры для client.beta.messages.* с учётом возможностей модели.
 * Мышление адаптивное (у актуальных моделей его нельзя выключить), глубина — через effort.
 */
export function buildRequest(base, { model = DEFAULT_MODEL, effort = 'medium', display = 'omitted', binding = true } = {}) {
  const info = modelInfo(model);
  const betas = [];
  const thinking = { type: 'adaptive' };
  if (display === 'updates' && info.updates) {
    thinking.display = 'updates';
    betas.push('thinking-display-updates-2026-08-18');
  } else if (display === 'summarized') {
    thinking.display = 'summarized';
  }
  if (binding && info.binding) {
    thinking.block_binding = { prefix_mismatch_behavior: 'drop_block' };
    betas.push('thinking-binding-controls-2026-08-01');
  }
  const req = { ...base, model, thinking, output_config: { ...(base.output_config || {}), effort } };
  if (info.fallbacks) {
    req.fallbacks = 'default';
    betas.push('server-side-fallback-2026-07-01');
  }
  if (betas.length) req.betas = betas;
  return req;
}

/** Та же заявка без beta-возможностей — запасной вариант, если API их не принял. */
export function plainRequest(req) {
  const { betas, fallbacks, thinking, cache_control, ...rest } = req;
  return { ...rest, thinking: { type: 'adaptive' } };
}

/** Убирает блоки мышления из истории (разовое восстановление после ошибки подписи). */
export function stripThinking(messages) {
  return messages.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return m;
    const content = m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
    return { ...m, content: content.length ? content : [{ type: 'text', text: '…' }] };
  });
}

export const isAbortError = (err) =>
  err?.name === 'AbortError' || err?.constructor?.name === 'APIUserAbortError' || /aborted|abort/i.test(err?.message || '') && !err?.status;

const isSignatureError = (err) =>
  err?.status === 400 && /signature|different conversation|block_binding/i.test(err?.message || '');

/**
 * Стриминговый запрос с восстановлением:
 *  - 400 из-за подписи блоков мышления → убираем их из истории и повторяем;
 *  - 400 при beta-параметрах → повторяем без них.
 * attach(stream) вызывается для каждой попытки, чтобы повесить обработчики событий.
 */
export async function streamWithRecovery(client, req, attach, { signal } = {}) {
  let attempt = req;
  let triedStrip = false;
  let triedPlain = false;
  for (;;) {
    try {
      const stream = client.beta.messages.stream(attempt, signal ? { signal } : undefined);
      attach?.(stream);
      const message = await stream.finalMessage();
      return { message, request: attempt };
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) throw err;
      if (err?.status === 400) {
        if (!triedStrip && isSignatureError(err)) {
          triedStrip = true;
          attempt = { ...attempt, messages: stripThinking(attempt.messages) };
          continue;
        }
        if (!triedPlain && (attempt.betas || attempt.fallbacks)) {
          triedPlain = true;
          console.warn('Claude: запрос с beta-параметрами отклонён, повторяю без них:', err.message);
          attempt = plainRequest(attempt);
          continue;
        }
      }
      throw err;
    }
  }
}

/** Человекочитаемое описание ошибки API. */
export function describeError(err) {
  if (!err) return 'Неизвестная ошибка';
  if (err.code === 'NO_KEY') return err.message;
  const s = err.status;
  if (s === 401) return 'API-ключ не подошёл. Проверьте его в настройках.';
  if (s === 403) return 'У ключа нет доступа к этой модели или функции (403).';
  if (s === 404) return 'Модель не найдена (404). Попробуйте другую модель в настройках.';
  if (s === 413) return 'Слишком длинный запрос (413).';
  if (s === 429) return 'Превышен лимит запросов или бюджета API (429). Попробуйте чуть позже.';
  if (s === 529 || s === 503) return 'Серверы Claude сейчас перегружены. Попробуйте через минуту.';
  if (s >= 500) return `Ошибка на стороне Claude (${s}). Попробуйте ещё раз.`;
  if (s === 400) return 'Запрос отклонён: ' + (err.error?.error?.message || err.message || '400');
  if (/fetch|network|connection/i.test(err.message || '')) return 'Нет соединения с api.anthropic.com.';
  return err.message || String(err);
}

/** Приблизительная стоимость по usage (без учёта поиска и кэша). */
export function estimateCost(model, usage = {}) {
  const [pin, pout] = modelInfo(model).price || [0, 0];
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  const searches = usage.server_tool_use?.web_search_requests || 0;
  return (input * pin + (usage.output_tokens || 0) * pout) / 1e6 + searches * 0.01;
}

export function addUsage(total, u) {
  if (!u) return total;
  total.input_tokens = (total.input_tokens || 0) + (u.input_tokens || 0);
  total.output_tokens = (total.output_tokens || 0) + (u.output_tokens || 0);
  total.cache_read_input_tokens = (total.cache_read_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  total.cache_creation_input_tokens = (total.cache_creation_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const ws = u.server_tool_use?.web_search_requests || 0;
  total.server_tool_use = { web_search_requests: (total.server_tool_use?.web_search_requests || 0) + ws };
  return total;
}
