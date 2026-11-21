// Раздел «Словарь» и повторение слов карточками.
import { h, mount, openLayer, toast, shuffle, plural } from './ui.js';
import * as store from './store.js';
import { allWords, dueWords, removeWord, grade } from './vocab.js';
import { openReader } from './reader.js';

function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.9;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { /* озвучка недоступна */ }
}

/** Предложение с выделенным словом — безопасно, без innerHTML. */
function contextWithMark(context, word) {
  const el = h('div', { class: 'vocab-ctx' });
  if (!context) return el;
  const i = context.toLowerCase().indexOf(word.toLowerCase());
  if (i < 0) {
    el.append(context);
    return el;
  }
  el.append(context.slice(0, i), h('mark', {}, context.slice(i, i + word.length)), context.slice(i + word.length));
  return el;
}

function sourceLink(w) {
  if (!w.articleTitle) return null;
  const article = w.articleId ? store.getArticle(w.articleId) : null;
  return article
    ? h('button', { class: 'vocab-src', onclick: () => openReader(article) }, '📄 ' + w.articleTitle)
    : h('div', { class: 'vocab-src muted' }, '📄 ' + w.articleTitle);
}

/** Рисует словарь в контейнер (вкладка «Моё» → «Словарь»). */
export function renderVocab(container) {
  const words = allWords();
  const due = dueWords();
  const head = h('div', { class: 'vocab-head' },
    h('div', {},
      h('b', {}, `${words.length} ${plural(words.length, 'слово', 'слова', 'слов')}`),
      h('div', { class: 'muted small' }, due.length ? `к повторению: ${due.length}` : words.length ? 'на сегодня всё повторено' : '')),
    words.length
      ? h('button', { class: 'btn accent', onclick: () => openReview(due.length ? due : words) }, due.length ? `🧠 Повторить (${due.length})` : '🧠 Повторить всё')
      : null);

  if (!words.length) {
    mount(container, h('div', { class: 'empty' },
      h('p', {}, 'Здесь будут слова, которые вы сохраните при чтении.'),
      h('p', { class: 'muted small' }, 'Коснитесь английского слова в статье и нажмите «★ В словарь» — слово сохранится вместе с предложением, в котором встретилось.')));
    return;
  }
  mount(container, head, ...words.map((w) => h('div', { class: 'vocab-item' },
    h('div', { class: 'vocab-row' },
      h('div', { class: 'vocab-word' }, w.word),
      h('button', { class: 'icon-btn small', 'aria-label': 'Произнести', onclick: () => speak(w.word) }, '🔊'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'vocab-box', title: 'Насколько хорошо выучено' }, '●'.repeat(w.box || 0) + '○'.repeat(5 - (w.box || 0))),
      h('button', { class: 'icon-btn small', 'aria-label': 'Удалить', onclick: () => { removeWord(w.id); renderVocab(container); } }, '✕')),
    h('div', { class: 'vocab-tr' }, w.translation, w.alts?.length ? h('span', { class: 'muted' }, ' · ' + w.alts.join(', ')) : null),
    w.note ? h('div', { class: 'vocab-note muted small' }, w.note) : null,
    contextWithMark(w.context, w.word),
    sourceLink(w))));
}

/** Повторение карточками: слово → «Показать перевод» → «Помню» / «Не помню». */
export function openReview(words) {
  const queue = shuffle(words).slice(0, 20);
  const total = queue.length;
  let done = 0;
  let remembered = 0;
  let forgotten = 0;
  const retried = new Set();
  const layer = openLayer({ kind: 'sheet', title: '🧠 Повторение слов', className: 'review', onClose: () => store.emit('vocab') });

  function next() {
    const w = queue.shift();
    if (!w) return finish();
    let revealed = false;
    const card = h('div', { class: 'review-card' });
    const draw = () => mount(card,
      h('div', { class: 'review-progress muted small' }, `${Math.min(done + 1, total)} из ${total}`),
      h('div', { class: 'review-word' }, w.word, ' ', h('button', { class: 'icon-btn small', 'aria-label': 'Произнести', onclick: () => speak(w.word) }, '🔊')),
      contextWithMark(w.context, w.word),
      revealed
        ? h('div', { class: 'review-answer' },
          h('div', { class: 'review-tr' }, w.translation),
          w.alts?.length ? h('div', { class: 'muted' }, w.alts.join(', ')) : null,
          w.note ? h('div', { class: 'vocab-note muted small' }, w.note) : null,
          h('div', { class: 'row review-buttons' },
            h('button', { class: 'btn', onclick: () => answer(false) }, 'Не помню'),
            h('button', { class: 'btn accent', onclick: () => answer(true) }, 'Помню')))
        : h('button', { class: 'btn wide accent', onclick: () => { revealed = true; draw(); } }, 'Показать перевод'),
      sourceLink(w));
    function answer(ok) {
      grade(w.id, ok);
      if (ok) {
        if (!retried.has(w.id)) remembered++;
        done++;
      } else if (!retried.has(w.id)) {
        forgotten++;
        retried.add(w.id);
        queue.push(w); // ещё раз в конце этого же повторения
      } else {
        done++;
      }
      next();
    }
    draw();
    mount(layer.body, card);
  }

  function finish() {
    mount(layer.body, h('div', { class: 'review-card center' },
      h('div', { class: 'review-word' }, '🎉'),
      h('p', {}, `Повторено слов: ${total}. Сразу вспомнили: ${remembered} из ${total}.${forgotten ? ` Слова, которые не вспомнились (${forgotten}), покажу снова через 10 минут.` : ''}`),
      h('p', { class: 'muted small' }, 'Слова, которые вы помните, будут появляться всё реже: через день, три, неделю, две и месяц.'),
      h('button', { class: 'btn wide accent', onclick: () => layer.close() }, 'Готово')));
    if (total) toast('Повторение завершено', { timeout: 1500 });
  }

  next();
  return layer;
}
