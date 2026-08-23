/* eslint-disable no-undef */
/**
 * RosterToCal service worker.
 *
 * Hand-written rather than generated, because what this file must NOT do
 * matters more than what it does: a roster photo is the most private
 * thing the app touches, and a caching layer is exactly the sort of
 * place it could end up by accident. Everything here is deliberate.
 *
 * __BUILD_ID__ and __PRECACHE__ are substituted at build time.
 */

const BUILD_ID = '__BUILD_ID__';
const CACHE = `rostertocal-${BUILD_ID}`;
const PRECACHE = __PRECACHE__;

/* ------------------------------------------------------------------ *
 * What must never be cached
 * ------------------------------------------------------------------ */

/**
 * The user's roster never travels over the network - it is a File read
 * straight into a canvas - so it cannot reach this worker in the normal
 * course of things. These guards exist so that stays true even if some
 * future change starts fetching something derived from it.
 */
function isCacheable(request, url) {
  if (request.method !== 'GET') return false;
  // Same origin only: nothing third-party is ever stored.
  if (url.origin !== self.location.origin) return false;
  // Object URLs and inline data are user content by definition.
  if (url.protocol === 'blob:' || url.protocol === 'data:') return false;
  // Range requests would poison the cache with partial bodies.
  if (request.headers.has('range')) return false;
  return true;
}

/** Immutable build output: safe to serve from cache first. */
function isHashedAsset(url) {
  return url.pathname.startsWith('/assets/');
}

/**
 * The OCR runtime: worker script, WASM core and language model. Large,
 * immutable for a given build, and useless to anyone but this app. The
 * cache name carries the build id, so a new deploy re-fetches them
 * rather than mixing versions.
 */
function isOcrAsset(url) {
  return url.pathname.startsWith('/tesseract/');
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      // A failed precache must not install a half-usable shell.
      .catch(() => undefined),
  );
  // Deliberately no skipWaiting(): a new worker waits until the page
  // asks for it, so a running session is never swapped mid-flight.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('rostertocal-') && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  // The page offers the user a reload when an update is ready; this is
  // the only way a new worker takes over.
  if (event.data === 'skip-waiting') self.skipWaiting();
});

/* ------------------------------------------------------------------ *
 * Fetch strategy
 * ------------------------------------------------------------------ */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (!isCacheable(request, url)) return;

  // Navigations: network first, so a new deploy is picked up on the next
  // load and the app shell can never be permanently pinned. Cache is the
  // offline fallback only.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() =>
          caches.match('/index.html').then((cached) => cached ?? Response.error()),
        ),
    );
    return;
  }

  // Hashed build output and OCR runtime: cache first. Both are immutable
  // for this build, and the OCR model is 2 MB that should not be
  // re-downloaded on a phone every session.
  if (isHashedAsset(url) || isOcrAsset(url)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Everything else same-origin (manifest, icons): cache with a network
  // refresh behind it.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached ?? network;
    }),
  );
});
