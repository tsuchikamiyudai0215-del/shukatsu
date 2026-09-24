/* 就活ボード（新版）のオフライン対応
 *
 * 方針
 *   画面のコード（HTML・JS・CSS・domain.js）: まず取りに行き、だめなら保存版
 *     → 更新がすぐ届き、圏外でも開ける。
 *       ファイルが分かれているので、古い保存版を先に返すと、新しい HTML と古い JS が混ざることがある。
 *       そのため部品より先に、必ずネットを見に行く。
 *   アイコンなどの部品 : 保存版を先に返し、裏で取り直して次回に備える
 *   会社ロゴの画像     : 保存版を先に返し、裏で取り直す。溜めすぎたら古いものから捨てる
 *   Apps Script・Wikidata への通信 : 一切触らない（古いデータを返さない）
 *
 * 旧版と同じ場所（同じオリジン）に置くので、保存領域は共有になる。
 * 消すのは自分の名前（shukatsu2-）の付いた古い版だけにして、旧版の保存分には触らない。
 *
 * 保存するファイルや方針を変えたら VERSION を上げること。古い保存分が捨てられる。
 */
const VERSION = 'v1';
const PREFIX = 'shukatsu2-';
const CODE = PREFIX + 'code-' + VERSION;
const ASSET = PREFIX + 'asset-' + VERSION;
const LOGO = PREFIX + 'logo-' + VERSION;

/* 画面を動かすのに要るファイル。1つでも取れなければ入れ替えない */
const CODE_URLS = [
  './',
  './index.html',
  './css/app.css',
  './shared/domain.js',
  './js/api.js',
  './js/boot.js',
  './js/format.js',
  './js/html.js',
  './js/logo.js',
  './js/main.js',
  './js/state.js',
  './js/storage.js',
  './js/store.js',
  './js/ui/liquid.js',
  './js/ui/notice.js',
  './js/ui/sheet.js',
  './js/views/add.js',
  './js/views/detail.js',
  './js/views/fields.js',
  './js/views/list.js',
  './js/views/passport.js',
  './js/views/search.js',
  './js/views/setup.js'
];
const ASSET_URLS = [
  './manifest.json',
  '../icon-180.png',
  '../icon-192.png',
  '../icon-512.png',
  '../favicon-32.png'
];

const LOGO_HOSTS = ['icons.duckduckgo.com', 'www.google.com', 'commons.wikimedia.org', 'upload.wikimedia.org'];
const LOGO_MAX = 300;
const TRIM_EVERY = 20;
let putCount = 0;

/* CORS で取れなかったホスト。SW が眠るまでの間だけ覚えて、無駄な再挑戦を省く */
const noCorsHosts = new Set();

function isLogoRequest(url, req) {
  if (LOGO_HOSTS.indexOf(url.hostname) >= 0) {
    if (url.hostname === 'www.google.com') return url.pathname.indexOf('/s2/favicons') === 0;
    return true;
  }
  if (url.pathname === '/favicon.ico') return true;
  return req.destination === 'image' && url.origin !== self.location.origin;
}

function trimCache(name, max) {
  return caches.open(name).then(function (c) {
    return c.keys().then(function (keys) {
      if (keys.length <= max) return;
      return Promise.all(keys.slice(0, keys.length - max).map(function (k) { return c.delete(k); }));
    });
  });
}

/* 保存の失敗（容量不足など）で、処理されないエラーを出さない */
function putSafe(name, key, res, trimMax) {
  return caches.open(name)
    .then(function (c) { return c.put(key, res); })
    .then(function () {
      if (trimMax && (++putCount % TRIM_EVERY === 0)) return trimCache(name, trimMax);
    })
    .catch(function () {});
}

/* ロゴはまず CORS で取る。CORS なら 404 が見分けられ、失敗を保存せずに済む。
   中身の見えない応答（opaque）は、ブラウザが1件あたり数MB分として数えるので、なるべく避ける */
function fetchLogo(req, url) {
  if (!noCorsHosts.has(url.hostname)) {
    return fetch(req.url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' })
      .catch(function () {
        noCorsHosts.add(url.hostname);
        return fetch(req);
      });
  }
  return fetch(req);
}

/* 入れ替えのときは HTTP キャッシュを通さずに取り直す */
function fresh(u) { return new Request(u, { cache: 'reload' }); }

self.addEventListener('install', function (e) {
  e.waitUntil(Promise.all([
    caches.open(CODE).then(function (c) { return c.addAll(CODE_URLS.map(fresh)); }),
    /* 部品は1つ欠けても入れ替えを止めない。欠けた物は使うときに取りに行く */
    caches.open(ASSET).then(function (c) {
      return Promise.all(ASSET_URLS.map(function (u) { return c.add(fresh(u)).catch(function () {}); }));
    })
  ]).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k.indexOf(PREFIX) === 0 && k !== CODE && k !== ASSET && k !== LOGO) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (e) {
  if (e.data === 'skipWaiting') self.skipWaiting();
  if (e.data === 'clearLogoCache') e.waitUntil(caches.delete(LOGO));
});

function isCode(url, req) {
  if (req.mode === 'navigate') return true;
  const p = url.pathname;
  return p.endsWith('/') || /\.(html|js|css)$/.test(p);
}

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  /* --- 会社ロゴ。保存版を先に返し、裏で取り直す --- */
  if (url.origin !== self.location.origin && isLogoRequest(url, req)) {
    e.respondWith(
      caches.open(LOGO).then(function (c) { return c.match(req); }).then(function (hit) {
        const net = fetchLogo(req, url).then(function (res) {
          if (res && (res.ok || res.type === 'opaque')) e.waitUntil(putSafe(LOGO, req, res.clone(), LOGO_MAX));
          return res;
        });
        if (hit) {
          e.waitUntil(net.catch(function () {}));
          return hit;
        }
        return net.catch(function () { return Response.error(); });
      })
    );
    return;
  }

  /* Apps Script・Wikidata の問い合わせは素通し */
  if (url.origin !== self.location.origin) return;

  if (isCode(url, req)) {
    /* ?以降が違うだけで別々に溜まらないよう、パスで保存する */
    const key = url.origin + url.pathname;
    e.respondWith(
      /* no-cache：ブラウザの HTTP キャッシュ（GitHub Pages は10分）を飛ばして、変わっていないかをサーバーに確かめる */
      fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(function (res) {
        /* /v2 → /v2/ のような転送を中身ごと返すと、Safari が表示を拒む。転送は転送として返す */
        if (res.redirected && req.mode === 'navigate') return Response.redirect(res.url, 302);
        if (res.ok) e.waitUntil(putSafe(CODE, key, res.clone()));
        return res;
      }).catch(function () {
        return caches.open(CODE).then(function (c) {
          return c.match(key).then(function (hit) {
            if (hit || req.mode !== 'navigate') return hit;
            return c.match('./index.html').then(function (h) { return h || c.match('./'); });
          });
        }).then(function (hit) { return hit || Response.error(); });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function (hit) {
      const net = fetch(req).then(function (res) {
        if (res && res.ok) e.waitUntil(putSafe(ASSET, req, res.clone()));
        return res;
      });
      if (hit) {
        e.waitUntil(net.catch(function () {}));
        return hit;
      }
      return net.catch(function () { return Response.error(); });
    })
  );
});
