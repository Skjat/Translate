// Поиск свежих статей через Claude + веб-поиск. Общий код для браузера и Node-скрипта.
import { TOPICS, TOPIC_IDS, TRUSTED_DOMAINS, topicById } from './topics.js';
import { normalizeUrl, sanitizeArticle, todayISO } from './util.js';
import { buildRequest, streamWithRecovery, webTools, addUsage, isAbortError } from './claude-core.js';

const SYSTEM_PROMPT = `Ты — редактор-куратор «Кругозора», приложения, которое подбирает статьи для расширения кругозора. Ты ищешь в интернете качественные материалы и оформляешь их в ленту.

Что подходит:
- серьёзные издания и научно-популярные ресурсы на русском и английском: Quanta Magazine, Aeon, Psyche, Nautilus, Smithsonian Magazine, BBC Future, Ars Technica, The Atlantic, Knowable Magazine, Noema, Undark, Atlas Obscura, JSTOR Daily, N+1, Naked Science, ПостНаука, Arzamas, «Кот Шрёдингера», «Элементы», «Наука и жизнь», «Троицкий вариант», «Горький», «Нож» и подобные;
- журналистика, эссе, лонгриды и объясняющие материалы, после которых читатель узнаёт что-то новое о мире.

Что не подходит: кликбейт; пресс-релизы (EurekAlert, новости пресс-служб университетов и компаний); реклама, партнёрские и спонсорские материалы; списки «10 фактов»; обзоры гаджетов; короткие новостные заметки без контекста; статьи за жёстким пейволлом (FT, WSJ, NYT, The Economist, Bloomberg и т. п.); главные страницы, рубрики, теги, подкасты и видео.

Правила:
1. URL бери только из результатов веб-поиска, дословно. Никогда не придумывай и не собирай ссылки сам.
2. Не предлагай статьи из списка исключений и не дублируй одну статью дважды.
3. Разнообразь источники: не больше двух статей одного издания за одну подборку.
4. Если сомневаешься в дате, платном доступе или качестве — открой страницу через web_fetch или выбери другую статью.
5. summary — 2–3 предложения по-русски: о чём статья и почему её стоит прочитать. Спокойно и по делу, без восклицаний и рекламных интонаций.
6. tags — 2–4 конкретных тега по-русски в нижнем регистре (например, «тёмная материя», «древний египет»), не повторяющих название темы.
7. title_ru — перевод заголовка на русский; для русских статей — тот же заголовок.
8. published — дата публикации в формате YYYY-MM-DD, если её видно; иначе null.
9. kind — "fresh" для свежих материалов, "longread" для более старых, но выдающихся лонгридов.

Когда подборка готова, вызови инструмент submit_articles один раз со всеми статьями. Если подходящих статей меньше, чем просили, отправь столько, сколько нашлось: качество важнее количества.`;

const ARTICLE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Заголовок как в оригинале' },
    title_ru: { type: 'string', description: 'Заголовок по-русски' },
    url: { type: 'string', description: 'Ссылка на статью дословно из результатов поиска' },
    source: { type: 'string', description: 'Название издания' },
    lang: { type: 'string', enum: ['ru', 'en'] },
    topic: { type: 'string', enum: TOPIC_IDS },
    tags: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string', description: '2–3 предложения по-русски' },
    published: { type: ['string', 'null'], description: 'YYYY-MM-DD или null' },
    reading_minutes: { type: 'integer', description: 'Оценка времени чтения в минутах' },
    kind: { type: 'string', enum: ['fresh', 'longread'] },
  },
  required: ['title', 'title_ru', 'url', 'source', 'lang', 'topic', 'tags', 'summary', 'published', 'reading_minutes', 'kind'],
  additionalProperties: false,
};

export const SUBMIT_TOOL = {
  name: 'submit_articles',
  description:
    'Отправить готовую подборку статей в ленту. Вызывай один раз, в самом конце, когда все статьи найдены и проверены. Каждая статья — реальная страница из результатов веб-поиска.',
  input_schema: {
    type: 'object',
    properties: { articles: { type: 'array', items: ARTICLE_SCHEMA } },
    required: ['articles'],
    additionalProperties: false,
  },
  eager_input_streaming: true,
};

