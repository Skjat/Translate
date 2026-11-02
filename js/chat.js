// Окно разговора с Claude: углубиться в тему статьи или попросить подобрать статьи по запросу.
import { h, openLayer, toast, fmtDate } from './ui.js';
import { renderMarkdown } from './markdown.js';
import { kv } from './db.js';
import * as store from './store.js';
import { getClient, hasKey } from './claude.js';
import { buildRequest, streamWithRecovery, webTools, describeError, isAbortError, modelInfo } from './claude-core.js';
import { runDiscovery, isRunning, cancelDiscovery } from './discover.js';
import { getCachedText, openReader } from './reader.js';
import { attachTranslator } from './translate.js';
import { topicById } from './topics.js';

// Системный промпт неизменен для всех разговоров — это сохраняет кэш и цепочку рассуждений Claude.
const SYSTEM_PROMPT = `Ты — Claude в приложении «Кругозор». Пользователь читает статьи, чтобы расширить кругозор, и хочет глубже разобраться в теме.

Как отвечать:
- по-русски, ясно и живо, без воды; Markdown — умеренно (короткие абзацы, списки, где они помогают);
- объясняй термины и давай контекст: историю вопроса, ключевых людей и идеи, что известно надёжно, а что пока гипотеза, где идут споры;
- если вопрос про статью — опирайся на её текст; если текста нет, можешь открыть статью по ссылке через web_fetch;
- если нужны свежие или точные сведения, пользуйся веб-поиском и называй источники;
- когда уместно, подскажи, куда копнуть дальше.

Если пользователь просит подобрать, найти или добавить статьи (материалы, что почитать) на какую-то тему — например, «хочу больше статей про эффективность тренировок», — вызови инструмент find_articles: он найдёт качественные статьи и добавит их в ленту приложения. После этого коротко перечисли, что добавлено и чем каждая статья полезна.`;

const FIND_TOOL = {
  name: 'find_articles',
  description:
    'Найти в интернете качественные статьи по теме и добавить их в ленту приложения «Кругозор». Вызывай, когда пользователь просит подобрать, найти, добавить или прислать статьи, материалы или «что почитать» на какую-либо тему. Поиск занимает около минуты и возвращает список добавленных статей.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Тема поиска — конкретно и по-русски, например «как повысить эффективность силовых тренировок»' },
      count: { type: 'integer', description: 'Сколько статей найти: от 3 до 12, по умолчанию 6' },
      lang: { type: 'string', enum: ['mix', 'ru', 'en'], description: 'Язык статей: mix — русские и английские' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  eager_input_streaming: true,
};

const ARTICLE_PROMPTS = [
  'Кратко: о чём статья и что из неё главное?',
  'Объясни ключевые понятия простыми словами',
  'Какой контекст: история вопроса, что было до этого?',
  'Какие есть спорные моменты и другие точки зрения?',
  'Что почитать дальше по этой теме?',
  'Найди ещё статьи на эту тему',
  'Задай мне 3 вопроса на понимание',
];
const GENERAL_PROMPTS = [
  'Хочу больше статей про эффективность тренировок',
  'Подбери статьи о том, как устроена память',
  'Расскажи о самом интересном открытии последних недель',
  'Предложи тему, в которой мне стоит разобраться, и объясни почему',
];

const MAX_CONTEXT_CHARS = 60000;

function chatKey(article) {
  return 'chat:' + (article ? article.id : 'general');
}

function newConversation(article) {
  return { v: 1, articleId: article?.id || null, title: article ? article.title_ru || article.title : 'Свободный разговор', messages: [], ui: {}, updated: Date.now() };
}

/** Если приложение закрыли посреди вызова инструмента — закрываем его ошибкой, чтобы история оставалась корректной. */
function repair(conv) {
  const last = conv.messages[conv.messages.length - 1];
  if (last?.role === 'assistant' && Array.isArray(last.content)) {
    const calls = last.content.filter((b) => b.type === 'tool_use');
    if (calls.length) {
      conv.messages.push({
        role: 'user',
        content: calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, is_error: true, content: 'Выполнение прервано: приложение было закрыто.' })),
      });
    }
  }
  return conv;
}

