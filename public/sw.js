const SHELL = "vt-shell-v1";
self.addEventListener("install", (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/app.css", "/app.js", "/icon.svg", "/manifest.webmanifest"]))); self.skipWaiting(); });
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.pathname.startsWith("/api/") || e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let n = { title: "VIPONLYTRADER", body: "New opportunity on the board." };
    try { const r = await fetch("/api/push-latest", { credentials: "include" }); if (r.ok) n = await r.json(); } catch {}
    await self.registration.showNotification(n.title, { body: n.body, tag: n.tag || "vt", icon: "/icon.svg", badge: "/icon.svg", renotify: true, vibrate: [120, 60, 120] });
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow("/"))));
});
