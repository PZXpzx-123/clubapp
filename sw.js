// Service Worker — ClubApp v2.0.7
const CACHE = 'clubapp-v2.1.0';

self.addEventListener('install', (e) => {
  console.log('[SW] install v2.1.0');
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  console.log('[SW] activate v2.1.0');
  e.waitUntil(clients.claim());
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
});

// 网络优先，失败时回退缓存
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then(resp => {
      const clone = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return resp;
    }).catch(() => caches.match(e.request))
  );
});
