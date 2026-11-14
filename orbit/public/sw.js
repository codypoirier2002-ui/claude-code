// Orbit's service worker (§12). It keeps the app shell available offline and
// leaves everything else alone.
//
// It handles same-origin GET requests only. Calls to the Claude API, a proxy or
// ElevenLabs are POSTs or cross-origin requests, so they are never cached and
// never answered from here. A same-origin GET that carries an API key header is
// skipped as well, and so is anything under /api/ (the demo server's proxies).

// The build id. scripts/stamp-sw.mjs puts the real value in dist/sw.js after
// every build (§18), so each build has its own cache and the previous one is
// deleted when the new worker activates.
const BUILD = "__ORBIT_BUILD__";
const CACHE_PREFIX = "orbit-";
const CACHE = `${CACHE_PREFIX}v1-${BUILD}`;

// Paths are relative to where this worker is served, so the rules also hold when
// the app lives in a sub-folder. At a site root the scope is "/".
const SCOPE = new URL(self.registration.scope);
const SHELL = SCOPE.href;
const ASSETS = `${SCOPE.pathname}assets/`;
const MEDIA = ["skies/", "character/", "ambience/"].map((dir) => `${SCOPE.pathname}${dir}`);

const API_HEADERS = ["authorization", "x-api-key", "xi-api-key", "anthropic-version", "anthropic-beta"];

const noop = () => {};

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The demo server's proxies (§21) live under the site's /api/ (also when the
  // app sits in a sub-folder) and are never cached or answered from here.
  if (url.pathname.startsWith("/api/")) return;
  if (API_HEADERS.some((name) => request.headers.has(name))) return;

  // Pages: network first, the latest copy kept under the app's root for offline.
  if (request.mode === "navigate") {
    event.respondWith(networkFirstPage(event));
    return;
  }
  // A partial response can't be answered from, or stored as, a whole file.
  if (request.headers.has("range")) return;

  if (url.pathname.startsWith(ASSETS)) {
    // Built files carry a content hash in their name: cache first.
    event.respondWith(cacheFirst(event));
  } else if (MEDIA.some((dir) => url.pathname.startsWith(dir))) {
    // Scenes, her art and the soundscapes: show what is stored, refresh it behind.
    event.respondWith(staleWhileRevalidate(event));
  }
  // Everything else goes straight to the network.
});

async function networkFirstPage(event) {
  let response;
  try {
    response = await fetch(event.request);
  } catch {
    return (await caches.match(SHELL, { cacheName: CACHE })) || Response.error();
  }
  // Only a good HTML page replaces the stored shell, never an error page or a stray file.
  if (response.ok && (response.headers.get("content-type") || "").includes("text/html")) {
    const copy = response.clone();
    event.waitUntil(caches.open(CACHE).then((cache) => cache.put(SHELL, copy)).catch(noop));
  }
  return response;
}

async function cacheFirst(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request);
  if (cached) return cached;
  const response = await fetch(event.request);
  remember(event, cache, response);
  return response;
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request);
  const refresh = fetch(event.request).then((response) => {
    remember(event, cache, response);
    return response;
  });
  if (!cached) return refresh;
  event.waitUntil(refresh.catch(noop));
  return cached;
}

/** Stores a complete (200) response, without holding up the page. */
function remember(event, cache, response) {
  if (response.status !== 200) return;
  const copy = response.clone();
  event.waitUntil(cache.put(event.request, copy).catch(noop));
}
