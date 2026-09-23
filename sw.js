/* 就活ボード ─ オフライン対応
 *
 * 方針
 *   画面の骨組み（HTML）: まず取りに行き、駄目なら保存版
 *     → 更新がすぐ届き、圏外でも開ける
 *   アイコンなどの部品   : 保存版を先に返し、裏で取り直して次回に備える
 *     → 開くのは速く、差し替えも次に開いたときには届く
 *   会社ロゴの画像       : 保存版を先に返し、裏で取り直す
 *     → 開くたびに読み込み待ちが出ない
 *   Apps Script への通信 : 一切触らない
 *     → 古いデータを返さない。データの保存はアプリ側が担当
 *
 * 大きな変更を入れたら VERSION を上げること。古い保存分が破棄される。
 */
const VERSION = 'v4';
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

/* 会社ロゴの取得先。ここだけは外部でも保存する */
const LOGO_HOSTS = [
  'icons.duckduckgo.com',
  'www.google.com',            /* s2/favicons */
  'commons.wikimedia.org',
  'upload.wikimedia.org'
];
/* 溜めすぎないように、この件数を超えたら古いものから捨てる */
const LOGO_MAX = 300;
/* 件数の確認は毎回やると重いので、この回数ごとにまとめて行う */
const TRIM_EVERY = 20;
let putCount = 0;

/* CORS で取れなかったホスト。SW が眠るまでの間だけ覚えておき、無駄な再挑戦を省く */
const noCorsHosts = new Set();

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
  return caches.open(name).then(function (c) {
    return c.keys().then(function (keys) {
      if (keys.length <= max) return;
      /* 先に入ったものから消す（put し直した物は後ろへ回る） */
      return Promise.all(keys.slice(0, keys.length - max).map(function (k) { return c.delete(k); }));
    });
  });
}

/* 保存の失敗（容量不足など）で未処理のエラーを出さない */
function putSafe(name, key, res, trimMax) {
  return caches.open(name)
    .then(function (c) { return c.put(key, res); })
    .then(function () {
      if (trimMax && (++putCount % TRIM_EVERY === 0)) return trimCache(name, trimMax);
    })
    .catch(function () {});
}

/* ロゴはまず CORS で取る。
   CORS なら 404 などの失敗が見分けられ、失敗を保存せずに済む。
   不透明な応答（opaque）は中身が見えないうえ、
   ブラウザの容量計算で1件あたり数MB分として数えられるので、なるべく避ける */
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

/* 失敗時にキャッシュへ入れないため、install では HTTP キャッシュを通さず取り直す */
function fresh(u) { return new Request(u, { cache: 'reload' }); }

self.addEventListener('install', function (e) {
  e.waitUntil(Promise.all([
    /* 骨組みは必須。取れなければ入れ替えない */
    caches.open(SHELL).then(function (c) { return c.addAll(SHELL_URLS.map(fresh)); }),
    /* 部品は1つ欠けても入れ替えを止めない。欠けた物は使うときに取りに行く */
    caches.open(ASSET).then(function (c) {
      return Promise.all(ASSET_URLS.map(function (u) {
        return c.add(fresh(u)).catch(function () {});
      }));
    })
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
  if (e.data === 'clearLogoCache') e.waitUntil(caches.delete(LOGO));
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  /* --- 会社ロゴ。保存版を即返し、裏で静かに取り直す --- */
  if (url.origin !== self.location.origin && isLogoRequest(url, req)) {
    e.respondWith(
      caches.open(LOGO).then(function (c) { return c.match(req); }).then(function (hit) {
        const net = fetchLogo(req, url).then(function (res) {
          /* CORS で取れたなら成功したときだけ保存。opaque は見分けがつかないので保存する */
          if (res && (res.ok || res.type === 'opaque')) {
            e.waitUntil(putSafe(LOGO, req, res.clone(), LOGO_MAX));
          }
          return res;
        });
        if (hit) {
          /* 画面へは保存版を返したあとも、取り直しが終わるまで SW を起こしておく */
          e.waitUntil(net.catch(function () {}));
          return hit;
        }
        return net.catch(function () { return Response.error(); });
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
    /* ?以降が違うだけで別々に溜まらないよう、パスで保存する */
    const key = url.origin + url.pathname;
    e.respondWith(
      /* no-cache：ブラウザの HTTP キャッシュ（GitHub Pages は10分）を飛ばして、
         変わっていないかをサーバーに確かめる。変わっていなければ 304 で軽い */
      fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(function (res) {
        /* /repo → /repo/ のような転送を中身ごと返すと、Safari が表示を拒む。
           転送は転送として返し、ブラウザに付け直させる */
        if (res.redirected && req.mode === 'navigate') return Response.redirect(res.url, 302);
        /* エラーページで保存版を上書きしない */
        if (res.ok) e.waitUntil(putSafe(SHELL, key, res.clone()));
        return res;
      }).catch(function () {
        return caches.open(SHELL).then(function (c) {
          /* c.match は Promise を返すので、|| でつながず順に当たる */
          return c.match(key)
            .then(function (hit) { return hit || c.match('./index.html'); })
            .then(function (hit) { return hit || c.match('./'); });
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
