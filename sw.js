/* 就活ボード ─ オフライン用キャッシュ
   画面そのもの（HTML・アイコン）だけを保存する。
   データは Apps Script への通信なので、ここでは扱わない。 */
const CACHE = 'shukatsu-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './favicon-32.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
                             .map(function (k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  const url = new URL(e.request.url);

  /* Apps Script や Wikidata への通信は素通し。キャッシュすると古い内容が返る */
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;

  /* 画面は「まず取りに行き、駄目なら保存版」。更新がすぐ届き、圏外でも開ける */
  e.respondWith(
    fetch(e.request).then(function (res) {
      const copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (hit) {
        return hit || caches.match('./index.html');
      });
    })
  );
});
