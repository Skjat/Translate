// Главный модуль: вкладки «Лента», «Случайное», «Избранное», «Настройки».
import { h, $, mount, toast, openLayer, fmtDate, timeAgo, plural, debounce, shuffle } from './ui.js';
import * as store from './store.js';
import { TOPICS, topicById } from './topics.js';
import { openReader, isCached, loadCachedIds, prefetchText, forgetCached, isProtectedHost } from './reader.js';
import { renderVocab } from './vocab-ui.js';
import { dueWords } from './vocab.js';
import { exportBackup, importBackup, storageStatus } from './backup.js';
import { openChat, listChats } from './chat.js';
import { runDiscovery, cancelDiscovery, isRunning, runningLabel, refreshRemote, maybeAutoDiscover } from './discover.js';
import { pickStaleTopics } from './discover-core.js';
import { MODELS, describeError, modelInfo } from './claude-core.js';
import { hasKey, testKey } from './claude.js';
import { kv } from './db.js';
import { clearTranslationCache } from './translate.js';

const view = $('#view');
const ui = {
  tab: 'feed',
  topic: 'all',
  lang: 'all',
  unread: false,
  tag: '',
  q: '',
  queriesOnly: false,
  savedSeg: 'saved',
  randomOne: null,
  randomMix: null,
  limit: 30,
  discoverLog: [],
};