/** Выбирает темы, по которым давно не было свежих статей. */
export function pickStaleTopics(articles, n = 4, rand = Math.random) {
  const latest = Object.fromEntries(TOPIC_IDS.map((id) => [id, '']));
  for (const a of articles) {
    const d = a.added || a.published || '';
    if (latest[a.topic] !== undefined && d > latest[a.topic]) latest[a.topic] = d;
  }
  return [...TOPIC_IDS]
    .map((id) => ({ id, d: latest[id], r: rand() }))
    .sort((a, b) => (a.d === b.d ? a.r - b.r : a.d < b.d ? -1 : 1))
    .slice(0, n)
    .map((x) => x.id);
}

function userPrompt({ topics, count, lang, exclude, today, query }) {
  const cutoff = new Date(Date.parse(today) - 21 * 864e5).toISOString().slice(0, 10);
  const langLine =
    lang === 'ru' ? 'Только статьи на русском языке.'
      : lang === 'en' ? 'Только статьи на английском языке.'
        : 'Примерно поровну статей на русском и английском.';
  const parts = [];
  if (query) {
    const allTopics = TOPICS.map((t) => `- ${t.id} — ${t.name} (${t.hint})`).join('\n');
    parts.push(
      `Сегодня ${today}. Пользователь просит подобрать статьи по запросу: «${query}».`,
      `Найди до ${count} качественных статей, которые действительно раскрывают эту тему: научно-популярные разборы, обзоры исследований, лонгриды и эссе специалистов. Свежесть желательна, но важнее качество и точное попадание в запрос.`,
      `Для каждой статьи выбери в поле topic самую подходящую тему из списка, а в tags добавь теги, отражающие запрос:\n${allTopics}`,
      langLine,
    );
  } else {
    const topicLines = topics.map((id) => {
      const t = topicById(id);
      return `- ${t.id} — ${t.name} (${t.hint})`;
    });
    parts.push(
      `Сегодня ${today}. Найди ${count} новых статей для ленты.`,
      `Темы (распредели статьи между ними примерно поровну):\n${topicLines.join('\n')}`,
      langLine,
      `Свежесть: в первую очередь материалы, опубликованные после ${cutoff}. Не больше ${Math.max(1, Math.round(count / 4))} более старых лонгридов, и только если они действительно выдающиеся.`,
    );
  }
  if (exclude.length) parts.push(`Эти статьи уже есть в ленте — не предлагай их:\n${exclude.map((u) => '- ' + u).join('\n')}`);
  return parts.join('\n\n');
}

