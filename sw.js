// Service Worker — ClubApp v2.6.14
const CACHE = "clubapp-v2.6.14";
self.addEventListener("install",e=>{console.log("[SW] install v2.6.14");self.skipWaiting()});
self.addEventListener("activate",e=>{console.log("[SW] activate v2.6.14");e.waitUntil(clients.claim());e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))))});
self.addEventListener("fetch",e=>{if(e.request.method!=="GET")return;const u=new URL(e.request.url);if(u.origin!==self.location.origin)return;e.respondWith(fetch(e.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r}).catch(()=>caches.match(e.request)))});