// ---------- общие элементы ----------
function articleCard(a, { compact = false } = {}) {
  const t = topicById(a.topic);
  const saved = store.isSaved(a.id);
  const read = store.isRead(a.id);
  const pr = store.getProgress(a.id);
  const progress = pr && pr.p >= 0.05 && !read ? pr.p : 0;
  const meta = h('div', { class: 'card-meta' },
    h('button', { class: 'topic-pill', onclick: (e) => { e.stopPropagation(); setFilter({ topic: a.topic }); } }, `${t.emoji} ${t.short}`),
    h('span', {}, a.source),
    a.published ? h('span', {}, fmtDate(a.published)) : null,
    a.reading_minutes ? h('span', {}, `${a.reading_minutes} мин`) : null,
    h('span', { class: 'lang' }, a.lang.toUpperCase()),
    store.isNew(a) ? h('span', { class: 'badge new' }, 'новое') : null,
    a.kind === 'longread' ? h('span', { class: 'badge' }, 'лонгрид') : null,
    saved && isCached(a.id) ? h('span', { class: 'badge offline', title: 'Текст сохранён — можно читать без сети' }, '📥 офлайн') : null);

  const saveBtn = h('button', { class: 'icon-btn small' + (saved ? ' on' : ''), 'aria-label': 'В избранное' }, saved ? '★' : '☆');
  saveBtn.onclick = (e) => {
    e.stopPropagation();
    const on = store.toggleSaved(a);
    saveBtn.textContent = on ? '★' : '☆';
    saveBtn.classList.toggle('on', on);
    toast(on ? 'В избранном — текст сохранится для чтения без сети' : 'Убрано из избранного', { timeout: 1400 });
  };

  return h('article', { class: 'card' + (read ? ' read' : ''), onclick: () => openReader(a) },
    meta,
    h('h3', { class: 'card-title' }, a.lang === 'ru' ? a.title : a.title_ru || a.title),
    a.lang !== 'ru' && a.title_ru && a.title_ru !== a.title ? h('div', { class: 'card-orig' }, a.title) : null,
    !compact && a.summary ? h('p', { class: 'card-summary' }, a.summary) : null,
    !compact && (a.tags?.length || a.query)
      ? h('div', { class: 'card-tags' },
        a.query ? h('button', { class: 'tag query', onclick: (e) => { e.stopPropagation(); setFilter({ queriesOnly: true }); } }, '🔎 ' + a.query) : null,
        (a.tags || []).map((tag) => h('button', { class: 'tag', onclick: (e) => { e.stopPropagation(); setFilter({ tag }); } }, '#' + tag)))
      : null,
    h('div', { class: 'card-actions' },
      h('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); openReader(a); } }, 'Читать'),
      h('button', { class: 'btn small accent', onclick: (e) => { e.stopPropagation(); openChat(a); } }, '✨ Claude'),
      h('a', { class: 'btn small ghost', href: a.url, target: '_blank', rel: 'noopener', onclick: (e) => { e.stopPropagation(); store.markRead(a.id); } }, '↗'),
      h('span', { class: 'spacer' }),
      saveBtn),
    progress ? h('div', { class: 'card-progress', title: `Прочитано ${Math.round(progress * 100)}%` }, h('span', { style: { width: Math.round(progress * 100) + '%' } })) : null);
}

function setFilter(patch) {
  Object.assign(ui, { topic: 'all', tag: '', queriesOnly: false, q: '' }, patch, { limit: 30 });
  switchTab('feed');
  view.scrollTop = 0;
}

// ---------- Лента ----------
function filtered() {
  const q = ui.q.trim().toLowerCase();
  return store.library().filter((a) => {
    if (ui.topic !== 'all' && a.topic !== ui.topic) return false;
    if (ui.lang !== 'all' && a.lang !== ui.lang) return false;
    if (ui.unread && store.isRead(a.id)) return false;
    if (ui.tag && !a.tags.includes(ui.tag)) return false;
    if (ui.queriesOnly && !a.query) return false;
    if (q) {
      const hay = [a.title, a.title_ru, a.summary, a.source, ...(a.tags || []), a.query || '', topicById(a.topic).name].join(' ').toLowerCase();
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

function discoverBanner() {
  if (!isRunning()) return null;
  return h('div', { class: 'banner live' },
    h('span', { class: 'spinner' }),
    h('div', { class: 'banner-text' },
      h('b', {}, runningLabel() + '…'),
      h('div', { class: 'muted small' }, ui.discoverLog[ui.discoverLog.length - 1] || 'Claude просматривает издания')),
    h('button', { class: 'chip', onclick: cancelDiscovery }, 'Стоп'));
}

/** Когда лента в последний раз пополнялась: общий файл или поиск в приложении. */
function lastUpdate() {
  const feed = Date.parse(store.feedUpdatedAt() || 0) || 0;
  return Math.max(feed, store.meta().lastDiscoverAt || 0) || null;
}

/** Подсказка, если свежие статьи давно не приходили, — с причиной и действием. */
function staleBanner() {
  if (isRunning()) return null;
  const err = store.meta().lastDiscoverError;
  if (err) {
    return h('div', { class: 'banner alert' },
      h('div', { class: 'banner-text' }, h('b', {}, 'Свежие статьи не загрузились'), h('div', { class: 'muted small' }, err)),
      h('button', { class: 'chip', onclick: openRefreshSheet }, 'Повторить'));
  }
  const age = Date.now() - (lastUpdate() || 0);
  if (age < 3 * 864e5 || hasKey()) return null;
  const days = Math.floor(age / 864e5);
  return h('div', { class: 'banner alert' },
    h('div', { class: 'banner-text' },
      h('b', {}, `Лента не пополнялась ${days} ${plural(days, 'день', 'дня', 'дней')}`),
      h('div', { class: 'muted small' }, 'Добавьте ключ Claude в настройках — приложение будет само находить свежие статьи раз в сутки.')),
    h('button', { class: 'chip', onclick: () => switchTab('settings') }, 'Настройки'));
}

let feedRefs = null; // элементы ленты, которые обновляются без пересоздания поля поиска

function topicChips() {
  return h('div', { class: 'chips scroll' },
    h('button', { class: 'chip' + (ui.topic === 'all' && !ui.queriesOnly ? ' active' : ''), onclick: () => setFilter({}) }, 'Все'),
    store.library().some((a) => a.query) ? h('button', { class: 'chip' + (ui.queriesOnly ? ' active' : ''), onclick: () => setFilter({ queriesOnly: !ui.queriesOnly }) }, '🔎 Мои запросы') : null,
    TOPICS.map((t) => h('button', {
      class: 'chip' + (ui.topic === t.id ? ' active' : ''),
      onclick: () => setFilter({ topic: ui.topic === t.id ? 'all' : t.id }),
    }, `${t.emoji} ${t.short}`)));
}

function renderList() {
  if (!feedRefs) return;
  const { listEl } = feedRefs;
  const current = filtered();
  listEl.replaceChildren();
  if (ui.tag) listEl.append(h('div', { class: 'active-filter' }, `#${ui.tag}`, h('button', { class: 'chip', onclick: () => setFilter({}) }, '✕ Сбросить')));
  if (!current.length) {
    listEl.append(h('div', { class: 'empty' },
      h('p', {}, ui.q ? `По запросу «${ui.q}» ничего нет.` : 'Здесь пока пусто.'),
      h('button', { class: 'btn accent', onclick: () => openChat(null, { prompt: ui.q ? `Хочу статьи про ${ui.q}` : '' }) }, ui.q ? `✨ Найти статьи про «${ui.q}»` : '✨ Попросить Claude подобрать статьи')));
    return;
  }
  current.slice(0, ui.limit).forEach((a) => listEl.append(articleCard(a)));
  if (current.length > ui.limit) {
    listEl.append(h('button', { class: 'btn wide', onclick: () => { ui.limit += 30; renderList(); } }, `Показать ещё (${current.length - ui.limit})`));
  }
  if (ui.q) listEl.append(h('button', { class: 'btn wide accent', onclick: () => openChat(null, { prompt: `Хочу больше статей про ${ui.q}` }) }, `✨ Найти ещё статьи про «${ui.q}»`));
}
const renderListSoon = debounce(renderList, 200);

/** «Продолжить чтение» — начатые статьи, только когда фильтры не выбраны. */
function continueBlock() {
  if (ui.q || ui.tag || ui.topic !== 'all' || ui.queriesOnly) return null;
  const items = store.inProgress().slice(0, 3);
  if (!items.length) return null;
  return h('section', { class: 'continue' },
    h('div', { class: 'section-title' }, '📖 Продолжить чтение'),
    h('div', { class: 'list' }, items.map((a) => articleCard(a, { compact: true }))));
}

/** Обновляет счётчик, баннеры, темы и список, не трогая поле поиска (клавиатура не закрывается). */
function updateFeed() {
  if (!feedRefs || !view.contains(feedRefs.listEl)) { renderFeed(); return; }
  const { headInfo, bannerSlot, topicsSlot } = feedRefs;
  const updated = lastUpdate();
  const total = filtered().length;
  headInfo.textContent = `${total} ${plural(total, 'статья', 'статьи', 'статей')} · лента обновлена ${updated ? timeAgo(updated) : '—'}`;
  mount(bannerSlot, discoverBanner(), staleBanner());
  mount(feedRefs.continueSlot, continueBlock());
  const hasQueries = store.library().some((a) => a.query);
  if (hasQueries !== feedRefs.hasQueries) {
    feedRefs.hasQueries = hasQueries;
    mount(topicsSlot, topicChips());
  }
  renderList();
}

function renderFeed() {
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Поиск по статьям и тегам', value: ui.q, enterkeyhint: 'search' });
  search.addEventListener('input', () => {
    ui.q = search.value; // состояние — сразу, список — с задержкой
    ui.limit = 30;
    renderListSoon();
  });

  const seg = (value, label) => h('button', { class: ui.lang === value ? 'active' : '', onclick: () => { ui.lang = value; renderFeed(); } }, label);
  const filters = h('div', { class: 'filter-row' },
    h('div', { class: 'segmented' }, seg('all', 'Все'), seg('ru', 'RU'), seg('en', 'EN')),
    h('label', { class: 'toggle-label' },
      h('input', { type: 'checkbox', checked: ui.unread, onchange: (e) => { ui.unread = e.target.checked; renderFeed(); } }),
      'Непрочитанные'));

  const headInfo = h('div', { class: 'muted small' });
  const bannerSlot = h('div');
  const topicsSlot = h('div', {}, topicChips());
  const listEl = h('div', { class: 'list' });
  const continueSlot = h('div');
  feedRefs = { headInfo, bannerSlot, topicsSlot, listEl, continueSlot, hasQueries: store.library().some((a) => a.query) };

  mount(view,
    h('header', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Лента'), headInfo),
      h('div', { class: 'head-actions' },
        h('button', { class: 'icon-btn', 'aria-label': 'Спросить Claude', onclick: () => openChat(null) }, '✨'),
        h('button', { class: 'icon-btn', 'aria-label': 'Обновить ленту', onclick: openRefreshSheet }, '↻'))),
    bannerSlot,
    search,
    topicsSlot,
    filters,
    continueSlot,
    listEl,
  );
  updateFeed();
}

// ---------- Обновление ленты ----------
function openRefreshSheet() {
  const layer = openLayer({ kind: 'sheet', title: 'Обновить ленту', className: 'refresh' });
  const s = store.settings;
  const selected = new Set(pickStaleTopics(store.library(), 4));
  let count = s.discoverCount;
  let lang = s.discoverLang;
  const log = h('div', { class: 'log' });
  const result = h('div', {});

  const remoteBtn = h('button', { class: 'btn wide' }, 'Проверить общую ленту');
  remoteBtn.onclick = async () => {
    remoteBtn.disabled = true;
    const n = await refreshRemote();
    remoteBtn.disabled = false;
    toast(n < 0 ? 'Не удалось загрузить ленту (нет сети?)' : n ? `Новых статей: ${n}` : 'Новых статей в общей ленте нет');
    rerender();
  };

  const topicChips = h('div', { class: 'chips wrap' });
  const drawTopics = () => topicChips.replaceChildren(...TOPICS.map((t) => h('button', {
    class: 'chip' + (selected.has(t.id) ? ' active' : ''),
    onclick: () => { selected.has(t.id) ? selected.delete(t.id) : selected.add(t.id); drawTopics(); },
  }, `${t.emoji} ${t.short}`)));
  drawTopics();

  const countSel = h('select', { onchange: (e) => { count = +e.target.value; } }, [5, 8, 12, 16].map((n) => h('option', { value: n, selected: n === count }, `${n} статей`)));
  const langSel = h('select', { onchange: (e) => { lang = e.target.value; } },
    [['mix', 'RU + EN'], ['ru', 'Только RU'], ['en', 'Только EN']].map(([v, l]) => h('option', { value: v, selected: v === lang }, l)));

  const queryInput = h('input', { class: 'search', type: 'text', placeholder: 'Например: эффективность тренировок', enterkeyhint: 'search' });
  const runBtn = h('button', { class: 'btn wide accent' }, '✨ Найти свежие статьи');
  const queryBtn = h('button', { class: 'btn wide' }, '🔎 Найти по запросу');
  queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') queryBtn.click(); });

  async function start(opts) {
    if (!hasKey()) { toast('Сначала добавьте API-ключ Claude в настройках', { timeout: 4000 }); return; }
    if (isRunning()) { toast('Поиск уже идёт'); return; }
    log.replaceChildren();
    result.replaceChildren();
    runBtn.disabled = queryBtn.disabled = true;
    const add = (text) => { log.append(h('div', {}, text)); log.scrollTop = log.scrollHeight; };
    add(opts.query ? `Claude ищет статьи по запросу «${opts.query}»…` : 'Claude ищет свежие статьи…');
    try {
      const r = await runDiscovery({
        ...opts,
        onEvent: (ev) => {
          if (ev.type === 'search') add('🔎 ' + ev.query);
          else if (ev.type === 'fetch') add('📄 ' + ev.url);
          else if (ev.type === 'status') add(ev.text);
          else if (ev.type === 'note') add('💭 ' + ev.text);
        },
      });
      add(`Готово: добавлено ${r.added.length}${r.rejected.length ? `, отсеяно ${r.rejected.length}` : ''}. Примерная стоимость: $${r.cost.toFixed(2)}.`);
      result.replaceChildren(...r.added.map((a) => articleCard(a, { compact: true })));
      if (r.added.length) toast(`Добавлено ${r.added.length} ${plural(r.added.length, 'статья', 'статьи', 'статей')}`);
    } catch (err) {
      add('⚠️ ' + (err?.name === 'AbortError' || /abort/i.test(err?.message || '') ? 'Поиск остановлен.' : describeError(err)));
    } finally {
      runBtn.disabled = queryBtn.disabled = false;
    }
  }
  runBtn.onclick = () => {
    if (!selected.size) { toast('Выберите хотя бы одну тему'); return; }
    start({ topics: [...selected], count, lang });
  };
  queryBtn.onclick = () => {
    const query = queryInput.value.trim();
    if (!query) { queryInput.focus(); return; }
    start({ query, count: Math.min(count, 12), lang });
  };

  const fu = store.feedUpdatedAt();
  mount(layer.body,
    h('section', { class: 'group' },
      h('h3', {}, 'Общая лента'),
      h('p', { class: 'muted small' }, `Обновляется автоматически раз в сутки (GitHub Action). Последнее обновление: ${fu ? timeAgo(fu) : 'неизвестно'}.`
        + (fu && Date.now() - Date.parse(fu) > 2 * 864e5 ? ' Если общая лента давно не меняется, проверьте, что в репозитории добавлен секрет ANTHROPIC_API_KEY.' : '')),
      remoteBtn),
    h('section', { class: 'group' },
      h('h3', {}, 'Свежие статьи с Claude'),
      h('p', { class: 'muted small' }, 'Claude ищет в интернете новые материалы по выбранным темам' + (s.trustedOnly ? ' в проверенных изданиях' : '') + ' и добавляет их в ленту. Темы, по которым давно не было статей, выбраны заранее.'),
      topicChips,
      h('div', { class: 'row' }, countSel, langSel),
      runBtn),
    h('section', { class: 'group' },
      h('h3', {}, 'Статьи по запросу'),
      h('p', { class: 'muted small' }, 'Опишите тему своими словами — Claude найдёт статьи и добавит их в ленту (фильтр «🔎 Мои запросы»). То же можно попросить в чате ✨.'),
      queryInput,
      queryBtn),
    log,
    result);
}

// ---------- Случайное ----------
function pool() {
  const all = store.library();
  const unread = all.filter((a) => !store.isRead(a.id));
  return ui.unread && unread.length ? unread : all;
}

function pickOne() {
  const p = pool().filter((a) => a.id !== ui.randomOne?.id);
  ui.randomOne = p[Math.floor(Math.random() * p.length)] || null;
}

function pickMix() {
  const byTopic = new Map();
  for (const a of shuffle(pool())) if (!byTopic.has(a.topic)) byTopic.set(a.topic, a);
  ui.randomMix = shuffle([...byTopic.values()]).slice(0, 5);
}

function renderRandom() {
  if (!ui.randomOne) pickOne();
  if (!ui.randomMix) pickMix();
  const randomTopic = () => setFilter({ topic: TOPICS[Math.floor(Math.random() * TOPICS.length)].id });
  mount(view,
    h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Случайное'), h('div', { class: 'muted small' }, 'Неожиданные темы для расширения кругозора'))),
    h('label', { class: 'toggle-label pad' },
      h('input', { type: 'checkbox', checked: ui.unread, onchange: (e) => { ui.unread = e.target.checked; ui.randomOne = ui.randomMix = null; renderRandom(); } }),
      'Только непрочитанные'),
    h('section', { class: 'random-hero' },
      h('div', { class: 'hero-row' },
        h('h2', {}, '🎲 Мне повезёт'),
        h('button', { class: 'btn accent', onclick: () => { pickOne(); renderRandom(); } }, 'Другая')),
      ui.randomOne ? articleCard(ui.randomOne) : h('p', { class: 'muted' }, 'Статей пока нет.')),
    h('section', {},
      h('div', { class: 'hero-row' },
        h('h2', {}, '🧩 Подборка из разных тем'),
        h('button', { class: 'btn', onclick: () => { pickMix(); renderRandom(); } }, 'Перемешать')),
      h('div', { class: 'list' }, (ui.randomMix || []).map((a) => articleCard(a, { compact: true })))),
    h('section', { class: 'row wrap pad' },
      h('button', { class: 'btn', onclick: randomTopic }, '🎯 Случайная тема'),
      h('button', { class: 'btn accent', onclick: () => openChat(null, { prompt: 'Удиви меня: расскажи об одном малоизвестном, но достоверном и захватывающем факте из науки или истории, а потом предложи, что почитать по теме.' }) }, '✨ Удиви меня')),
  );
}

// ---------- Избранное ----------
let offlineRun = null; // идёт ли «Скачать всё»

/** Докачивает тексты избранных статей для чтения без сети (по одной, бережно к сервису). */
async function prefetchSaved({ onProgress } = {}) {
  if (offlineRun || !navigator.onLine) return offlineRun;
  offlineRun = (async () => {
    const todo = store.savedArticles().filter((a) => !isCached(a.id) && !isProtectedHost(a.url));
    let ok = 0;
    for (const [i, a] of todo.entries()) {
      onProgress?.(i, todo.length);
      if (await prefetchText(a)) ok++;
      if (i < todo.length - 1) await new Promise((r) => setTimeout(r, 2500));
    }
    return { ok, total: todo.length };
  })();
  try {
    return await offlineRun;
  } finally {
    offlineRun = null;
  }
}

function savedHeader(items) {
  if (!items.length) return null;
  const cached = items.filter((a) => isCached(a.id)).length;
  const missing = items.filter((a) => !isCached(a.id) && !isProtectedHost(a.url)).length;
  const status = h('span', { class: 'muted small' }, `📥 без сети доступно: ${cached} из ${items.length}`);
  const btn = missing && navigator.onLine
    ? h('button', { class: 'btn small', onclick: async () => {
      btn.disabled = true;
      await prefetchSaved({ onProgress: (i, n) => { btn.textContent = `Скачиваю ${i + 1} из ${n}…`; } });
      renderSaved();
    } }, offlineRun ? 'Скачиваю…' : `Скачать ещё ${missing}`)
    : null;
  return h('div', { class: 'saved-head' }, status, btn);
}

async function renderSaved() {
  const seg = (value, label) => h('button', { class: ui.savedSeg === value ? 'active' : '', onclick: () => { ui.savedSeg = value; renderSaved(); } }, label);
  const due = dueWords().length;
  const list = h('div', { class: 'list' });
  mount(view,
    h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Моё'))),
    h('div', { class: 'segmented wide' },
      seg('saved', 'Избранное'),
      seg('vocab', due ? `Словарь · ${due}` : 'Словарь'),
      seg('read', 'Прочитано'),
      seg('chats', 'Чаты')),
    list);
  if (ui.savedSeg === 'saved') {
    const items = store.savedArticles();
    mount(list, savedHeader(items), ...(items.length ? items.map((a) => articleCard(a)) : [h('div', { class: 'empty' }, 'Нажмите ☆ на карточке, чтобы сохранить статью. Текст избранных статей скачивается заранее — их можно читать без сети.')]));
  } else if (ui.savedSeg === 'vocab') {
    renderVocab(list);
  } else if (ui.savedSeg === 'read') {
    const items = store.readArticles();
    list.append(...(items.length ? items.map((a) => articleCard(a, { compact: true })) : [h('div', { class: 'empty' }, 'Здесь появятся дочитанные статьи.')]));
  } else {
    const chats = await listChats();
    if (!chats.length) list.append(h('div', { class: 'empty' }, 'Разговоров с Claude пока нет.'));
    for (const { key, conv } of chats) {
      // Статья могла выпасть из ленты — тогда берём её снимок, сохранённый в переписке.
      const article = conv.articleId ? store.getArticle(conv.articleId) || conv.article || null : null;
      list.append(h('button', { class: 'chat-row', onclick: () => openChat(article) },
        h('div', { class: 'mini-title' }, (article ? '📄 ' : '💬 ') + conv.title),
        h('div', { class: 'muted small' }, `${conv.messages.filter((m) => m.role === 'user' && !(Array.isArray(m.content) && m.content.every((b) => b.type === 'tool_result'))).length} вопр. · ${timeAgo(conv.updated)}`),
        h('span', { class: 'chat-del', role: 'button', 'aria-label': 'Удалить', onclick: async (e) => { e.stopPropagation(); if (confirm('Удалить разговор?')) { await kv.del(key); renderSaved(); } } }, '🗑')));
    }
  }
}

/** Точка с числом слов к повторению на вкладке «Моё». */
function updateTabBadge() {
  const btn = document.querySelector('.tabbar button[data-tab="saved"]');
  if (!btn) return;
  const n = dueWords().length;
  let badge = btn.querySelector('.tab-badge');
  if (!n) { badge?.remove(); return; }
  if (!badge) { badge = h('span', { class: 'tab-badge' }); btn.append(badge); }
  badge.textContent = n > 99 ? '99+' : String(n);
}

// ---------- Настройки ----------
function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
}
function toggleField(label, key, hint) {
  return h('label', { class: 'field toggle' },
    h('span', { class: 'field-label' }, label),
    h('input', { type: 'checkbox', class: 'switch', checked: store.settings[key], onchange: (e) => store.saveSettings({ [key]: e.target.checked }) }),
    hint ? h('span', { class: 'hint' }, hint) : null);
}
function modelSelect(key) {
  return h('select', { onchange: (e) => store.saveSettings({ [key]: e.target.value }) },
    MODELS.map((m) => h('option', { value: m.id, selected: store.settings[key] === m.id }, `${m.label} — ${m.note} ($${m.price[0]}/$${m.price[1]})`)));
}

function renderSettings() {
  const s = store.settings;
  const keyInput = h('input', { type: 'password', autocomplete: 'off', placeholder: 'sk-ant-…', value: s.apiKey, spellcheck: 'false' });
  keyInput.addEventListener('change', () => store.saveSettings({ apiKey: keyInput.value.trim() }));
  const keyStatus = h('span', { class: 'hint' }, s.apiKey ? 'Ключ сохранён на этом устройстве.' : 'Ключ нужен для чата, поиска статей и перевода через Claude.');
  const testBtn = h('button', { class: 'btn small', onclick: async () => {
    store.saveSettings({ apiKey: keyInput.value.trim() });
    keyStatus.textContent = 'Проверяю…';
    try {
      const ids = await testKey();
      keyStatus.textContent = `✅ Ключ работает. Доступно моделей: ${ids.length}.`;
    } catch (err) {
      keyStatus.textContent = '⚠️ ' + describeError(err);
    }
  } }, 'Проверить');

  const domains = h('textarea', { rows: 8, spellcheck: 'false' }, s.domains);
  domains.addEventListener('change', () => store.saveSettings({ domains: domains.value }));

  mount(view,
    h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Настройки'))),
    h('section', { class: 'group' },
      h('h3', {}, 'Claude API'),
      field('API-ключ', h('div', { class: 'row' }, keyInput, testBtn)),
      keyStatus,
      h('p', { class: 'hint' }, 'Ключ создаётся на platform.claude.com → API Keys. Он хранится только в памяти этого устройства и отправляется напрямую в api.anthropic.com. Советуем завести отдельный ключ с лимитом расходов.'),
      field('Модель для чата и поиска статей', modelSelect('model')),
      field('Модель для перевода в контексте', modelSelect('translateModel'), 'Для коротких переводов Haiku 5.5 примерно в 40 раз дешевле Opus.'),
      toggleField('Веб-поиск в чате', 'chatWebSearch', 'Claude сможет искать свежие сведения и открывать статьи по ссылке.')),
    h('section', { class: 'group' },
      h('h3', {}, 'Обновление ленты'),
      toggleField('Автопоиск свежих статей', 'autoDiscover', 'Раз в сутки при запуске Claude ищет новые статьи — только если общая лента давно не обновлялась.'),
      field('Статей за один поиск', h('select', { onchange: (e) => store.saveSettings({ discoverCount: +e.target.value }) },
        [5, 8, 12, 16].map((n) => h('option', { value: n, selected: s.discoverCount === n }, n)))),
      field('Язык статей', h('select', { onchange: (e) => store.saveSettings({ discoverLang: e.target.value }) },
        [['mix', 'Русские и английские'], ['ru', 'Только русские'], ['en', 'Только английские']].map(([v, l]) => h('option', { value: v, selected: s.discoverLang === v }, l)))),
      toggleField('Только проверенные издания', 'trustedOnly', 'Поиск свежих статей идёт только по списку ниже. Поиск по вашему запросу не ограничен списком, но критерии качества те же.'),
      h('details', {}, h('summary', {}, `Список изданий (${store.domainsList().length})`), domains, h('span', { class: 'hint' }, 'По одному домену в строке, до 64. Можно указать раздел: bbc.com/future.'))),
    h('section', { class: 'group' },
      h('h3', {}, 'Перевод'),
      toggleField('Перевод по тапу и выделению', 'tapTranslate'),
      field('Сервис перевода', h('select', { onchange: (e) => store.saveSettings({ translateEngine: e.target.value }) },
        [['google', 'Google Translate — быстро, со словарём'], ['mymemory', 'MyMemory — бесплатный API'], ['claude', 'Claude — с учётом контекста (платно)']]
          .map(([v, l]) => h('option', { value: v, selected: s.translateEngine === v }, l))),
      'Если сервис недоступен, приложение попробует другой. Кнопка «✨ В контексте» в карточке перевода всегда спрашивает Claude.')),
    h('section', { class: 'group' },
      h('h3', {}, 'Чтение'),
      field('Размер текста', h('select', { onchange: (e) => store.saveSettings({ fontSize: +e.target.value }) },
        [14, 16, 18, 20, 22, 24, 26].map((n) => h('option', { value: n, selected: s.fontSize === n }, n)))),
      h('details', {},
        h('summary', {}, 'Дополнительно'),
        field('Сервис извлечения текста', h('input', { type: 'url', value: s.readerProxy, onchange: (e) => store.saveSettings({ readerProxy: e.target.value.trim() || 'https://r.jina.ai/{url}' }) }), '{url} заменяется адресом статьи. По умолчанию Jina Reader.'),
        field('Ключ Jina Reader (необязательно)', h('input', { type: 'password', autocomplete: 'off', placeholder: 'jina_…', value: s.readerKey, spellcheck: 'false', onchange: (e) => store.saveSettings({ readerKey: e.target.value.trim() }) }), 'Без ключа Jina иногда ограничивает анонимные запросы. Бесплатный ключ — на jina.ai/reader.'),
        field('Адрес Claude API', h('input', { type: 'url', placeholder: 'https://api.anthropic.com', value: s.apiBase, onchange: (e) => store.saveSettings({ apiBase: e.target.value.trim() }) }), 'Оставьте пустым. Нужен, только если вы ходите в API через свой прокси.'))),
    backupSection(),
    h('section', { class: 'group' },
      h('h3', {}, 'Данные'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', onclick: async () => { await kv.clear('reader:'); forgetCached(); clearTranslationCache(); store.ls.del('protectedHosts'); toast('Кэш текстов и переводов очищен'); } }, 'Очистить кэш'),
        h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm('Удалить все данные приложения на этом устройстве, включая API-ключ, избранное и чаты?')) return;
          store.resetAll();
          await kv.clear('');
          location.reload();
        } }, 'Сбросить всё'))),
    h('p', { class: 'muted small center' }, 'Кругозор · статьи для расширения кругозора · Claude: ', modelInfo(s.model).label),
  );
}

