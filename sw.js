/* 就活ボード ─ オフライン対応
 *
 * 方針
 *   画面の骨組み（HTML）: まず取りに行き、駄目なら保存版
 *     → 更新がすぐ届き、圏外でも開ける
 *   アイコンなどの部品   : まず保存版、無ければ取りに行く
 *     → 変わらないものを毎回取りに行かない
 *   会社ロゴの画像       : まず保存版、裏で取り直す
 *     → 開くたびに読み込み待ちが出ない
 *   Apps Script への通信 : 一切触らない
 *     → 古いデータを返さない。データの保存はアプリ側が担当
 *
 * 大きな変更を入れたら VERSION を上げること。古い保存分が破棄される。
 */
const VERSION = 'v3';
const SHELL = 'shukatsu-shell-' + VERSION;
const ASSET = 'shukatsu-asset-' + VERSION;
const LOGO  = 'shukatsu-logo-' + VERSION;

const SHELL_URLS = ['./', './index.html'];
const ASSET_URLS = [
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './favicon-32.png'
];

/* 会社ロゴの取得先。ここだけは外部でも保存する。
   画像はまず変わらないので、毎回ネットに出る必要がない */
const LOGO_HOSTS = [
  'icons.duckduckgo.com',
  'www.google.com',            /* s2/favicons */
  'commons.wikimedia.org',
  'upload.wikimedia.org'
];
/* 溜めすぎないように、この件数を超えたら古いものから捨てる */
const LOGO_MAX = 300;

function isLogoRequest(url, req) {
  if (LOGO_HOSTS.indexOf(url.hostname) >= 0) {
    /* google.com は s2/favicons だけ。他のパスは触らない */
    if (url.hostname === 'www.google.com') return url.pathname.indexOf('/s2/favicons') === 0;
    return true;
  }
  /* 企業サイト直下の favicon.ico も同じ扱いにする */
  if (url.pathname === '/favicon.ico') return true;
  return req.destination === 'image' && url.origin !== self.location.origin;
}

function trimCache(name, max) {
  caches.open(name).then(function (c) {
    c.keys().then(function (keys) {
      if (keys.length <= max) return;
      /* 先に入ったものから消す */
      keys.slice(0, keys.length - max).forEach(function (k) { c.delete(k); });
    });
  });
}

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
        if (k !== SHELL && k !== ASSET && k !== LOGO) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (e) {
  if (e.data === 'skipWaiting') self.skipWaiting();
  /* ロゴを取り直したいときにアプリから呼べる */
  if (e.data === 'clearLogoCache') caches.delete(LOGO);
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  /* --- 会社ロゴ。保存版を即返し、裏で静かに取り直す --- */
  if (url.origin !== self.location.origin && isLogoRequest(url, req)) {
    e.respondWith(
      caches.match(req, { cacheName: LOGO }).then(function (hit) {
        const net = fetch(req).then(function (res) {
          /* 別ドメインの画像は中身を読めない（opaque）ので、
             status は 0 になる。取れていれば保存してよい */
          if (res && (res.status === 200 || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(LOGO).then(function (c) {
              c.put(req, copy).then(function () { trimCache(LOGO, LOGO_MAX); });
            });
          }
          return res;
        }).catch(function () { return hit; });
        return hit || net;
      })
    );
    return;
  }

  /* Apps Script・Wikidata の問い合わせは素通し。保存すると古い内容が返る */
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
