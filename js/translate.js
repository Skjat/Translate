// Перевод на русский по тапу на слово или по выделению текста.
import { settings, ls } from './store.js';
import { h, debounce } from './ui.js';
import { getClient, hasKey } from './claude.js';
import { buildRequest, streamWithRecovery, describeError } from './claude-core.js';

const containers = new Set();
const WORD_CHAR = /[\p{L}\p{M}\p{N}'’\-]/u;
const LATIN = /[a-z]/i;
const CYRILLIC = /[а-яё]/i;

// ---------- движки перевода ----------
const cache = new Map(Object.entries(ls.get('tcache', {})));
const saveCache = debounce(() => {
  const entries = [...cache.entries()].slice(-400);
  ls.set('tcache', Object.fromEntries(entries));
}, 800);

async function viaGoogle(text) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ru&hl=ru&dt=t&dt=bd&dj=1&q=' + encodeURIComponent(text);
  const res = await fetch(url);
  if (!res.ok) throw new Error('Google Translate: ' + res.status);
  const d = await res.json();
  const translation = (d.sentences || []).map((s) => s.trans || '').join('').trim();
  if (!translation) throw new Error('пустой ответ');
  const dict = (d.dict || []).map((x) => ({ pos: x.pos, terms: (x.terms || []).slice(0, 6) })).filter((x) => x.terms.length);
  return { translation, dict, engine: 'Google' };
}

/** Приводит регистр перевода к регистру исходника: «bright» → «яркий», а не «Яркий». */
function matchCase(src, tr) {
  if (src && src === src.toLowerCase() && tr && !/\s/.test(src)) return tr.charAt(0).toLowerCase() + tr.slice(1);
  return tr;
}

