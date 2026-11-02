#!/usr/bin/env node
// Проверка ленты data/articles.json: формат, дубликаты, допустимые темы.
import fs from 'node:fs';
import { sanitizeArticle, normalizeUrl } from '../js/util.js';
import { TOPIC_IDS } from '../js/topics.js';

const feed = JSON.parse(fs.readFileSync(new URL('../data/articles.json', import.meta.url), 'utf8'));
let errors = 0;
if (!Array.isArray(feed.articles)) {
  console.error('articles должен быть массивом');
  process.exit(1);
}
const seen = new Set();
for (const [i, raw] of feed.articles.entries()) {
  const a = sanitizeArticle(raw, TOPIC_IDS);
  if (!a) { console.error(`#${i}: статья не прошла проверку`, raw?.url); errors++; continue; }
  const key = normalizeUrl(a.url);
  if (seen.has(key)) { console.error(`#${i}: дубликат`, a.url); errors++; }
  seen.add(key);
  if (!a.summary) { console.error(`#${i}: нет summary`, a.url); errors++; }
}
const byTopic = Object.fromEntries(TOPIC_IDS.map((t) => [t, 0]));
for (const a of feed.articles) byTopic[a.topic]++;
console.log(`Статей: ${feed.articles.length}; обновлено: ${feed.updated_at}`);
console.log(byTopic);
if (errors) {
  console.error(`Ошибок: ${errors}`);
  process.exit(1);
}
console.log('OK');
