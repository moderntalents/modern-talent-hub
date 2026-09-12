// Minimal app-shell service worker: cache-first for static assets so the
// installed PWA opens instantly offline; everything else (pages, API calls,
// Supabase requests) goes to the network — this is a live app, not a static
// site, so data must always be fresh.
const CACHE = "mth-shell-v1";
const SHELL_ASSETS = ["/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isShellAsset = SHELL_ASSETS.includes(url.pathname) || url.pathname.startsWith("/icons/");

  if (event.request.method === "GET" && isShellAsset) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request)),
    );
  }
  // All other requests (pages, /api/*, Supabase) intentionally bypass the
  // cache and hit the network directly.
});
