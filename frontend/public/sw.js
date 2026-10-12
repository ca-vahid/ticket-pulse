/* Ticket Pulse service worker (12 Oct 2026).
 *
 * Deliberately small: it makes the site installable and shows notifications.
 * It does NOT cache pages or bundles, so a release is never served stale.
 */
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

// Only ever open pages of this site, whatever a payload says.
function sameOriginPath(url) {
  try {
    const u = new URL(url || '/', self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : '/';
  } catch (e) { return '/'; }
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'Ticket Pulse', body: event.data ? event.data.text() : '' }; }
  const title = String(data.title || 'Ticket Pulse').slice(0, 120);
  event.waitUntil(self.registration.showNotification(title, {
    body: String(data.body || '').slice(0, 240),
    icon: '/brand/favicon-192.png',
    badge: '/brand/favicon-48.png',
    // One notification per ticket: a newer one replaces the older.
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { url: sameOriginPath(data.url) },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = sameOriginPath(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) { try { await client.navigate(path); } catch (e) { /* not controlled yet */ } }
        return;
      }
    }
    await self.clients.openWindow(path);
  })());
});
