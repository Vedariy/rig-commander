/**
 * RigCommander PWA Service Worker (0 deps, security-first).
 * - NEVER intercepts or caches /api/* requests or non-GET write-back commands.
 * - Network-first for HTML documents (keeps fresh DECK_TOKEN on localhost; offline fallback on /demo).
 * - Stale-while-revalidate for static assets (/assets/*, /manifest.webmanifest).
 */
const CACHE_PREFIX = 'rigcommander-pwa-';
const CACHE_NAME = 'rigcommander-pwa-v3.1.2';

const PRECACHE_URLS = [
  '/manifest.webmanifest',
  '/assets/styles/deck.css',
  '/assets/icons/favicon.svg',
  '/assets/icons/icon-192.png',
  '/assets/domain/index.js',
  '/assets/ontology/index.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!req || req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Never cache live telemetry, tmux captures, guardrails, or any API calls
  if (url.pathname.startsWith('/api/')) return;
  // Never cache large media streams in SW cache
  if (url.pathname.startsWith('/media/') && url.pathname.endsWith('.mp4')) return;

  // HTML navigations: network-first with offline cache fallback
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('/demo/')))
    );
    return;
  }

  // Static assets: stale-while-revalidate
  if (url.pathname.startsWith('/assets/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(req).then(cached => {
          const networkFetch = fetch(req).then(res => {
            if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
            return res;
          }).catch(() => cached);
          return cached || networkFetch;
        })
      )
    );
  }
});