async function viaMyMemory(text) {
  const url = `https://api.mymemory.translated.net/get?langpair=en|ru&q=${encodeURIComponent(text.slice(0, 480))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('MyMemory: ' + res.status);
  const d = await res.json();
  const translation = matchCase(text, (d.responseData?.translatedText || '').trim());
  if (!translation || /MYMEMORY WARNING/i.test(translation)) throw new Error('MyMemory: лимит или пустой ответ');
  // MyMemory — память переводов от пользователей, в вариантах бывает мусор. Берём только
  // точные совпадения приличного качества, без латиницы и не длиннее исходника заметно.
  const srcWords = text.trim().split(/\s+/).length;
  const seen = new Set([translation.toLowerCase()]);
  const alts = [];
  for (const m of d.matches || []) {
    const t = matchCase(text, (m.translation || '').trim().replace(/[.!]+$/, ''));
    const quality = Number.parseInt(m.quality, 10);
    if (!t || /[a-z]/i.test(t) || seen.has(t.toLowerCase())) continue;
    if ((m.match ?? 0) < 0.8 || !(quality >= 70)) continue;
    if (t.split(/\s+/).length > srcWords + 2) continue;
    seen.add(t.toLowerCase());
    alts.push(t);
    if (alts.length >= 4) break;
  }
  return { translation, dict: alts.length ? [{ pos: 'варианты', terms: alts }] : [], engine: 'MyMemory' };
}

const CLAUDE_SCHEMA = {
  type: 'object',
  properties: {
    translation: { type: 'string', description: 'Перевод на русский, подходящий именно в этом контексте' },
    part_of_speech: { type: 'string', description: 'Часть речи по-русски для отдельного слова; пустая строка для фраз' },
    alternatives: { type: 'array', items: { type: 'string' }, description: '0–4 других варианта перевода' },
    explanation: { type: 'string', description: '1–2 предложения: оттенки значения, идиома, термин — если это полезно; иначе пустая строка' },
  },
  required: ['translation', 'part_of_speech', 'alternatives', 'explanation'],
  additionalProperties: false,
};

export async function viaClaude(text, context = '') {
  const client = getClient();
  const prompt = context && context !== text
    ? `Переведи на русский «${text}» в контексте этого фрагмента:\n«${context}»`
    : `Переведи на русский: «${text}»`;
  const req = buildRequest({
    max_tokens: 4000,
    system: 'Ты — точный и внимательный переводчик с английского на русский для читателя научно-популярных статей. Учитывай контекст, терминологию и идиомы.',
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: { type: 'json_schema', schema: CLAUDE_SCHEMA } },
  }, { model: settings.translateModel, effort: 'low', binding: false });
  const { message } = await streamWithRecovery(client, req);
  if (message.stop_reason === 'refusal') throw new Error('Claude отказался переводить этот фрагмент');
  const raw = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const d = JSON.parse(raw);
  const dict = [];
  if (d.alternatives?.length) dict.push({ pos: d.part_of_speech || 'варианты', terms: d.alternatives.slice(0, 4) });
  return { translation: d.translation, dict, note: d.explanation || '', engine: 'Claude', pos: d.part_of_speech || '' };
}

async function translate(text, context, { forceClaude = false } = {}) {
  const engine = forceClaude ? 'claude' : settings.translateEngine;
  const key = `${engine}|${forceClaude ? context + '|' : ''}${text}`;
  if (cache.has(key)) return cache.get(key);
  const order = engine === 'claude' ? ['claude', 'google', 'mymemory'] : engine === 'mymemory' ? ['mymemory', 'google'] : ['google', 'mymemory'];
  if (forceClaude) order.splice(1);
  let lastErr;
  for (const e of order) {
    if (e === 'claude' && !hasKey()) { lastErr = new Error('Для перевода через Claude нужен API-ключ'); continue; }
    try {
      const result = e === 'claude' ? await viaClaude(text, context) : e === 'mymemory' ? await viaMyMemory(text) : await viaGoogle(text);
      cache.set(key, result);
      saveCache();
      return result;
    } catch (err) {
      lastErr = err;
      console.warn('Перевод через', e, 'не удался:', err);
    }
  }
  throw lastErr || new Error('Перевод недоступен');
}

// ---------- карточка перевода ----------
let card = null;
let mark = null;
let current = null;
let requestSeq = 0;

function ensureCard() {
  if (card) return card;
  card = h('div', { class: 'tr-card', role: 'dialog', 'aria-live': 'polite' });
  document.body.append(card);
  mark = h('div', { class: 'tr-mark' });
  document.body.append(mark);
  return card;
}

export function hideTranslation() {
  card?.classList.remove('show');
  mark?.classList.remove('show');
  current = null;
}

function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.9;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { /* озвучка недоступна */ }
}

function renderCard({ text, context, state, result, error }) {
  ensureCard();
  const isPhrase = /\s/.test(text.trim());
  const head = h('div', { class: 'tr-head' },
    h('div', { class: 'tr-src' + (isPhrase ? ' phrase' : '') }, text),
    h('button', { class: 'icon-btn small', 'aria-label': 'Произнести', onclick: () => speak(text) }, '🔊'),
    h('button', { class: 'icon-btn small', 'aria-label': 'Закрыть', onclick: hideTranslation }, '✕'));

  let body;
  if (state === 'loading') body = h('div', { class: 'tr-main muted' }, 'Перевожу…');
  else if (state === 'error') body = h('div', { class: 'tr-main error' }, error);
  else {
    body = h('div', {},
      h('div', { class: 'tr-main' }, result.translation),
      result.dict?.length
        ? h('div', { class: 'tr-dict' }, result.dict.slice(0, 3).map((d) => h('div', {}, h('span', { class: 'tr-pos' }, d.pos + ': '), d.terms.join(', '))))
        : null,
      result.note ? h('div', { class: 'tr-note' }, result.note) : null,
      h('div', { class: 'tr-engine' }, result.engine));
  }

  const canClaude = result?.engine !== 'Claude';
  const actions = h('div', { class: 'tr-actions' },
    canClaude && state !== 'loading'
      ? h('button', {
        class: 'chip accent',
        onclick: () => show(text, context, { forceClaude: true }),
      }, '✨ В контексте')
      : null,
    h('button', {
      class: 'chip',
      onclick: async () => {
        try { await navigator.clipboard.writeText(result ? `${text} — ${result.translation}` : text); } catch { /* ignore */ }
      },
    }, 'Копировать'));

  card.replaceChildren(head, body, actions);
  card.classList.add('show');
}

async function show(text, context = '', { forceClaude = false, rect = null } = {}) {
  text = text.trim();
  if (!text) return;
  current = text;
  const seq = ++requestSeq;
  if (rect) placeMark(rect);
  if (forceClaude && !hasKey()) {
    renderCard({ text, context, state: 'error', error: 'Для перевода в контексте добавьте API-ключ Claude в настройках.' });
    return;
  }
  renderCard({ text, context, state: 'loading' });
  try {
    const result = await translate(text, context, { forceClaude });
    if (seq !== requestSeq) return;
    renderCard({ text, context, state: 'done', result });
  } catch (err) {
    if (seq !== requestSeq) return;
    renderCard({ text, context, state: 'error', error: err?.code === 'NO_KEY' || err?.status ? describeError(err) : 'Не удалось перевести: ' + (err?.message || err) });
  }
}

function placeMark(rect) {
  ensureCard();
  Object.assign(mark.style, {
    left: rect.left - 2 + 'px',
    top: rect.top - 1 + 'px',
    width: rect.width + 4 + 'px',
    height: rect.height + 2 + 'px',
  });
  mark.classList.add('show');
}

// ---------- определение слова под пальцем ----------
function caretRange(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos) return null;
    const r = document.createRange();
    r.setStart(pos.offsetNode, pos.offset);
    return r;
  }
  return null;
}

function wordAt(node, offset) {
  const text = node.data;
  let start = offset;
  let end = offset;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
  while (end < text.length && WORD_CHAR.test(text[end])) end++;
  while (start < end && /['’\-]/.test(text[start])) start++;
  while (end > start && /['’\-]/.test(text[end - 1])) end--;
  if (end <= start) return null;
  return { start, end, word: text.slice(start, end) };
}

function sentenceAround(node, word) {
  const block = node.parentElement?.closest('p, li, blockquote, h1, h2, h3, h4, td, figcaption, div') || node.parentElement;
  const text = (block?.textContent || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const sentences = text.match(/[^.!?…]+[.!?…]*["»”’)]?/g) || [text];
  const hit = sentences.find((s) => s.includes(word)) || text;
  return hit.trim().slice(0, 600);
}

function onTap(e) {
  if (!settings.tapTranslate) return;
  if (e.target.closest('a, button, input, textarea, select, img, .no-translate, .tr-card')) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim()) return;
  const range = caretRange(e.clientX, e.clientY);
  const node = range?.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) { hideTranslation(); return; }
  const w = wordAt(node, range.startOffset);
  if (!w || !LATIN.test(w.word) || CYRILLIC.test(w.word) || w.word.length > 40) { hideTranslation(); return; }
  const r = document.createRange();
  r.setStart(node, w.start);
  r.setEnd(node, w.end);
  const rect = r.getBoundingClientRect();
  // Палец должен попасть в само слово, а не в пустое место рядом.
  if (e.clientX < rect.left - 12 || e.clientX > rect.right + 12 || e.clientY < rect.top - 12 || e.clientY > rect.bottom + 12) { hideTranslation(); return; }
  show(w.word, sentenceAround(node, w.word), { rect });
}

const onSelection = debounce(() => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString().replace(/\s+/g, ' ').trim();
  if (!text || text.length > 1500 || !LATIN.test(text) || text === current) return;
  if ((text.match(/[а-яё]/gi) || []).length > text.length / 3) return; // это русский текст
  const anchor = sel.anchorNode;
  const inside = [...containers].some((c) => c.isConnected && c.contains(anchor));
  if (!inside) return;
  mark?.classList.remove('show');
  const context = anchor?.nodeType === Node.TEXT_NODE && text.length < 80 ? sentenceAround(anchor, text.split(' ')[0]) : '';
  show(text, context);
}, 550);

let globalBound = false;

/** Включает перевод по тапу/выделению внутри контейнера. */
export function attachTranslator(container) {
  containers.add(container);
  container.classList.add('translatable');
  container.addEventListener('click', onTap);
  if (!globalBound) {
    globalBound = true;
    document.addEventListener('selectionchange', onSelection);
    window.addEventListener('resize', hideTranslation);
    // Подсветка слова закреплена в координатах экрана — при прокрутке убираем её.
    document.addEventListener('scroll', () => mark?.classList.remove('show'), { capture: true, passive: true });
  }
  return () => {
    containers.delete(container);
    container.removeEventListener('click', onTap);
  };
}

/** Перевести произвольный текст (например, заголовок). */
export const translateText = (text, context) => show(text, context);