function backupSection() {
  const includeKeys = h('input', { type: 'checkbox' });
  const status = h('p', { class: 'hint' }, 'Проверяю хранилище…');
  storageStatus().then(({ persisted, standalone }) => {
    status.textContent = persisted
      ? '✅ Данные хранятся постоянно. Резервная копия пригодится при переходе на другой телефон.'
      : standalone
        ? 'iOS может очистить данные при нехватке места — время от времени сохраняйте резервную копию.'
        : '⚠️ Сайт открыт во вкладке Safari: если не заходить 7 дней, Safari может стереть ключ, избранное и словарь. Установите приложение на экран «Домой» и сохраняйте резервную копию.';
  });
  const file = h('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try {
      const st = await importBackup(f);
      toast(`Восстановлено: избранное +${st.saved}, слов +${st.words}, чатов ${st.chats}, статей +${st.articles}. Перезапускаю…`, { timeout: 2500 });
      setTimeout(() => location.reload(), 1800);
    } catch (err) {
      toast('Не удалось восстановить: ' + (err.message || err), { timeout: 5000 });
    }
  });
  return h('section', { class: 'group' },
    h('h3', {}, 'Резервная копия'),
    status,
    h('label', { class: 'toggle-label' }, includeKeys, 'Включить в копию API-ключи'),
    h('p', { class: 'hint' }, 'В копию входят избранное, прочитанное, место в статьях, словарь, найденные статьи, чаты с Claude и настройки. Файл с ключами храните в надёжном месте.'),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn accent', onclick: async () => {
        const r = await exportBackup({ includeKeys: includeKeys.checked }).catch((err) => { toast('Не удалось сохранить копию: ' + err.message, { timeout: 4000 }); return null; });
        if (r === 'downloaded') toast('Файл копии сохранён в «Загрузки»', { timeout: 2500 });
      } }, '💾 Сохранить копию'),
      h('button', { class: 'btn', onclick: () => file.click() }, '📂 Восстановить из файла')),
    file);
}

