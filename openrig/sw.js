/**
 * RigCommander PWA Service Worker (0 deps, security-first).
 * - NEVER intercepts or caches /api/* requests or non-GET write-back commands.
 * - Network-first for HTML documents (keeps fresh DECK_TOKEN on localhost; offline fallback on /demo).
 * - Stale-while-revalidate for static assets (/assets/*, /manifest.webmanifest).
 */
const CACHE_PREFIX = 'rigcommander-pwa-';
const CACHE_NAME = 'rigcommander-pwa-v3.2.0';

const OFFLINE_FALLBACK_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#030712"><title>RigCommander — Offline</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#030712;color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:24px;text-align:center}.box{max-width:360px;background:#0a1224;border:1px solid rgba(56,189,248,.32);border-radius:16px;padding:24px}h1{font-size:18px;margin:0 0 8px}p{font-size:13px;color:#94a3b8;line-height:1.5;margin:0 0 16px}button{background:linear-gradient(135deg,#00f0ff,#00ff9d);border:0;border-radius:10px;padding:10px 18px;font-weight:800;color:#030712;cursor:pointer}</style>
</head><body><div class="box"><h1>💠 RigCommander Bridge Offline</h1><p>Unable to reach your live telemetry bridge. Check your Mac server or Tailscale / tunnel connection and reconnect.</p><button onclick="location.reload()">↻ Reconnect</button></div></body></html>`;

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

  // Never cache live telemetry, tmux captures, guardrails, pairing codes, or any API calls
  if (url.pathname.startsWith('/api/') || url.pathname === '/pair') return;
  // Never cache large media streams in SW cache
  if (url.pathname.startsWith('/media/') && url.pathname.endsWith('.mp4')) return;

  // HTML navigations: network-first with live/demo-aware offline cache fallback
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
        .catch(() =>
          caches.match(req).then(cached => {
            if (cached) return cached;
            const fallbackPath = url.pathname.startsWith('/demo') ? '/demo/' : '/';
            return caches.match(fallbackPath).then(fb =>
              fb || new Response(OFFLINE_FALLBACK_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
            );
          })
        )
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
