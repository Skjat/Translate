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
function cleanReaderText(raw) {
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
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function loadText(article, { force = false } = {}) {
  if (!force) {
    const cached = await kv.get('reader:' + article.id);
    if (cached?.md) return cached.md;
  }
  const tpl = store.settings.readerProxy || 'https://r.jina.ai/{url}';
  const url = tpl.includes('{url_enc}') ? tpl.replace('{url_enc}', encodeURIComponent(article.url)) : tpl.replace('{url}', article.url);
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'text/plain' } });
  } catch {
    throw new Error('нет соединения с сервисом извлечения текста');
  }
  if (!res.ok) throw new Error(`сервис извлечения текста ответил ${res.status}`);
  const md = cleanReaderText(await res.text());
  if (md.replace(/\s/g, '').length < 500) throw new Error('страница не отдала текст (возможно, пейволл или защита от ботов)');
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
      content.append(h('div', { class: 'reader-end no-translate' },
        h('p', {}, 'Текст извлечён автоматически — возможны неточности оформления.'),
        h('a', { class: 'btn', href: article.url, target: '_blank', rel: 'noopener' }, 'Открыть оригинал')));
    } catch (err) {
      content.replaceChildren(h('div', { class: 'reader-error no-translate' },
        h('p', {}, 'Не получилось загрузить текст статьи: ' + (err.message || err) + '.'),
        h('div', { class: 'row' },
          h('a', { class: 'btn', href: article.url, target: '_blank', rel: 'noopener' }, '↗ Открыть в Safari'),
          h('button', { class: 'btn', onclick: () => load(true) }, 'Повторить'),
          h('button', { class: 'btn accent', onclick: () => openChat(article, { prompt: 'Перескажи подробно, о чём эта статья: основные идеи, факты и выводы.' }) }, '✨ Пересказ от Claude'))));
    }
  };
  load();
  return layer;
}

function skeleton() {
  return h('div', { class: 'skeleton' }, ...Array.from({ length: 7 }, (_, i) => h('div', { class: 'sk-line', style: { width: `${70 + ((i * 37) % 30)}%` } })));
}
