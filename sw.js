/* מסלול 12 — service worker: offline cache + push notifications */
const CACHE = 'maslul12-v1';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so updates arrive), cache as offline fallback.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
  );
});

/* ---------- status written by the app (IndexedDB) ---------- */
function idbGet(key) {
  return new Promise((resolve) => {
    const r = indexedDB.open('maslul12', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => resolve(null);
    r.onsuccess = () => {
      try {
        const tx = r.result.transaction('kv', 'readonly');
        const g = tx.objectStore('kv').get(key);
        g.onsuccess = () => resolve(g.result || null);
        g.onerror = () => resolve(null);
      } catch (err) { resolve(null); }
    };
  });
}
const pad = (n) => String(n).padStart(2, '0');
const isoLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function buildNotification(p) {
  const st = await idbGet('status');
  const today = p.date || isoLocal(new Date());
  const day = st && st.days ? st.days[today] : null;
  const tomorrowIso = isoLocal(new Date(Date.now() + 864e5));
  const tomorrow = st && st.days ? st.days[tomorrowIso] : null;

  if (p.type === 'evening') {
    const finished = day && (day.done >= day.total || day.skipped);
    if (day && day.rest) {
      return { title: 'מסלול 12 · יום מנוחה', body: `ללכת לישון מוקדם.${tomorrow ? ' מחר: ' + tomorrow.title : ''}`, tag: 'evening' };
    }
    if (finished) {
      return { title: 'מסלול 12 · היום הושלם ✓', body: `כל הכבוד!${tomorrow ? ' מחר: ' + tomorrow.title : ''}`, tag: 'evening' };
    }
    const what = day ? day.title : p.title;
    return {
      title: 'מסלול 12 · עוד לא סימנת',
      body: `היום: ${what}. עשית? היכנס וסמן. לא הספקת? יש עוד זמן לגרסה קצרה.`,
      tag: 'evening',
      requireInteraction: true
    };
  }
  // morning (and test)
  if (day) {
    return { title: `מסלול 12 · ${day.title}`, body: day.body || 'בהצלחה היום!', tag: 'morning' };
  }
  return { title: `מסלול 12 · ${p.title || 'האימון של היום'}`, body: p.body || 'פתח את האפליקציה לפרטים.', tag: 'morning' };
}

async function show(p) {
  const n = await buildNotification(p);
  return self.registration.showNotification(n.title, {
    body: n.body,
    tag: n.tag,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    lang: 'he',
    dir: 'rtl',
    requireInteraction: !!n.requireInteraction,
    data: { url: './#today' }
  });
}

self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (err) { p = { type: 'morning', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(show(p));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'test') e.waitUntil(show({ type: 'morning' }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.registration.scope)) { c.navigate(url).catch(() => {}); return c.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});