// ---------- вкладки ----------
const RENDER = { feed: renderFeed, random: renderRandom, saved: renderSaved, settings: renderSettings };

function switchTab(tab) {
  ui.tab = tab;
  for (const btn of document.querySelectorAll('.tabbar button')) btn.classList.toggle('active', btn.dataset.tab === tab);
  RENDER[tab]();
}

function rerender() {
  if (ui.tab === 'settings') return; // не сбрасываем поля ввода
  if (ui.tab === 'feed') updateFeed();
  else RENDER[ui.tab]();
}

document.querySelector('.tabbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  if (btn.dataset.tab === ui.tab) { view.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  switchTab(btn.dataset.tab);
  view.scrollTop = 0;
});

store.on('library', debounce(rerender, 50));
store.on('saved', (id) => {
  // Избранное скачиваем заранее, чтобы читать без сети.
  if (store.isSaved(id) && navigator.onLine) prefetchText(store.getArticle(id));
  if (ui.tab === 'saved') renderSaved();
});
store.on('offline', debounce(() => { if (ui.tab === 'saved' && ui.savedSeg === 'saved') renderSaved(); }, 300));
store.on('vocab', () => {
  updateTabBadge();
  if (ui.tab === 'saved' && ui.savedSeg === 'vocab') renderSaved();
});
const refreshAfterReading = debounce(() => {
  if (ui.tab === 'feed') updateFeed();
  else if (ui.tab === 'saved') renderSaved();
}, 300);
store.on('read', refreshAfterReading);
store.on('reader-closed', refreshAfterReading);
store.on('discover-state', (st) => {
  if (!st.running) ui.discoverLog = [];
  if (ui.tab === 'feed') updateFeed();
});
store.on('discover-event', (ev) => {
  const text = ev.type === 'search' ? '🔎 ' + ev.query : ev.type === 'fetch' ? '📄 ' + ev.url : ev.type === 'status' ? ev.text : null;
  if (!text) return;
  ui.discoverLog.push(text);
  const line = document.querySelector('.banner.live .banner-text .muted');
  if (line) line.textContent = text;
});

