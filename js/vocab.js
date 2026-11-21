// Личный словарь: слова, на которые тапали, с переводом и предложением из статьи.
// Повторение — по системе Лейтнера: каждое «помню» отодвигает следующий показ.
import { ls, emit } from './store.js';

const KEY = 'vocab';
// Через сколько показать слово снова, в зависимости от «коробки» (0 — только что ошиблись).
const INTERVALS = [10 * 60e3, 864e5, 3 * 864e5, 7 * 864e5, 16 * 864e5, 35 * 864e5];

let items = load();

function load() {
  const list = ls.get(KEY, []);
  return Array.isArray(list) ? list.filter((w) => w && w.id && w.word) : [];
}

function save() {
  ls.set(KEY, items);
  emit('vocab');
}

const norm = (s) => String(s || '').trim().toLowerCase();

export const allWords = () => [...items].sort((a, b) => b.added - a.added);
export const findWord = (word) => items.find((w) => norm(w.word) === norm(word)) || null;
export const dueWords = (now = Date.now()) => items.filter((w) => (w.due ?? 0) <= now);

/** Добавляет слово (или обновляет перевод уже сохранённого). Возвращает запись. */
export function addWord({ word, translation, alts = [], note = '', context = '', article = null }) {
  const existing = findWord(word);
  if (existing) {
    Object.assign(existing, { translation, alts, note: note || existing.note, context: context || existing.context });
    save();
    return existing;
  }
  const entry = {
    id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    word: word.trim(),
    translation,
    alts: alts.slice(0, 4),
    note,
    context: context.slice(0, 400),
    articleId: article?.id || null,
    articleTitle: article ? article.title_ru || article.title : '',
    added: Date.now(),
    box: 0,
    due: Date.now(), // новое слово сразу попадает в повторение
    reviews: 0,
  };
  items.unshift(entry);
  save();
  return entry;
}

export function removeWord(id) {
  items = items.filter((w) => w.id !== id);
  save();
}

/** Оценка при повторении: «помню» — в следующую коробку, «не помню» — в первую. */
export function grade(id, remembered) {
  const w = items.find((x) => x.id === id);
  if (!w) return;
  w.box = remembered ? Math.min((w.box || 0) + 1, INTERVALS.length - 1) : 0;
  w.due = Date.now() + INTERVALS[w.box];
  w.reviews = (w.reviews || 0) + 1;
  save();
}

/** Для импорта резервной копии: объединяет словари, при совпадении слова оставляет более «выученное». */
export function mergeWords(list) {
  if (!Array.isArray(list)) return 0;
  let added = 0;
  for (const w of list) {
    if (!w?.word || !w?.translation) continue;
    const existing = findWord(w.word);
    if (!existing) {
      items.push({ ...w, id: w.id || 'w' + Math.random().toString(36).slice(2, 10) });
      added++;
    } else if ((w.box || 0) > (existing.box || 0)) {
      Object.assign(existing, w, { id: existing.id });
    }
  }
  save();
  return added;
}
