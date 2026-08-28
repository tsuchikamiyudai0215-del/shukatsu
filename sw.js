/* 就活ボード ─ オフライン対応
 *
 * 方針
 *   画面の骨組み（HTML）: まず取りに行き、駄目なら保存版
 *     → 更新がすぐ届き、圏外でも開ける
 *   アイコンなどの部品   : まず保存版、無ければ取りに行く
 *     → 変わらないものを毎回取りに行かない
 *   Apps Script への通信 : 一切触らない
 *     → 古いデータを返さない。データの保存はアプリ側が担当
 *
 * 大きな変更を入れたら VERSION を上げること。古い保存分が破棄される。
 */
const VERSION = 'v2';
const SHELL = 'shukatsu-shell-' + VERSION;
const ASSET = 'shukatsu-asset-' + VERSION;

const SHELL_URLS = ['./', './index.html'];
const ASSET_URLS = [
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './favicon-32.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(Promise.all([
    caches.open(SHELL).then(function (c) { return c.addAll(SHELL_URLS); }),
    caches.open(ASSET).then(function (c) { return c.addAll(ASSET_URLS); })
  ]).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL && k !== ASSET) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (e) {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;
  /* Apps Script・Wikidata・ロゴ取得は素通し。保存すると古い内容が返る */
  if (url.origin !== self.location.origin) return;

  const isShell = req.mode === 'navigate' ||
                  url.pathname.endsWith('/') ||
                  url.pathname.endsWith('index.html');

  if (isShell) {
    e.respondWith(
      fetch(req).then(function (res) {
        const copy = res.clone();
        caches.open(SHELL).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('./index.html');
        });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function (hit) {
      const net = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(ASSET).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