// ---------- запуск ----------
function installHint() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (standalone || !isIOS || store.ls.get('hint.install', false)) return;
  toast('Чтобы установить: «Поделиться» → «На экран „Домой“»', { action: 'Понятно', onAction: () => store.ls.set('hint.install', true), timeout: 7000 });
}

async function boot() {
  store.init();
  // Просим не вытеснять данные (ключ, избранное, чаты) при нехватке места.
  navigator.storage?.persist?.().catch(() => {});
  await loadCachedIds().catch(() => {});
  switchTab('feed');
  updateTabBadge();
  const hadFeed = !!store.meta().fetchedAt;
  const n = await refreshRemote();
  if (n > 0 && hadFeed) toast(`В ленте ${n} ${plural(n, 'новая статья', 'новые статьи', 'новых статей')}`);
  installHint();
  const auto = await maybeAutoDiscover();
  if (auto?.added?.length) toast(`Claude нашёл ${auto.added.length} ${plural(auto.added.length, 'свежую статью', 'свежие статьи', 'свежих статей')}`);
  prefetchSaved(); // докачать избранное, если что-то не успело скачаться
}

// При возвращении в приложение (iOS держит PWA в фоне) — подтягиваем свежую ленту.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - (store.meta().fetchedAt || 0) > 30 * 60e3) await refreshRemote();
  maybeAutoDiscover();
});

if ('serviceWorker' in navigator) {
  const offerUpdate = (reg) => {
    if (!reg.waiting || !navigator.serviceWorker.controller) return;
    toast('Доступна новая версия приложения', {
      action: 'Обновить',
      timeout: 0,
      onAction: () => reg.waiting?.postMessage('skipWaiting'), // перезагрузка — по controllerchange
    });
  };
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    if (!reg) return;
    offerUpdate(reg); // новая версия могла скачаться в прошлый раз и ждать
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => { if (sw.state === 'installed') offerUpdate(reg); });
    });
    // iOS подолгу держит PWA в памяти — проверяем обновление при возвращении в приложение.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((err) => console.warn('Service worker:', err));
}

boot().catch((err) => {
  console.error(err);
  toast('Ошибка запуска: ' + err.message, { timeout: 0 });
});
