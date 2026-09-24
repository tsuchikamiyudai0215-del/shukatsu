/*
 * sw.js のテスト。reference-tests/sw_test.js を土台に、新版の方針に合わせたもの。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ORIGIN = 'https://example.github.io';
const BASE = ORIGIN + '/shukatsu/v2/';
const SRC = fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8');
const CODE = 'shukatsu2-code-v1', ASSET = 'shukatsu2-asset-v1', LOGO = 'shukatsu2-logo-v1';

function env(net) {
  const stores = {};
  const keyOf = (k) => (typeof k === 'string' ? new URL(k, BASE).href : k.url);
  class Cache {
    constructor() { this.m = new Map(); }
    async put(k, r) { this.m.delete(keyOf(k)); this.m.set(keyOf(k), r); }
    async match(k) { return this.m.get(keyOf(k)); }
    async add(k) { const r = await E.net(keyOf(k), {}); if (!r.ok) throw Error('add failed ' + keyOf(k)); await this.put(k, r); }
    async addAll(a) { for (const k of a) await this.add(k); }
    async keys() { return [...this.m.keys()].map((url) => ({ url })); }
    async delete(k) { return this.m.delete(keyOf(k)); }
  }
  const caches = {
    open: async (n) => stores[n] || (stores[n] = new Cache()),
    keys: async () => Object.keys(stores),
    delete: async (n) => delete stores[n],
    match: async (k) => { for (const c of Object.values(stores)) { const r = await c.match(k); if (r) return r; } }
  };
  const L = {};
  const self = { location: new URL(BASE + 'sw.js'), addEventListener: (t, f) => { L[t] = f; }, skipWaiting: async () => {}, clients: { claim: async () => {} } };
  const Req = function (u, o) { return Object.assign({ url: new URL(u, BASE).href }, o); };
  const E = {
    stores, net,
    ctx: null,
    req: (u, o = {}) => Object.assign({ url: new URL(u, BASE).href, method: 'GET', mode: o.mode || 'no-cors', destination: o.destination || '' }, o),
    async fire(type, ev) {
      const w = [];
      let rw;
      const e = Object.assign({}, ev, { waitUntil: (p) => w.push(p), respondWith: (p) => { rw = p; } });
      L[type](e);
      const r = rw ? await rw : undefined;
      for (let i = 0; i < 4; i++) await Promise.all(w.map((p) => Promise.resolve(p).catch(() => {})));
      const settled = await Promise.allSettled(w);
      return { r, handled: !!rw, failed: settled.filter((s) => s.status === 'rejected').map((s) => String(s.reason)) };
    },
    cache: (n) => caches.open(n)
  };
  E.ctx = {
    self, caches, Request: Req, URL, Set, Promise, console,
    fetch: (u, o) => E.net(typeof u === 'string' ? u : u.url, o || {}),
    Response: { error: () => ({ type: 'error' }), redirect: (u, s) => ({ type: 'redirect', u, s }) }
  };
  vm.createContext(E.ctx);
  vm.runInContext(SRC, E.ctx);
  return E;
}

const R = (o) => ({ ok: (o.status || 200) >= 200 && (o.status || 200) < 300, status: o.status || 200, type: o.type || 'basic',
  redirected: !!o.redirected, url: o.url || '', clone() { return this; }, tag: o.tag });

test('保存するコードの一覧が、実際のファイルとそろっている（足したファイルの書き忘れを防ぐ）', () => {
  const listed = [...SRC.matchAll(/'\.\/((?:js|css|shared)\/[^']+)'/g)].map((m) => m[1]).sort();
  const walk = (dir) => fs.readdirSync(path.join(__dirname, '..', dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(dir + '/' + d.name) : [dir + '/' + d.name]);
  const onDisk = walk('js').concat(walk('css'), ['shared/domain.js']).filter((f) => /\.(js|css)$/.test(f)).sort();
  assert.deepEqual(listed, onDisk);
});

test('入れ替え：コードは全部そろえる。部品は1つ欠けても続ける', async () => {
  const E = env(async (u) => (u.endsWith('favicon-32.png') ? R({ status: 404 }) : R({ tag: u })));
  await E.fire('install', {});
  assert.ok(await (await E.cache(CODE)).match('./index.html'));
  assert.ok(await (await E.cache(CODE)).match('./js/main.js'));
  assert.ok(await (await E.cache(ASSET)).match('../icon-192.png'));
  assert.equal(await (await E.cache(ASSET)).match('../favicon-32.png'), undefined);
});

test('入れ替え：コードが1つでも取れなければ入れ替えない', async () => {
  let skipped = false;
  const E = env(async (u) => (u.endsWith('store.js') ? R({ status: 404 }) : R({})));
  E.ctx.self.skipWaiting = async () => { skipped = true; };
  const { failed } = await E.fire('install', {});
  assert.match(failed.join(), /add failed .*store\.js/);
  assert.equal(skipped, false);
});

test('コード：ネットを先に見る（no-cache）。500 で保存版を上書きしない。圏外なら保存版', async () => {
  let calls = [];
  const E = env(async (u, o) => { calls.push(o); return R({ tag: 'new' }); });
  await E.fire('install', {});
  let { r } = await E.fire('fetch', { request: E.req(BASE + 'js/store.js?v=1') });
  assert.equal(r.tag, 'new');
  assert.ok(calls.some((o) => o.cache === 'no-cache'));
  E.net = async () => R({ status: 500, tag: 'err' });
  await E.fire('fetch', { request: E.req(BASE + 'js/store.js') });
  assert.notEqual((await (await E.cache(CODE)).match(BASE + 'js/store.js')).tag, 'err');
  E.net = async () => { throw TypeError('offline'); };
  ({ r } = await E.fire('fetch', { request: E.req(BASE + 'js/store.js') }));
  assert.equal(r.tag, 'new');
  ({ r } = await E.fire('fetch', { request: E.req(BASE + 'js/none.js') }));
  assert.equal(r.type, 'error');
});

test('画面：圏外で開いたページは index.html で代用する。転送は転送として返す', async () => {
  const E = env(async () => R({ tag: 'new' }));
  await E.fire('install', {});
  E.net = async () => { throw TypeError('offline'); };
  let { r } = await E.fire('fetch', { request: E.req(BASE + '?q=2', { mode: 'navigate' }) });
  assert.equal(r.tag, 'new');
  ({ r } = await E.fire('fetch', { request: E.req(ORIGIN + '/shukatsu/v2/other', { mode: 'navigate' }) }));
  assert.equal(r.tag, 'new');
  E.net = async () => R({ redirected: true, url: BASE });
  ({ r } = await E.fire('fetch', { request: E.req(ORIGIN + '/shukatsu/v2', { mode: 'navigate' }) }));
  assert.deepEqual([r.type, r.u], ['redirect', BASE]);
});

test('ロゴ：CORS で取れたら保存し、404 は保存しない。CORS 不可なら次から直接', async () => {
  const logo = 'https://icons.duckduckgo.com/ip3/a.co.jp.ico';
  const modes = [];
  const E = env(async (u, o) => { modes.push(o.mode || 'req'); return R({ type: 'cors', tag: 'L1' }); });
  let { r } = await E.fire('fetch', { request: E.req(logo, { destination: 'image' }) });
  assert.equal(r.tag, 'L1');
  assert.equal(modes[0], 'cors');
  assert.ok(await (await E.cache(LOGO)).match(logo));
  E.net = async () => { throw TypeError('offline'); };
  ({ r } = await E.fire('fetch', { request: E.req(logo, { destination: 'image' }) }));
  assert.equal(r.tag, 'L1');
  const miss = 'https://icons.duckduckgo.com/ip3/none.ico';
  E.net = async () => R({ status: 404, type: 'cors' });
  await E.fire('fetch', { request: E.req(miss, { destination: 'image' }) });
  assert.equal(await (await E.cache(LOGO)).match(miss), undefined);
  let seen = [];
  E.net = async (u, o) => { seen.push(o && o.mode); if (o && o.mode === 'cors') throw TypeError('cors'); return R({ status: 0, type: 'opaque', tag: 'op' }); };
  ({ r } = await E.fire('fetch', { request: E.req('https://www.google.com/s2/favicons?domain=b.jp&sz=256', { destination: 'image' }) }));
  assert.equal(r.tag, 'op');
  seen = [];
  await E.fire('fetch', { request: E.req('https://www.google.com/s2/favicons?domain=c.jp', { destination: 'image' }) });
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0], 'cors');
});

test('ロゴ：件数の上限を超えたら古いものから捨てる', async () => {
  const E = env(async () => R({ type: 'cors' }));
  for (let i = 0; i < 340; i++) await E.fire('fetch', { request: E.req('https://icons.duckduckgo.com/ip3/d' + i + '.ico', { destination: 'image' }) });
  assert.ok((await (await E.cache(LOGO)).keys()).length <= 320);
});

test('Apps Script・Wikidata・POST は素通し', async () => {
  const E = env(async () => R({}));
  assert.equal((await E.fire('fetch', { request: E.req('https://script.google.com/macros/s/x/exec') })).handled, false);
  assert.equal((await E.fire('fetch', { request: E.req('https://www.wikidata.org/w/api.php?x') })).handled, false);
  assert.equal((await E.fire('fetch', { request: Object.assign(E.req(BASE), { method: 'POST' }) })).handled, false);
});

test('入れ替わったら、新版の古い保存分だけを消し、旧版の保存分には触らない', async () => {
  const E = env(async () => R({}));
  for (const n of ['shukatsu2-code-v0', 'shukatsu-shell-v4', 'shukatsu-logo-v4', CODE]) await E.cache(n);
  await E.fire('activate', {});
  const keys = Object.keys(E.stores);
  assert.equal(keys.includes('shukatsu2-code-v0'), false);
  assert.ok(keys.includes('shukatsu-shell-v4'));
  assert.ok(keys.includes('shukatsu-logo-v4'));
  assert.ok(keys.includes(CODE));
});
