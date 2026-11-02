// Service worker: офлайн-работа оболочки приложения и ленты.
const VERSION = 'kz-v1';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/store.js',
  'js/db.js',
  'js/ui.js',
  'js/util.js',
  'js/topics.js',
  'js/markdown.js',
  'js/claude.js',
  'js/claude-core.js',
  'js/discover.js',
  'js/discover-core.js',
  'js/translate.js',
  'js/reader.js',
  'js/chat.js',
  'vendor/anthropic-sdk.js',
  'data/articles.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API Claude, перевод и тексты статей — всегда напрямую

  // Лента: сначала сеть (чтобы приходил свежак), при отсутствии сети — кэш.
  if (url.pathname.endsWith('/data/articles.json')) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) cache.put('data/articles.json', res.clone());
        return res;
      } catch {
        return (await cache.match('data/articles.json')) || Response.error();
      }
    })());
    return;
  }

  // Оболочка: из кэша, параллельно обновляем в фоне.
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('index.html') : undefined);
    const network = fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => undefined);
    return cached || (await network) || Response.error();
  })());
});
