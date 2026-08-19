/*
 * sw.js — offline shell, the update channel, and the calendar hand-off.
 *
 * Bump VERSION on every deploy: a new version installs alongside the old one,
 * tells the page a build is waiting, and only takes over when the user taps
 * Update (or every tab has closed).
 *
 * The hand-off matters on iOS: a saved .ics only ever opens in a Files
 * preview, but a URL answered with `Content-Type: text/calendar` is handed
 * to Calendar. The page stages the file in OUTBOX and opens its URL; the
 * fetch handler below answers with it.
 */

const VERSION = '1.2.0';
const CACHE = `batch-calendar-${VERSION}`;
const OUTBOX = 'batch-calendar-outbox';

const SHELL = [
  './',
  './index.html',
  './assets/styles.css',
  './assets/app.js',
  './assets/parser.js',
  './assets/ics.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name !== CACHE && name !== OUTBOX)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') event.ports[0]?.postMessage({ version: VERSION });
});

/*
 * Cache first, then refresh in the background. The page is served fast from
 * the cache while the next visit gets whatever changed.
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    // The calendar file the page staged for this tap, served as text/calendar.
    if (new URL(request.url).pathname.endsWith('.ics')) {
      const staged = await (await caches.open(OUTBOX)).match(request, { ignoreSearch: true });
      if (staged) return staged;
    }

    const cache = await caches.open(CACHE);
    const cached = await cache.match(request, { ignoreSearch: true });

    const network = fetch(request).then((response) => {
      if (response.ok && response.type === 'basic') cache.put(request, response.clone());
      return response;
    }).catch(() => null);

    if (cached) return cached;
    const fresh = await network;
    if (fresh) return fresh;
    if (request.mode === 'navigate') return (await cache.match('./index.html')) ?? Response.error();
    return Response.error();
  })());
});
