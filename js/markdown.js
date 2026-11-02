// Небольшой безопасный рендерер Markdown → HTML (для текста статей и ответов Claude).
// Весь текст экранируется; разрешены только ссылки http(s).
import { esc } from './ui.js';

function safeUrl(url, base) {
  try {
    const u = new URL(url.trim().replace(/^<|>$/g, ''), base || undefined);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function inline(text, base) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  const tokens = [];
  const keep = (html) => {
    tokens.push(html);
    return `\u0001${tokens.length - 1}\u0001`;
  };
  // Картинки и ссылки — до экранирования, чтобы корректно разобрать скобки.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, url) => {
    const href = safeUrl(url, base);
    return href ? keep(`<img src="${esc(href)}" alt="${esc(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`) : '';
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, label, url) => {
    const href = safeUrl(url, base);
    const inner = inline(label, base);
    return href ? keep(`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`) : keep(inner);
  });
  s = esc(s);
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // Голые ссылки
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)'"»])/g, (m, pre, url) => {
    const href = safeUrl(url.replace(/&amp;/g, '&'), base);
    return href ? `${pre}<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${url}</a>` : m;
  });
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => tokens[+i]);
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
  return s;
}

export function renderMarkdown(md, { base } = {}) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { type: 'ul'|'ol', items: [] }
  let quote = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '), base)}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i, base)}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${renderMarkdown(quote.join('\n'), { base })}</blockquote>`);
    quote = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      flushAll();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!trimmed) { flushAll(); continue; }
    if (/^>/.test(trimmed)) { flushPara(); flushList(); quote.push(trimmed.replace(/^>\s?/, '')); continue; }
    flushQuote();

    let m;
    if ((m = trimmed.match(/^(#{1,6})\s+(.*?)\s*#*$/))) {
      flushAll();
      const level = Math.min(6, Math.max(2, m[1].length + 1));
      out.push(`<h${level}>${inline(m[2], base)}</h${level}>`);
      continue;
    }
    // Заголовки в стиле Setext (Текст\n=====)
    if (i + 1 < lines.length && /^(=+|-+)\s*$/.test(lines[i + 1].trim()) && !list && para.length === 0 && trimmed.length < 200) {
      flushAll();
      const level = lines[i + 1].trim()[0] === '=' ? 2 : 3;
      out.push(`<h${level}>${inline(trimmed, base)}</h${level}>`);
      i++;
      continue;
    }
    if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(trimmed)) { flushAll(); out.push('<hr>'); continue; }
    if (/^\|.*\|$/.test(trimmed)) {
      flushAll();
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) rows.push(lines[i++].trim());
      i--;
      const cells = (r) => r.slice(1, -1).split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\|[\s:|-]+\|$/.test(r));
      out.push(`<div class="table-wrap"><table>${body.map((r, idx) => `<tr>${cells(r).map((c) => (idx === 0 ? `<th>${inline(c, base)}</th>` : `<td>${inline(c, base)}</td>`)).join('')}</tr>`).join('')}</table></div>`);
      continue;
    }
    if ((m = line.match(/^\s*([-*+•])\s+(.*)$/)) || (m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) {
      flushPara();
      const type = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push(m[2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ' ' + trimmed; continue; }
    flushList();
    para.push(trimmed);
  }
  flushAll();
  return out.join('\n');
}
