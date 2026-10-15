// Service worker PWA (п. 50): приложение ставится на ПК и планшет. Данные всегда с сервера —
// кэшируется только оболочка интерфейса, чтобы склад никогда не показывал устаревшие остатки.
const SHELL = "shell-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/favicon.svg", "/manifest.webmanifest"])));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api") || url.pathname.startsWith("/public")) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request).then((r) => r || caches.match("/"))));
});

// Push-уведомления о критичных сигналах (п. 60).
self.addEventListener("push", (e) => {
  const data = e.data ? e.data.json() : { title: "Склад", body: "Новый сигнал" };
  e.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: "/favicon.svg" }));
});
