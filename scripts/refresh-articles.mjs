#!/usr/bin/env node
// Ежедневное обновление общей ленты data/articles.json через Claude + веб-поиск.
// Запуск: ANTHROPIC_API_KEY=... node scripts/refresh-articles.mjs
// Переменные: CLAUDE_MODEL, ARTICLES_PER_RUN (10), TOPICS_PER_RUN (5), MAX_ARTICLES (600), DISCOVER_QUERY (необязательно).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { discoverArticles, pickStaleTopics } from '../js/discover-core.js';
import { TOPIC_IDS, TRUSTED_DOMAINS } from '../js/topics.js';
import { sanitizeArticle, normalizeUrl, todayISO } from '../js/util.js';
import { DEFAULT_MODEL, estimateCost, describeError } from '../js/claude-core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FEED = path.join(here, '..', 'data', 'articles.json');

const env = (name, fallback) => process.env[name]?.trim() || fallback;
const model = env('CLAUDE_MODEL', DEFAULT_MODEL);
const count = Number.parseInt(env('ARTICLES_PER_RUN', '10'), 10);
const topicsPerRun = Number.parseInt(env('TOPICS_PER_RUN', '5'), 10);
const maxArticles = Number.parseInt(env('MAX_ARTICLES', '600'), 10);
const query = env('DISCOVER_QUERY', '');

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('ANTHROPIC_API_KEY не задан — обновление пропущено.');
    return;
  }
  const feed = JSON.parse(await fs.readFile(FEED, 'utf8'));
  const existing = (feed.articles || []).map((a) => sanitizeArticle(a, TOPIC_IDS)).filter(Boolean);
  const topics = pickStaleTopics(existing, topicsPerRun);
  console.log(`Модель: ${model}. ${query ? `Запрос: «${query}»` : `Темы: ${topics.join(', ')}`}. Статей: ${count}.`);

  const client = new Anthropic();
  const result = await discoverArticles(client, {
    model,
    topics,
    count,
    query,
    exclude: existing.map((a) => a.url),
    trustedOnly: true,
    domains: TRUSTED_DOMAINS,
    today: todayISO(),
  }, (ev) => {
    if (ev.type === 'search') console.log('  поиск:', ev.query);
    else if (ev.type === 'fetch') console.log('  страница:', ev.url);
    else if (ev.type === 'status') console.log(' ', ev.text);
  });

  for (const r of result.rejected) console.log('  отсеяно:', r.reason, '—', r.raw?.url);
  const known = new Set(existing.map((a) => normalizeUrl(a.url)));
  const added = result.articles.filter((a) => !known.has(normalizeUrl(a.url)));
  let articles = [...added, ...existing];
  // Ограничиваем размер ленты: убираем самые давно добавленные статьи.
  if (articles.length > maxArticles) {
    articles = articles
      .map((a, i) => ({ a, i }))
      .sort((x, y) => (y.a.added || '').localeCompare(x.a.added || '') || x.i - y.i)
      .slice(0, maxArticles)
      .map((x) => x.a);
  }
  articles.sort((a, b) => ((b.published || b.added || '') + (b.added || '')).localeCompare((a.published || a.added || '') + (a.added || '')));

  await fs.writeFile(FEED, JSON.stringify({ updated_at: new Date().toISOString(), articles }, null, 2) + '\n');
  console.log(`Добавлено: ${added.length}. Всего в ленте: ${articles.length}. Поисковых запросов: ${result.searches}. Примерная стоимость: $${estimateCost(model, result.usage).toFixed(2)}.`);
  for (const a of added) console.log(`  + [${a.topic}] ${a.title} — ${a.source}`);
}

main().catch((err) => {
  console.error('Ошибка обновления ленты:', describeError(err));
  console.error(err);
  process.exit(1);
});