async function contextBlock(article) {
  const t = topicById(article.topic);
  const lines = [
    'Контекст: я читаю эту статью в приложении «Кругозор».',
    `Название: ${article.title}`,
    article.title_ru && article.title_ru !== article.title ? `По-русски: ${article.title_ru}` : null,
    `Издание: ${article.source}`,
    `Ссылка: ${article.url}`,
    article.published ? `Дата публикации: ${article.published}` : null,
    `Тема: ${t.name}${article.tags?.length ? '; теги: ' + article.tags.join(', ') : ''}`,
    article.summary ? `Кратко: ${article.summary}` : null,
  ].filter(Boolean);
  let text = await getCachedText(article.id);
  if (text) {
    let note = '';
    if (text.length > MAX_CONTEXT_CHARS) {
      note = ` Ниже первые ${MAX_CONTEXT_CHARS} символов из ${text.length}; полный текст можно открыть по ссылке.`;
      text = text.slice(0, MAX_CONTEXT_CHARS);
    }
    lines.push('', `Текст статьи извлечён автоматически.${note}`, '<article>', text, '</article>');
  } else {
    lines.push('', 'Текста статьи у меня под рукой нет — при необходимости открой её по ссылке.');
  }
  return lines.join('\n');
}

// ---------- разбор истории для отображения ----------
function userText(msg) {
  if (typeof msg.content === 'string') return msg.content;
  const texts = msg.content.filter((b) => b.type === 'text');
  return texts.length ? texts[texts.length - 1].text : null;
}

/** Превращает историю API в «пузыри» для экрана. */
function toBubbles(messages) {
  const bubbles = [];
  let cur = null;
  messages.forEach((msg, idx) => {
    if (msg.role === 'user') {
      const onlyResults = Array.isArray(msg.content) && msg.content.every((b) => b.type === 'tool_result');
      if (onlyResults) return;
      const text = userText(msg);
      if (text == null) return;
      cur = null;
      const withContext = Array.isArray(msg.content) && msg.content.length > 1;
      bubbles.push({ role: 'user', text, withContext });
      return;
    }
    if (!cur) {
      cur = { role: 'assistant', parts: [], sources: new Map() };
      bubbles.push(cur);
    }
    const content = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content || [];
    for (const b of content) addPart(cur, b);
  });
  return bubbles;
}

function addPart(bubble, b) {
  const last = bubble.parts[bubble.parts.length - 1];
  if (b.type === 'text') {
    if (last?.kind === 'text') last.text += b.text;
    else bubble.parts.push({ kind: 'text', text: b.text });
    for (const c of b.citations || []) if (c?.url && !bubble.sources.has(c.url)) bubble.sources.set(c.url, c.title || c.url);
  } else if (b.type === 'server_tool_use') {
    const q = b.input?.query;
    const u = b.input?.url;
    if (q) bubble.parts.push({ kind: 'activity', icon: '🔎', text: q });
    else if (u) bubble.parts.push({ kind: 'activity', icon: '📄', text: u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60) });
  } else if (b.type === 'tool_use' && b.name === 'find_articles') {
    bubble.parts.push({ kind: 'find', id: b.id, query: b.input?.query || '' });
  } else if (b.type === 'thinking' && b.thinking?.trim()) {
    bubble.parts.push({ kind: 'note', text: b.thinking.trim() });
  }
}

