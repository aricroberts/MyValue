/* receipts. — Service Worker
 * Minimal SW: enables PWA installability without aggressive caching.
 * Tools call the Anthropic API live — we deliberately do NOT cache
 * API responses or tool HTML to ensure users always get fresh content.
 */

var CACHE_NAME = 'receipts-shell-v1';

/* Assets safe to cache: shell assets only, not tool HTML or API calls */
var SHELL_ASSETS = [
  '/',
  '/index.html'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      /* Cache shell assets; ignore failures so SW still installs */
      return cache.addAll(SHELL_ASSETS).catch(function() {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  /* Remove old caches on activation */
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  var url = e.request.url;

  /* Never intercept: Anthropic API, Stripe, external CDNs */
  if (
    url.indexOf('api.anthropic.com') !== -1 ||
    url.indexOf('buy.stripe.com') !== -1 ||
    url.indexOf('cdn.jsdelivr.net') !== -1 ||
    url.indexOf('fonts.googleapis.com') !== -1 ||
    url.indexOf('fonts.gstatic.com') !== -1
  ) {
    return; /* Fall through to network */
  }

  /* Network-first for all tool HTML pages */
  if (url.indexOf('.html') !== -1) {
    return; /* Always fresh */
  }

  /* Cache-first for shell assets (icons, manifest) */
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      return cached || fetch(e.request);
    })
  );
});
