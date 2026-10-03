'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  Service Worker  —  8-Ball AR Pool Assistant
//  Strategy: stale-while-revalidate for same-origin GETs (instant + self-updating).
//  Gives full offline capability once the app has been loaded once.
// ═══════════════════════════════════════════════════════════════════════════

// Bump CACHE_VERSION on every deploy that changes a shipped file. The cache
// name embeds it; `activate` deletes every other `8ball-ar-` cache, and fetch
// uses stale-while-revalidate so even a missed bump heals on the next load.
const CACHE_VERSION = '2026-10-02.1';
const CACHE_PREFIX  = '8ball-ar-';
const CACHE_NAME    = CACHE_PREFIX + CACHE_VERSION;

// Static shell — all files that must be cached on install
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/constants.js',
  './js/physics.js',
  './js/gameState.js',
  './js/shotEngine.js',
  './js/homography.js',
  './js/arSession.js',
  './js/stickDetector.js',
  './js/tracker.js',
  './js/training.js',
  './js/detection.js',
  './js/renderer.js',
  './js/app.js',
  './icon-192.png',
  './icon-512.png',
];

// ── Install: pre-cache the shell ────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache assets one-by-one so a missing icon doesn't abort the whole install
      const results = await Promise.allSettled(
        SHELL_ASSETS.map((url) => cache.add(url).catch(() => {/* ok to miss */}))
      );
      return results;
    })
  );
  // Activate immediately without waiting for old tabs to close
  self.skipWaiting();
});

// ── Activate: clean up old caches ──────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    ).then(() => {
      // Take control of all open clients immediately
      return self.clients.claim();
    })
  );
});

// ── Fetch: stale-while-revalidate for same-origin GETs ──────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;               // CDNs, APIs
  if (request.destination === 'video' || request.headers.has('range')) return;

  event.respondWith(staleWhileRevalidate(request));
});

async function staleWhileRevalidate(request) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });

  const network = fetch(request).then((res) => {
    if (res.ok && res.type === 'basic') cache.put(request, res.clone());
    return res;
  });

  if (cached) {
    network.catch(() => {});          // background refresh; offline is fine
    return cached;
  }
  try {
    return await network;
  } catch {
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

// ── Message handler: allow app to force-refresh the cache ──────────────────
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      event.source?.postMessage({ type: 'CACHE_CLEARED' });
    });
  }
});