// ---------- открытие окна ----------
export async function openChat(article = null, { prompt = '' } = {}) {
  const key = chatKey(article);
  let conv = repair((await kv.get(key)) || newConversation(article));
  let busy = false;
  let controller = null;
  let live = null; // { messages: [...finished this turn], snapshot }

  const resetBtn = h('button', { class: 'chip', onclick: async () => {
    if (busy) return;
    if (conv.messages.length && !confirm('Начать разговор заново? Текущая переписка удалится.')) return;
    conv = newConversation(article);
    await kv.del(key);
    render();
  } }, 'Новый');

  const layer = openLayer({
    kind: 'sheet',
    title: article ? '✨ ' + (article.title_ru || article.title) : '✨ Спросить Claude',
    className: 'chat',
    actions: [resetBtn],
    onClose: () => controller?.abort(),
  });

  const list = h('div', { class: 'chat-list' });
  const empty = h('div', { class: 'chat-empty' });
  const input = h('textarea', { class: 'chat-input', rows: 1, placeholder: article ? 'Спросите о статье или теме…' : 'Спросите о чём угодно или попросите статьи…', enterkeyhint: 'send' });
  const sendBtn = h('button', { class: 'send-btn', 'aria-label': 'Отправить' }, '↑');
  const footer = h('div', { class: 'chat-footer' },
    h('div', { class: 'chat-model muted' }, modelInfo(store.settings.model).label + (store.settings.chatWebSearch ? ' · веб-поиск' : '')),
    h('div', { class: 'chat-compose' }, input, sendBtn));
  layer.body.append(list, empty, footer);
  attachTranslator(list);

  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      submit();
    }
  });
  sendBtn.onclick = () => (busy ? stop() : submit());

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }

  function save() {
    conv.updated = Date.now();
    return kv.set(key, conv);
  }

  function submit(textArg) {
    const text = (textArg ?? input.value).trim();
    if (!text || busy) return;
    input.value = '';
    autosize();
    send(text);
  }

  function stop() {
    controller?.abort();
    cancelDiscovery();
  }

  async function send(text) {
    if (!hasKey()) {
      toast('Добавьте API-ключ Claude в настройках', { timeout: 4000 });
      return;
    }
    const content = [];
    if (article && conv.messages.length === 0) content.push({ type: 'text', text: await contextBlock(article) });
    content.push({ type: 'text', text });
    conv.messages.push({ role: 'user', content });
    await save();
    await runTurn();
  }

  function tools() {
    const list = [];
    if (store.settings.chatWebSearch) list.push(...webTools(store.settings.model, { search: { max_uses: 5 }, fetch: { max_uses: 3 } }));
    list.push(FIND_TOOL);
    return list;
  }

  async function runTurn() {
    busy = true;
    controller = new AbortController();
    live = { messages: [], snapshot: null, error: null };
    render();
    let client;
    try {
      client = getClient();
      for (let step = 0; step < 10; step++) {
        const base = { max_tokens: 16000, system: SYSTEM_PROMPT, tools: tools(), messages: conv.messages, cache_control: { type: 'ephemeral' } };
        const req = buildRequest(base, { model: store.settings.model, effort: 'medium', display: 'updates' });
        const { message, request } = await streamWithRecovery(client, req, (stream) => {
          stream.on('streamEvent', (_ev, snapshot) => {
            live.snapshot = snapshot;
            scheduleRender();
          });
        }, { signal: controller.signal });
        if (request.messages !== conv.messages) conv.messages = [...request.messages]; // история очищена от устаревших рассуждений
        live.snapshot = null;
        conv.messages.push({ role: 'assistant', content: message.content });
        await save();

        if (message.stop_reason === 'pause_turn') continue; // сервер продолжит поиск с того же места
        if (message.stop_reason === 'tool_use') {
          const calls = message.content.filter((b) => b.type === 'tool_use');
          const results = [];
          for (const call of calls) results.push(await runTool(call));
          conv.messages.push({ role: 'user', content: results });
          await save();
          render();
          if (controller.signal.aborted) break;
          continue;
        }
        if (message.stop_reason === 'refusal') toast('Claude отказался отвечать на этот запрос', { timeout: 4000 });
        if (message.stop_reason === 'max_tokens') toast('Ответ получился слишком длинным и обрезан', { timeout: 4000 });
        break;
      }
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) {
        const partial = (live.snapshot?.content || []).filter((b) => b.type === 'text' && b.text).map((b) => ({ type: 'text', text: b.text }));
        if (partial.length) {
          partial[partial.length - 1].text += ' …';
          conv.messages.push({ role: 'assistant', content: partial });
          await save();
        }
      } else {
        console.error(err);
        live.error = describeError(err);
      }
    } finally {
      busy = false;
      const error = live?.error;
      live = null;
      render(error);
    }
  }

  async function runTool(call) {
    const fail = (text) => ({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: text });
    if (call.name !== 'find_articles') return fail('Неизвестный инструмент.');
    const input = call.input || {};
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) return fail('INVALID_INPUT: нужен параметр query с темой поиска.');
    const count = Math.min(12, Math.max(3, Number.parseInt(input.count, 10) || 6));
    const lang = ['mix', 'ru', 'en'].includes(input.lang) ? input.lang : 'mix';
    if (isRunning()) return fail('Сейчас уже идёт другой поиск статей. Предложи пользователю повторить чуть позже.');

    const ui = (conv.ui[call.id] = { query, status: 'running', log: [] });
    render();
    try {
      const r = await runDiscovery({
        query, count, lang,
        onEvent: (ev) => {
          if (ev.type === 'search') ui.log.push('🔎 ' + ev.query);
          else if (ev.type === 'fetch') ui.log.push('📄 ' + ev.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 50));
          else if (ev.type === 'status') ui.log.push(ev.text);
          scheduleRender();
        },
      });
      conv.ui[call.id] = { query, status: 'done', articleIds: r.added.map((a) => a.id), cost: r.cost };
      await save();
      if (!r.added.length) return { type: 'tool_result', tool_use_id: call.id, content: 'Новых подходящих статей не нашлось: найденные уже есть в ленте или не прошли проверку качества.' };
      const listText = r.added.map((a, i) =>
        `${i + 1}. «${a.title}»${a.title_ru !== a.title ? ` (по-русски: «${a.title_ru}»)` : ''} — ${a.source}, ${a.lang.toUpperCase()}, тема «${topicById(a.topic).name}». ${a.summary} ${a.url}`).join('\n');
      return { type: 'tool_result', tool_use_id: call.id, content: `Добавлено в ленту статей: ${r.added.length}.\n${listText}` };
    } catch (err) {
      const aborted = isAbortError(err) || controller?.signal.aborted;
      conv.ui[call.id] = { query, status: 'error', error: aborted ? 'Поиск остановлен' : describeError(err) };
      await save();
      return fail(aborted ? 'Пользователь остановил поиск.' : 'Поиск не удался: ' + describeError(err));
    }
  }

  // ---------- отрисовка ----------
  let raf = 0;
  function scheduleRender() {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
  }

  function render(error = null) {
    const nearBottom = layer.body.scrollHeight - layer.body.scrollTop - layer.body.clientHeight < 120;
    const messages = live?.snapshot ? [...conv.messages, { role: 'assistant', content: live.snapshot.content || [] }] : conv.messages;
    const bubbles = toBubbles(messages);
    list.replaceChildren(...bubbles.map(renderBubble));

    if (busy && !live?.snapshot && !(bubbles[bubbles.length - 1]?.role === 'assistant' && Object.values(conv.ui).some((u) => u.status === 'running'))) {
      list.append(h('div', { class: 'bubble assistant typing' }, h('span'), h('span'), h('span')));
    } else if (busy && live?.snapshot && !(live.snapshot.content || []).some((b) => b.type === 'text' && b.text)) {
      list.append(h('div', { class: 'typing-inline muted' }, 'Claude думает…'));
    }
    const err = error || live?.error;
    if (err) {
      list.append(h('div', { class: 'bubble error' }, err, ' ',
        h('button', { class: 'chip', onclick: () => runTurn() }, 'Повторить')));
    }

    empty.replaceChildren();
    if (!conv.messages.length && !busy) {
      empty.append(
        h('p', { class: 'muted' }, article
          ? 'Спросите что угодно об этой статье или теме — Claude объяснит, добавит контекст и подскажет, что почитать дальше.'
          : 'Спросите о любой теме или попросите подобрать статьи — например: «хочу больше статей про эффективность тренировок». Найденные статьи сразу появятся в ленте.'),
        h('div', { class: 'prompt-chips' }, (article ? ARTICLE_PROMPTS : GENERAL_PROMPTS).map((p) => h('button', { class: 'chip', onclick: () => submit(p) }, p))));
      if (!hasKey()) empty.append(h('p', { class: 'warn' }, 'Чтобы общаться с Claude, добавьте API-ключ во вкладке «Настройки».'));
    }
    sendBtn.textContent = busy ? '■' : '↑';
    sendBtn.classList.toggle('stop', busy);
    sendBtn.setAttribute('aria-label', busy ? 'Остановить' : 'Отправить');
    if (nearBottom || busy) layer.body.scrollTop = layer.body.scrollHeight;
  }

  function renderBubble(b) {
    if (b.role === 'user') {
      return h('div', { class: 'bubble user' },
        b.withContext ? h('div', { class: 'ctx-chip' }, '📎 ', article ? article.source : 'статья') : null,
        b.text);
    }
    const el = h('div', { class: 'bubble assistant' });
    let activities = [];
    const flushActivities = () => {
      if (activities.length) el.append(h('div', { class: 'activity muted' }, activities.map((a) => h('span', { class: 'act' }, a.icon + ' ' + a.text))));
      activities = [];
    };
    for (const p of b.parts) {
      if (p.kind === 'activity') { activities.push(p); continue; }
      flushActivities();
      if (p.kind === 'text') el.append(h('div', { class: 'md', html: renderMarkdown(p.text) }));
      else if (p.kind === 'note') el.append(h('div', { class: 'note muted' }, p.text));
      else if (p.kind === 'find') el.append(renderFind(p));
    }
    flushActivities();
    if (b.sources.size) {
      el.append(h('details', { class: 'sources' },
        h('summary', {}, `Источники (${b.sources.size})`),
        h('ol', {}, [...b.sources].map(([url, title]) => h('li', {}, h('a', { href: url, target: '_blank', rel: 'noopener' }, title))))));
    }
    return el;
  }

  function renderFind(p) {
    const ui = conv.ui[p.id] || { status: busy ? 'running' : 'unknown', log: [] };
    const box = h('div', { class: 'find-box' }, h('div', { class: 'find-head' }, '📚 Поиск статей: ', h('b', {}, p.query || '…')));
    if (ui.status === 'running') {
      box.append(h('div', { class: 'find-status' }, h('span', { class: 'spinner' }), ' ', ui.log[ui.log.length - 1] || 'Начинаю поиск…'));
      if (ui.log.length > 1) box.append(h('div', { class: 'find-log muted' }, ui.log.slice(-4, -1).join(' · ')));
    } else if (ui.status === 'done') {
      const arts = (ui.articleIds || []).map((id) => store.getArticle(id)).filter(Boolean);
      box.append(h('div', { class: 'find-status' }, arts.length ? `Добавлено в ленту: ${arts.length}` : 'Новых статей не нашлось'));
      for (const a of arts) {
        const t = topicById(a.topic);
        box.append(h('button', { class: 'mini-card', onclick: () => openReader(a) },
          h('div', { class: 'mini-meta' }, `${t.emoji} ${t.short} · ${a.source} · ${a.lang.toUpperCase()}${a.published ? ' · ' + fmtDate(a.published) : ''}`),
          h('div', { class: 'mini-title' }, a.title_ru || a.title)));
      }
    } else if (ui.status === 'error') {
      box.append(h('div', { class: 'find-status error' }, ui.error));
    }
    return box;
  }

  render();
  if (prompt && !conv.messages.length) submit(prompt);
  else if (prompt) { input.value = prompt; autosize(); }
  return layer;
}

/** Список сохранённых разговоров для вкладки «Избранное». */
export async function listChats() {
  const keys = await kv.keys('chat:');
  const convs = await Promise.all(keys.map(async (k) => ({ key: k, conv: await kv.get(k) })));
  return convs.filter((c) => c.conv?.messages?.length).sort((a, b) => b.conv.updated - a.conv.updated);
}
