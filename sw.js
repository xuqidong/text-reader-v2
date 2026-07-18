const CACHE_NAME = "text-reader-v41";
const CACHE_PREFIX = "text-reader-";
const OFFLINE_PAGE = "./index.html?v=41";
const APP_SHELL = [
  OFFLINE_PAGE,
  "./manifest.webmanifest",
  "./assets/icon.svg",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/dictionary-core.json",
  "./src/app.js?v=41",
  "./src/config.js?v=41",
  "./src/db.js",
  "./src/dictionary.js",
  "./src/sync.js",
  "./src/styles.css?v=41"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const scopePath = new URL("./", self.location.href).pathname;
  if (url.origin !== self.location.origin || !url.pathname.startsWith(scopePath)) return;

  if (request.mode === "navigate") {
    const isAppNavigation = url.pathname === scopePath || url.pathname === `${scopePath}index.html`;
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && isAppNavigation) {
            event.waitUntil(
              caches.open(CACHE_NAME).then((cache) => cache.put(OFFLINE_PAGE, response.clone()))
            );
          }
          return response;
        })
        .catch(() => caches.match(OFFLINE_PAGE))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok) {
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone())));
        }
        return response;
      });
      if (cached) {
        event.waitUntil(network.catch(() => undefined));
        return cached;
      }
      return network;
    })
  );
});
