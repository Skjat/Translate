// DOM-помощники, всплывающие уведомления, листы и форматирование.

/** h('div', {class: 'x', onclick: fn}, child1, 'text', ...) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  append(el, children);
  return el;
}

/** Заменяет содержимое элемента, пропуская null/false (в отличие от replaceChildren). */
export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const $ = (sel, root = document) => root.querySelector(sel);

// ---- уведомления ----
let toastTimer = null;
export function toast(text, { action, onAction, timeout = 3500 } = {}) {
  const host = document.getElementById('toast');
  host.replaceChildren(
    h('div', { class: 'toast-inner' },
      h('span', {}, text),
      action ? h('button', { class: 'toast-action', onclick: () => { hide(); onAction?.(); } }, action) : null),
  );
  host.classList.add('show');
  clearTimeout(toastTimer);
  const hide = () => host.classList.remove('show');
  if (timeout) toastTimer = setTimeout(hide, timeout);
  return hide;
}

// ---- листы и страницы поверх основного экрана ----
const stack = [];

/**
 * Открывает слой. kind: 'page' (полноэкранная страница) или 'sheet' (лист снизу).
 * Возвращает { el, body, close }.
 */
export function openLayer({ kind = 'sheet', title = '', className = '', actions = [], onClose } = {}) {
  const layer = document.getElementById('layer');
  const closeBtn = h('button', { class: 'icon-btn' + (kind === 'page' ? ' back' : ''), 'aria-label': kind === 'page' ? 'Назад' : 'Закрыть', onclick: () => close() }, kind === 'page' ? '‹' : '✕');
  const titleEl = h('div', { class: 'layer-title' }, title);
  const actionsEl = h('div', { class: 'layer-actions' }, actions);
  const head = kind === 'page'
    ? h('div', { class: 'layer-head' }, closeBtn, titleEl, actionsEl)
    : h('div', { class: 'layer-head' }, h('span', { class: 'grabber' }), titleEl, actionsEl, closeBtn);
  const body = h('div', { class: 'layer-body' });
  const panel = h('div', { class: `layer-panel ${kind} ${className}`, role: 'dialog', 'aria-label': title }, head, body);
  const backdrop = kind === 'sheet' ? h('div', { class: 'backdrop', onclick: () => close() }) : null;
  const wrap = h('div', { class: `layer ${kind}` }, backdrop, panel);
  layer.append(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  document.body.classList.add('has-layer');

  let closed = false;
  const entry = { close: () => close(true) };
  stack.push(entry);
  history.pushState({ layer: stack.length }, '');

  function close(fromHistory = false) {
    if (closed) return;
    closed = true;
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    // Закрытие кнопкой: убираем свою запись истории, но popstate от этого back()
    // не должен закрыть слой под нами.
    if (!fromHistory) {
      ignorePops++;
      history.back();
    }
    wrap.classList.remove('open');
    wrap.classList.add('closing');
    setTimeout(() => wrap.remove(), 280);
    if (!stack.length) document.body.classList.remove('has-layer');
    onClose?.();
  }
  return { el: panel, head, body, titleEl, actionsEl, close: () => close(false) };
}

let ignorePops = 0;
window.addEventListener('popstate', () => {
  if (ignorePops > 0) {
    ignorePops--;
    return;
  }
  const top = stack[stack.length - 1];
  if (top) top.close();
});

export function closeAllLayers() {
  while (stack.length) stack[stack.length - 1].close();
}

// ---- форматирование ----
const MONTHS = ['янв.', 'февр.', 'марта', 'апр.', 'мая', 'июня', 'июля', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ' ' + d.getFullYear()}`;
}

export function timeAgo(ts) {
  if (!ts) return 'никогда';
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return 'только что';
  if (diff < 3600) return `${Math.round(diff / 60)} мин назад`;
  if (diff < 86400) return `${Math.round(diff / 3600)} ч назад`;
  const days = Math.round(diff / 86400);
  return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
}

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
