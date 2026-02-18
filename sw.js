'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  Service Worker  —  8-Ball AR Pool Assistant
//  Strategy: Cache-first for static assets; network-first for dynamic reqs.
//  Gives full offline capability once the app has been loaded once.
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_NAME = '8ball-ar-v3';

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
  // Icons (may not exist yet — fetch will silently fail and we handle it)
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
      console.log('[SW] install — shell cached');
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
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    ).then(() => {
      console.log('[SW] activate — old caches removed');
      // Take control of all open clients immediately
      return self.clients.claim();
    })
  );
});

// ── Fetch: cache-first for local assets, network-first for others ───────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Passthrough for cross-origin requests (CDNs, APIs, camera stream)
  if (url.origin !== self.location.origin) return;

  // Camera / media streams — never intercept
  if (url.pathname.includes('stream') || request.destination === 'video') return;

  event.respondWith(cacheFirst(request));
});

// ── Cache-first strategy ────────────────────────────────────────────────────
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(CACHE_NAME);
      // Clone before consuming body
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    // Offline fallback: return the cached index.html for navigation requests
    if (request.mode === 'navigate') {
      return caches.match('./index.html');
    }
    return new Response('Offline', { status: 503 });
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
