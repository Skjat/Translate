// Режим чтения: текст статьи внутри приложения с переводом по тапу.
import { h, mount, openLayer, fmtDate, toast } from './ui.js';
import { renderMarkdown } from './markdown.js';
import { kv } from './db.js';
import * as store from './store.js';
import { topicById } from './topics.js';
import { attachTranslator, hideTranslation } from './translate.js';
import { openChat } from './chat.js';

const MIN_FONT = 14;
const MAX_FONT = 26;

export async function getCachedText(id) {
  const c = await kv.get('reader:' + id);
  return c?.md || '';
}

/** Чистит ответ Jina Reader (или похожего прокси) до Markdown основного текста. */
export function cleanReaderText(raw) {
  let text = raw;
  const marker = text.indexOf('Markdown Content:');
  if (marker >= 0) text = text.slice(marker + 'Markdown Content:'.length);
  const lines = text.split('\n').filter((line) => {
    const t = line.trim();
    if (/^!\[[^\]]*\]\(data:/.test(t)) return false; // встроенные data:-картинки
    if (/^(skip to (main )?content|перейти к содержанию)/i.test(t)) return false;
    // Строки, состоящие только из нескольких ссылок, — обычно меню навигации.
    const links = t.match(/\[[^\]]*\]\([^)]*\)/g) || [];
    const rest = t.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/[\s*|•·\-–]/g, '');
    if (links.length >= 3 && rest.length < 10) return false;
    return true;
  });
  return lines.join('\n')
    // «Image 3: подпись» — служебный префикс Jina в alt-тексте картинок.
    .replace(/!\[Image \d+:?\s*/g, '![')
    // Пометки для скринридеров в текстах ссылок.
    .replace(/\s*\((opens|open) (in )?a new (tab|window)\)/gi, '')
    .replace(/\s*\(откроется в новой вкладке\)/gi, '')
    // Буквица, оторванная от слова: «C old fusion» → «Cold fusion». Только в первом абзаце текста
    // («T cells», «X rays» в середине статьи — настоящие слова).
    .replace(/^(?:[ \t]*(?:!\[[^\n]*|#[^\n]*)?\n)*[ \t]*([B-HJ-Z]) ([a-z]{2,})/, (m, letter, rest) => m.replace(`${letter} ${rest}`, letter + rest))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const READER_ERRORS = {
  401: 'сервис извлечения текста временно ограничил анонимный доступ',
  402: 'исчерпан бесплатный лимит сервиса извлечения текста',
  403: 'сайт не разрешает извлекать текст',
  429: 'слишком много запросов к сервису извлечения текста',
  451: 'сайт заблокировал извлечение текста',
};

async function fetchReader(url) {
  const headers = { Accept: 'text/plain' };
  const key = store.settings.readerKey?.trim();
  if (key && /(^|\.)r\.jina\.ai$/.test(new URL(url).hostname)) headers.Authorization = 'Bearer ' + key;
  let lastStatus = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000));
    let res;
    try {
      res = await fetch(url, { headers });
    } catch {
      throw new Error('нет соединения с сервисом извлечения текста');
    }
    if (res.ok) return res.text();
    lastStatus = res.status;
    // Временные ограничения и сбои — пробуем ещё раз.
    if (![401, 429, 500, 502, 503, 504].includes(res.status)) break;
  }
  const hint = (lastStatus === 401 || lastStatus === 402 || lastStatus === 429) && !key
    ? '. Поможет бесплатный ключ Jina в настройках («Чтение» → «Дополнительно»)'
    : '';
  throw new Error((READER_ERRORS[lastStatus] || `сервис извлечения текста ответил ${lastStatus}`) + hint);
}

/** Сайт закрыт от автоматического чтения (Cloudflare, капча и т. п.) — текст доступен только в браузере. */
class ProtectedError extends Error {
  constructor() {
    super('сайт защищён от автоматического чтения — статью можно открыть в Safari');
    this.protected = true;
  }
}

const PROTECTED_RE = /^(Title: (Just a moment|Attention Required|Access denied|Are you a robot|Яндекс|Yandex|Вы не робот)|Warning: (This page maybe requiring CAPTCHA|Target URL returned error 40[13]))/mi;

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const protectedHosts = () => store.ls.get('protectedHosts', {});
export const isProtectedHost = (url) => {
  const ts = protectedHosts()[hostOf(url)];
  return !!ts && Date.now() - ts < 14 * 864e5; // через две недели попробуем снова
};
function rememberProtected(url, value) {
  const map = protectedHosts();
  if (value) map[hostOf(url)] = Date.now();
  else delete map[hostOf(url)];
  store.ls.set('protectedHosts', map);
}

async function loadText(article, { force = false } = {}) {
  if (!force) {
    const cached = await kv.get('reader:' + article.id);
    if (cached?.md) return cached.md;
    if (isProtectedHost(article.url)) throw new ProtectedError();
  }
  const tpl = store.settings.readerProxy || 'https://r.jina.ai/{url}';
  const url = tpl.includes('{url_enc}') ? tpl.replace('{url_enc}', encodeURIComponent(article.url)) : tpl.replace('{url}', article.url);
  const raw = await fetchReader(url);
  const md = cleanReaderText(raw);
  if (md.replace(/\s/g, '').length < 500) {
    if (PROTECTED_RE.test(raw)) {
      rememberProtected(article.url, true);
      throw new ProtectedError();
    }
    throw new Error('страница не отдала текст (возможно, пейволл)');
  }
  rememberProtected(article.url, false);
  await kv.set('reader:' + article.id, { md, ts: Date.now() });
  return md;
}

export function openReader(article) {
  store.markRead(article.id);
  const t = topicById(article.topic);
  const s = store.settings;

  const saveBtn = h('button', { class: 'icon-btn', 'aria-label': 'В избранное' }, store.isSaved(article.id) ? '★' : '☆');
  saveBtn.onclick = () => { saveBtn.textContent = store.toggleSaved(article) ? '★' : '☆'; };
  const trBtn = h('button', { class: 'icon-btn tr-toggle' + (s.tapTranslate ? ' on' : ''), 'aria-label': 'Перевод по тапу' }, 'A/Я');
  trBtn.onclick = () => {
    store.saveSettings({ tapTranslate: !store.settings.tapTranslate });
    trBtn.classList.toggle('on', store.settings.tapTranslate);
    if (!store.settings.tapTranslate) hideTranslation();
    toast(store.settings.tapTranslate ? 'Перевод по тапу включён' : 'Перевод по тапу выключен', { timeout: 1500 });
  };
  const fontBtn = h('button', { class: 'icon-btn', 'aria-label': 'Размер шрифта' }, 'Aa');

  const layer = openLayer({
    kind: 'page',
    title: article.source,
    className: 'reader',
    actions: [trBtn, fontBtn, saveBtn],
    onClose: () => { hideTranslation(); detach(); },
  });

  const wrap = h('div', { class: 'reader-wrap', style: { fontSize: s.fontSize + 'px' } });
  fontBtn.onclick = () => {
    const next = store.settings.fontSize >= MAX_FONT ? MIN_FONT : store.settings.fontSize + 2;
    store.saveSettings({ fontSize: next });
    wrap.style.fontSize = next + 'px';
    toast(`Размер текста: ${next}`, { timeout: 1000 });
  };

  const meta = [
    `${t.emoji} ${t.short}`,
    article.published ? fmtDate(article.published) : null,
    article.reading_minutes ? `${article.reading_minutes} мин` : null,
    article.lang.toUpperCase(),
  ].filter(Boolean).join(' · ');

  const content = h('div', { class: 'reader-content' }, skeleton());
  const titleEl = h('h1', { class: 'reader-title' }, article.title);

  mount(wrap,
    h('div', { class: 'reader-kicker' }, meta),
    titleEl,
    article.lang !== 'ru' && article.title_ru && article.title_ru !== article.title ? h('div', { class: 'reader-subtitle' }, article.title_ru) : null,
    article.summary ? h('div', { class: 'reader-summary no-translate' }, h('b', {}, 'О чём статья. '), article.summary) : null,
    h('div', { class: 'reader-tools' },
      h('a', { class: 'btn', href: article.url, target: '_blank', rel: 'noopener' }, '↗ Оригинал'),
      h('button', { class: 'btn accent', onclick: () => openChat(article) }, '✨ Обсудить с Claude')),
    article.lang !== 'ru' && !store.ls.get('hint.tap', false)
      ? h('div', { class: 'reader-hint no-translate', onclick: (e) => { store.ls.set('hint.tap', true); e.currentTarget.remove(); } },
        'Коснитесь английского слова — появится перевод. Выделите фразу — переведётся целиком. «A/Я» вверху выключает перевод. ✕')
      : null,
    content,
  );
  layer.body.append(wrap, h('button', { class: 'fab', 'aria-label': 'Спросить Claude', onclick: () => openChat(article) }, '✨'));
  const detach = attachTranslator(wrap);

  const load = async (force = false) => {
    content.replaceChildren(skeleton());
    try {
      const md = await loadText(article, { force });
      content.innerHTML = renderMarkdown(md, { base: article.url });
      // Битые картинки убираем, чтобы не оставались пустые рамки с подписью.
      for (const img of content.querySelectorAll('img')) img.addEventListener('error', () => img.remove(), { once: true });
      content.append(h('div', { class: 'reader-end no-translate' },
        h('p', {}, 'Текст извлечён автоматически — возможны неточности оформления.'),
        h('a', { class: 'btn', href: article.url, target: '_blank', rel: 'noopener' }, 'Открыть оригинал')));
    } catch (err) {
      const retell = () => openChat(article, { prompt: 'Перескажи подробно, о чём эта статья: основные идеи, факты и выводы.' });
      content.replaceChildren(err.protected
        ? h('div', { class: 'reader-error no-translate' },
          h('p', {}, h('b', {}, `${article.source} не даёт загрузить текст в приложение`), ' — сайт защищён от автоматического чтения. Откройте статью в Safari или попросите Claude её пересказать.'),
          h('div', { class: 'row' },
            h('a', { class: 'btn accent', href: article.url, target: '_blank', rel: 'noopener' }, '↗ Открыть в Safari'),
            h('button', { class: 'btn', onclick: retell }, '✨ Пересказ от Claude'),
            h('button', { class: 'btn ghost', onclick: () => load(true) }, 'Попробовать ещё раз')))
        : h('div', { class: 'reader-error no-translate' },
          h('p', {}, 'Не получилось загрузить текст статьи: ' + (err.message || err) + '.'),
          h('div', { class: 'row' },
            h('a', { class: 'btn', href: article.url, target: '_blank', rel: 'noopener' }, '↗ Открыть в Safari'),
            h('button', { class: 'btn', onclick: () => load(true) }, 'Повторить'),
            h('button', { class: 'btn accent', onclick: retell }, '✨ Пересказ от Claude'))));
    }
  };
  load();
  return layer;
}

function skeleton() {
  return h('div', { class: 'skeleton' }, ...Array.from({ length: 7 }, (_, i) => h('div', { class: 'sk-line', style: { width: `${70 + ((i * 37) % 30)}%` } })));
}