const URL_RE = /https?:\/\/[^\s"'<>\\)\]]+/g;

/** Собирает все URL, которые реально встречались в результатах поиска/загрузки страниц. */
function collectSeenUrls(content, seen) {
  for (const block of content) {
    if (typeof block?.type !== 'string') continue;
    if (block.type.endsWith('_tool_result')) {
      for (const m of JSON.stringify(block).matchAll(URL_RE)) seen.add(normalizeUrl(m[0]));
    } else if (block.type === 'text' && Array.isArray(block.citations)) {
      for (const c of block.citations) if (c?.url) seen.add(normalizeUrl(c.url));
    }
  }
}

/**
 * Запускает подборку. onEvent получает {type: 'search'|'fetch'|'note'|'status'|'results', ...}.
 * Возвращает { articles, rejected, usage, searches }.
 */
export async function discoverArticles(client, opts, onEvent = () => {}) {
  const {
    model,
    topics = TOPIC_IDS,
    count = 8,
    lang = 'mix',
    exclude = [],
    trustedOnly = true,
    domains = TRUSTED_DOMAINS,
    today = todayISO(),
    effort = 'medium',
    query = '',
    signal,
  } = opts;

  const search = { max_uses: Math.min(30, count * 2 + 6) };
  // По запросу пользователя ищем шире (тема может выходить за рамки списка изданий), критерии качества те же.
  if (trustedOnly && !query && domains.length) search.allowed_domains = [...new Set(domains)].slice(0, 64);
  const tools = [...webTools(model, { search, fetch: { max_uses: 8 } }), SUBMIT_TOOL];

  let messages = [{ role: 'user', content: userPrompt({ topics, count, lang, exclude: exclude.slice(0, 150), today, query: query.trim().slice(0, 300) }) }];
  const seen = new Set();
  const usage = {};
  let searches = 0;
  let submitted = null;
  let nudged = false;
  let parseRetries = 0;

  const attach = (stream) => {
    stream.on('streamEvent', (ev) => {
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && ev.content_block.name === 'submit_articles') {
        onEvent({ type: 'status', text: 'Оформляю подборку…' });
      }
    });
    stream.on('contentBlock', (block) => {
      if (block.type === 'server_tool_use') {
        const input = block.input || {};
        if (block.name === 'web_search' || input.query) {
          searches++;
          onEvent({ type: 'search', query: input.query || '' });
        } else if (block.name === 'web_fetch' || input.url) {
          onEvent({ type: 'fetch', url: input.url || '' });
        } else {
          onEvent({ type: 'status', text: 'Отбираю результаты…' });
        }
      } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        onEvent({ type: 'results', n: block.content.length });
      } else if (block.type === 'thinking' && block.thinking?.trim()) {
        onEvent({ type: 'note', text: block.thinking.trim() });
      }
    });
  };

  for (let turn = 0; turn < 8 && !submitted; turn++) {
    const req = buildRequest({ max_tokens: 32000, system: SYSTEM_PROMPT, tools, messages }, { model, effort, display: 'updates' });
    let message;
    try {
      ({ message } = await streamWithRecovery(client, req, attach, { signal }));
    } catch (err) {
      // С eager_input_streaming SDK может не разобрать JSON ввода инструмента — повторяем ход (не более 2 раз).
      if (!err?.status && !isAbortError(err) && !signal?.aborted && parseRetries < 2 && /JSON|parse/i.test(err?.message || '')) {
        parseRetries++;
        onEvent({ type: 'status', text: 'Повторяю оформление подборки…' });
        continue;
      }
      throw err;
    }
    addUsage(usage, message.usage);
    collectSeenUrls(message.content, seen);

    const call = message.content.find((b) => b.type === 'tool_use' && b.name === 'submit_articles');
    if (call && message.stop_reason !== 'max_tokens') {
      submitted = Array.isArray(call.input?.articles) ? call.input.articles : [];
      break;
    }
    if (message.stop_reason === 'refusal') throw new Error('Claude отказался выполнять этот запрос.');
    if (message.stop_reason === 'pause_turn') {
      // Сервер приостановил длинный цикл поиска — продолжаем с того же места.
      messages = [...messages, { role: 'assistant', content: message.content }];
      continue;
    }
    if (nudged) break;
    nudged = true;
    messages = [
      ...messages,
      { role: 'assistant', content: message.content.filter((b) => b.type !== 'tool_use') },
      { role: 'user', content: 'Пожалуйста, вызови submit_articles со всеми подходящими статьями, которые ты нашёл.' },
    ];
  }

  if (!submitted) throw new Error('Claude не вернул подборку. Попробуйте ещё раз.');

  const excludeSet = new Set(exclude.map(normalizeUrl));
  const articles = [];
  const rejected = [];
  const ids = new Set();
  for (const raw of submitted) {
    const a = sanitizeArticle(raw, TOPIC_IDS);
    if (!a) { rejected.push({ raw, reason: 'неполные данные' }); continue; }
    const key = normalizeUrl(a.url);
    // Защита от выдуманных ссылок: URL должен был встретиться в результатах поиска.
    if (seen.size && !seen.has(key)) { rejected.push({ raw, reason: 'ссылки нет в результатах поиска' }); continue; }
    if (excludeSet.has(key) || ids.has(a.id)) { rejected.push({ raw, reason: 'повтор' }); continue; }
    ids.add(a.id);
    a.added = today;
    if (query) a.query = query.trim().slice(0, 120);
    articles.push(a);
  }
  return { articles, rejected, usage, searches };
}

export { SYSTEM_PROMPT as DISCOVERY_SYSTEM_PROMPT, TOPICS };
