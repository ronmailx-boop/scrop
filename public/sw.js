// Offline cache for the app shell + share-target handler.
// Bump VERSION on every release so clients pick up the new files.
const VERSION = 'scrop-v4';
const SHARE_CACHE = 'scrop-share';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './engine.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './vendor/pdf.min.mjs',
  './vendor/pdf.worker.min.mjs',
  './vendor/pdf-lib.esm.min.js',
  './vendor/fflate.mjs',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== SHARE_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;
  if (e.request.mode === 'navigate') {
    e.respondWith(caches.match('./index.html').then((r) => r || fetch(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)));
});

// The shared file is parked in a cache; the page picks it up after the redirect.
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const file = form.getAll('file').find((f) => f && typeof f !== 'string');
    if (file) {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put('shared-file', new Response(file, {
        headers: { 'content-type': file.type || 'application/octet-stream', 'x-name': encodeURIComponent(file.name || 'shared') },
      }));
    }
  } catch (err) {
    console.warn('share-target failed', err);
  }
  return Response.redirect(new URL('./?share=1', self.registration.scope).href, 303);
}
