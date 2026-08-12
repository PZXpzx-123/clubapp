// Service Worker — ClubApp v2.0.6
const CACHE_NAME = 'clubapp-v2.0.6';

// 立即激活，不等待旧 SW 释放
self.addEventListener('install', (e) => {
  console.log('[SW] install v2.0.6');
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  console.log('[SW] activate v2.0.6');
  // 清理旧缓存
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  // 立即接管所有客户端
  e.waitUntil(clients.claim());
});

// 网络优先：先尝试网络，失败则回退到缓存
self.addEventListener('fetch', (e) => {
  // 只处理同源 GET 请求
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then((response) => {
        // 网络成功 → 更新缓存
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return response;
      })
      .catch(() => {
        // 网络失败 → 从缓存读取
        return caches.match(e.request);
      })
  );
});

// 监听版本更新消息
self.addEventListener('message', (e) => {
  if (e.data === 'check-update') {
    self.registration.update();
  }
});
