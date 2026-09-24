/*
 * 画面のテスト。jsdom の上で本物の画面のコードを起動し、裏は GAS の模擬環境（本物の GAS のコード）につなぐ。
 * RENEWAL_PLAN.md 2章のチェックリストのうち、画面で確かめられるものを1つずつ置く。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM, VirtualConsole } = require('jsdom');
const { mk } = require('./gas_mock.js');

const PAGE = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8')
  .replace(/<script[\s\S]*?<\/script>/g, '');   // スクリプトはこちらで読み込む
const EP = 'https://script.google.com/macros/s/test/exec';
const Domain = require('../shared/domain.js');
let main;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('待っても変わらなかった');
    await sleep(10);
  }
}

const pad = (n) => ('0' + n).slice(-2);
/* 今から days 日後の日本時間の文字列 */
function at(days, hh = 12, mm = 0) {
  const d = new Date(Date.now() + 9 * 3600000 + days * 86400000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + 'T' + pad(hh) + ':' + pad(mm);
}
function atMs(ms) {
  const d = new Date(Date.now() + 9 * 3600000 + ms);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}

/* よく使う会社を GAS の模擬環境に入れる */
function standard(T) {
  const add = (f) => {
    const r = T.api('addCompany', Object.assign({ logo: 'none' }, f));
    T.api('saveLogo', { id: r.company.id, logo: 'none', manual: false });
    return r.company;
  };
  const op = (c, o, args) => {
    const cur = T.api('getData', {}).companies.find((x) => x.id === c.id);
    return T.api('mutate', { id: c.id, op: o, args: args || {}, updatedAt: cur.updatedAt }).company;
  };
  const ids = {};
  ids.mgmt = add({ name: 'テストセンター', kind: 'mgmt', stage: '適性検査', dueAt: at(5) }).id;
  ids.a = add({ name: '株式会社エー', stage: 'ES', dueAt: at(1, 23, 59), url: 'https://a.example', loginId: 'ida', pw: 'secret-pw' }).id;
  ids.b = add({ name: 'ビー銀行', stage: 'エントリー', dueAt: at(8) }).id;
  const late = add({ name: 'シー商事', stage: 'ES' });
  op(late, 'setDue', { dueAt: at(-2) });      // 締切を過ぎた対応中
  ids.late = late.id;
  const w = add({ name: 'ディー通信', stage: '適性検査' });
  op(w, 'done');
  ids.w = w.id;
  const f = add({ name: 'イー電機', stage: '面接' });
  op(f, 'fail');
  ids.f = f.id;
  ids.h = add({ name: 'エイチ本選考', term: '本選考', stage: 'エントリー' }).id;
  return ids;
}

async function boot(opts = {}) {
  const T = mk({ API_KEY: 'k' });
  const ids = opts.seed === false ? {} : standard(T);
  if (opts.after) opts.after(T, ids);
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(PAGE, { url: 'https://example.github.io/shukatsu/v2/', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  global.window = w;
  global.document = w.document;
  global.Domain = Domain;
  w.Domain = Domain;
  global.requestAnimationFrame = (f) => setTimeout(f, 0);
  global.cancelAnimationFrame = (t) => clearTimeout(t);
  Object.defineProperty(w, 'innerWidth', { value: opts.width || 390, configurable: true });
  w.scrollTo = () => {};
  w.confirm = () => true;
  w.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, (c) => '\\' + c) };
  /* jsdom は画像を読まないので、ロゴ探しの確かめはすぐ失敗させる */
  w.Image = class { set src(v) { if (v) setTimeout(() => this.onerror && this.onerror(), 0); } };
  const clip = { text: null };
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (t) => { clip.text = t; } }, configurable: true });

  const ls = w.localStorage;
  if (opts.config !== false) { ls.setItem('sk2_ep', EP); ls.setItem('sk2_key', opts.key || 'k'); }
  for (const [k, v] of Object.entries(opts.ls || {})) ls.setItem(k, v);

  const calls = [];
  const net = { fail: opts.fail || null, delay: opts.delay || null, down: false };
  w.fetch = async (url, o) => {
    if (!String(url).startsWith(EP)) return { ok: true, json: async () => ({}) };
    const body = JSON.parse(o.body);
    calls.push(Object.assign({ keepalive: !!o.keepalive }, body));
    if (net.delay) await sleep(net.delay(body) || 0);
    if (net.down) throw new TypeError('offline');
    const msg = net.fail && net.fail(body);
    const text = msg ? JSON.stringify({ ok: false, error: msg }) : T.ctx.route_(body);
    return { ok: true, status: 200, text: async () => text };
  };

  if (!main) main = await import(pathToFileURL(path.join(__dirname, '../js/main.js')).href);
  const app = main.start();
  if (opts.wait !== false) await app.ready;
  const d = w.document;
  const $ = (s) => d.querySelector(s);
  const $$ = (s) => Array.from(d.querySelectorAll(s));
  const click = (el) => { if (typeof el === 'string') el = $(el); assert.ok(el, 'ボタンが無い'); el.click(); };
  const R = {
    w, d, T, ids, calls, net, clip, errors, app, $, $$, click,
    rows: () => $$('#view .row .name').map((n) => n.textContent),
    chip: (k) => { const b = $(`.chiprow [data-v="${k}"] b`); return b ? +b.textContent : 0; },
    toast: () => $('#toast').textContent,
    mutates: () => calls.filter((c) => c.action === 'mutate'),
    stop: () => { if (!running.has(R)) return; running.delete(R); app.stop(); w.close(); }
  };
  running.add(R);
  return R;
}

/* テストが途中で失敗しても、起動した画面を止める（1秒ごとの見出しの更新でプロセスが終わらなくなるため） */
const running = new Set();
test.afterEach(() => { for (const R of Array.from(running)) R.stop(); });

// ============================================================
// 接続と同期
// ============================================================

test('接続設定：未設定なら設定画面。URL の形と鍵を確かめ、端末にだけ保存する', async () => {
  const R = await boot({ config: false });
  assert.ok(R.$('#cfgEp'));
  assert.equal(R.$('#tabbar').style.display, 'none');
  R.$('#cfgEp').value = 'https://evil.example/exec';
  R.$('#cfgKey').value = 'k';
  R.click('[data-act="setup"]');
  assert.match(R.$('.setupErr').textContent, /script\.google\.com/);
  R.$('#cfgEp').value = EP;
  R.$('#cfgKey').value = 'k';
  R.click('[data-act="setup"]');
  await until(() => R.rows().length);
  assert.equal(R.w.localStorage.getItem('sk2_ep'), EP);
  assert.equal(R.$('#tabbar').style.display, '');
  R.stop();
});

test('接続設定：鍵が違えば、理由を添えて設定画面に戻す', async () => {
  const R = await boot({ key: 'wrong' });
  assert.match(R.$('.setupErr').textContent, /鍵が違います/);
  R.stop();
});

test('起動時は端末の保存分を先に出し、裏で最新を取る。「更新中…」を出す', async () => {
  const R0 = await boot();
  const cache = R0.w.localStorage.getItem('sk2_cache');
  R0.stop();
  const R = await boot({ ls: { sk2_cache: cache }, delay: () => 150, wait: false });
  await until(() => R.rows().length);
  assert.ok(R.$('#stale').classList.contains('on'));
  assert.equal(R.calls.length, 1);
  await R.app.ready;
  assert.equal(R.$('#stale').classList.contains('on'), false);
  R.stop();
});

test('最新が取れなければ、保存分を出したまま「取得できませんでした」と出す', async () => {
  const R0 = await boot();
  const cache = R0.w.localStorage.getItem('sk2_cache');
  R0.stop();
  const R = await boot({ ls: { sk2_cache: cache }, fail: () => '通信に失敗しました。' });
  assert.ok(R.rows().length > 0);
  assert.match(R.$('#stale').textContent, /取得できませんでした/);
  R.stop();
});

test('保存分が無く取得も失敗したら、再読み込みと接続設定を出す', async () => {
  const R = await boot({ fail: () => 'だめ' });
  assert.ok(R.$('[data-act="reload"]') && R.$('[data-act="setup-open"]'));
  R.stop();
});

test('保存を待たずに画面を先に変え、裏で送る。送るときは updatedAt を付ける', async () => {
  const R = await boot({ delay: (b) => (b.action === 'mutate' ? 200 : 0) });
  R.click(`.row[data-id="${R.ids.b}"]`);
  const before = R.chip('wait');
  R.click('#sheet [data-act="done"]');
  assert.equal(R.chip('wait'), before + 1);          // 応答より先に変わっている
  assert.equal(R.mutates().length, 1);
  assert.ok(R.mutates()[0].args.updatedAt);
  await until(() => R.T.api('getData', {}).companies.find((c) => c.id === R.ids.b).status === 'waiting');
  R.stop();
});

test('保存に失敗したら元に戻し、理由を出す', async () => {
  const R = await boot({ fail: (b) => (b.action === 'mutate' ? 'シートに書けませんでした。' : null) });
  R.click(`.row[data-id="${R.ids.b}"]`);
  const before = R.chip('todo');
  R.click('#sheet [data-act="skip"]');
  assert.equal(R.chip('todo'), before - 1);
  await until(() => R.chip('todo') === before);
  assert.match(R.toast(), /保存できませんでした：シートに書けませんでした/);
  R.stop();
});

test('ほかの端末で先に書き換えられていたら、上書きせずに最新を出す', async () => {
  const R = await boot();
  /* ほかの端末で業種を変えた */
  const cur = R.T.api('getData', {}).companies.find((c) => c.id === R.ids.b);
  R.T.api('mutate', { id: R.ids.b, op: 'setIndustry', args: { industry: '金融' }, updatedAt: cur.updatedAt });
  R.click(`.row[data-id="${R.ids.b}"]`);
  R.click('#sheet [data-act="done"]');
  await until(() => /ほかの端末/.test(R.toast()));
  const server = R.T.api('getData', {}).companies.find((c) => c.id === R.ids.b);
  assert.equal(server.status, 'todo');
  await until(() => R.chip('todo') === 2);
  R.stop();
});

test('入力中は裏の再取得で詳細を描き直さない。描き直すときは書きかけとカーソルを残す', async () => {
  const R = await boot();
  R.click(`.row[data-id="${R.ids.b}"]`);
  const input = R.$('#sheet #coUrl');
  input.focus();
  input.value = 'https://書きかけ';
  input.setSelectionRange(3, 5);
  await R.app.ready;
  /* 裏で最新を取った */
  R.T.api('mutate', { id: R.ids.a, op: 'setIndustry', args: { industry: 'x' }, updatedAt: R.T.api('getData', {}).companies.find((c) => c.id === R.ids.a).updatedAt });
  const view = R.d.getElementById('view');
  await import(pathToFileURL(path.join(__dirname, '../js/store.js')).href).then((s) => s.refresh());
  assert.equal(R.$('#sheet #coUrl'), input);          // 詳細は描き直していない
  assert.equal(R.d.getElementById('view'), view);
  input.blur();
  await sleep(10);
  const again = R.$('#sheet #coUrl');
  assert.notEqual(again, input);                       // 入力が終わってから描き直した
  assert.equal(again.value, 'https://書きかけ');        // 書きかけは残る
  R.stop();
});

test('ルートの編集は 400ms まとめて送り、保存待ちの分は届いた一覧の上に重ねる', async () => {
  const R = await boot();
  R.click(`.row[data-id="${R.ids.b}"]`);
  R.click('#sheet [data-act="tab"][data-v="route"]');
  R.click('#sheet [data-act="route-down"][data-v="0"]');
  R.click('#sheet [data-act="route-down"][data-v="1"]');
  const want = ['ES', '適性検査', 'エントリー', 'GD', '面接', '最終面接', '内定'];
  const store = await import(pathToFileURL(path.join(__dirname, '../js/store.js')).href);
  await store.refresh();                               // 送る前に最新が届いた
  assert.deepEqual(store.company(R.ids.b).route, want);
  assert.equal(R.mutates().length, 0);
  await until(() => R.mutates().length === 1, 1500);
  assert.deepEqual(R.mutates()[0].args.args.route, want);
  await sleep(50);
  assert.deepEqual(R.T.api('getData', {}).companies.find((c) => c.id === R.ids.b).route, want);
  R.stop();
});

test('画面を離れるときに、保存待ちの編集を送り切る', async () => {
  const R = await boot();
  R.click(`.row[data-id="${R.ids.b}"]`);
  R.click('#sheet [data-act="tab"][data-v="route"]');
  R.click('#sheet [data-act="route-down"][data-v="0"]');
  R.w.dispatchEvent(new R.w.Event('pagehide'));
  assert.equal(R.mutates().length, 1);
  assert.equal(R.mutates()[0].keepalive, true);
  R.stop();
});

test('引っ張って更新は最新を取り直す', async () => {
  const R = await boot();
  const n = R.calls.length;
  const touch = (type, y) => {
    const e = new R.w.Event(type, { bubbles: true });
    e.touches = y == null ? [] : [{ clientX: 100, clientY: y }];
    R.d.getElementById('view').dispatchEvent(e);
  };
  touch('touchstart', 10);
  touch('touchmove', 30);
  touch('touchmove', 200);
  touch('touchend');
  await until(() => R.calls.length > n);
  assert.equal(R.calls[R.calls.length - 1].action, 'getData');
  R.stop();
});

// ============================================================
// 一覧
// ============================================================

test('区分の切り替えと各区分の件数', async () => {
  const R = await boot();
  assert.equal(R.$('#sg0 .sgn').textContent, '6');
  assert.equal(R.$('#sg1 .sgn').textContent, '1');
  R.click('#sg1');
  assert.deepEqual(R.rows(), ['エイチ本選考']);
  assert.equal(JSON.parse(R.w.localStorage.getItem('sk2_ui')).term, '本選考');
  R.stop();
});

test('管理用の行は上の帯に出し、レーンには入れない', async () => {
  const R = await boot();
  assert.match(R.$('.strip').textContent, /テストセンター/);
  assert.equal(R.rows().includes('テストセンター'), false);
  R.stop();
});

test('締切を過ぎた対応中は結果待ちとして扱い、「締切経過で自動送り」と出す', async () => {
  const R = await boot();
  assert.equal(R.chip('wait'), 2);
  const row = R.$(`#view .lane[data-lane="wait"] .row[data-id="${R.ids.late}"]`);
  assert.ok(row);
  assert.match(row.textContent, /締切経過で自動送り/);
  R.stop();
});

test('見出しは次の締切を秒単位で数え、期限が切れたら一覧を組み直す', async () => {
  const R = await boot({ after: (T) => {
    /* 1分と少し先の締切。見出しに出るよう、どの締切より先にする */
    const c = T.api('addCompany', { name: 'すぐ締切', dueAt: atMs(61000) }).company;
    T.api('saveLogo', { id: c.id, logo: 'none', manual: false });
  } });
  assert.match(R.$('.hero h1').textContent, /すぐ締切/);
  await until(() => /\d+h\d+m\d+s/.test(R.$('#heroCd').textContent.replace(/\s/g, '')), 1500);
  R.stop();
});

test('絞り込み：件数を出し、選択を保存する。対象が0件なら「すべて」に戻す', async () => {
  const R = await boot({ ls: { sk2_ui: JSON.stringify({ page: 'list', term: '夏インターン', filt: 'offer' }) } });
  assert.equal(R.$('.chiprow .on').dataset.v, 'all');
  R.click('.chiprow [data-v="todo"]');
  assert.equal(JSON.parse(R.w.localStorage.getItem('sk2_ui')).filt, 'todo');
  assert.ok(R.$('.lane[data-lane="wait"]').classList.contains('is-filt-hidden'));
  assert.equal(R.$('.lane[data-lane="todo"]').classList.contains('is-filt-hidden'), false);
  R.stop();
});

test('レーンの並び：対応中は締切の近い順、終了は折りたたみ', async () => {
  const R = await boot();
  const todo = R.$$('.lane[data-lane="todo"] .row .name').map((n) => n.textContent);
  assert.deepEqual(todo, ['エー', 'ビー銀行']);
  assert.equal(R.$$('.lane[data-lane="end"] .row').length, 0);
  R.click('[data-act="toggle-lane"][data-v="end"]');
  assert.equal(R.$$('.lane[data-lane="end"] .row').length, 1);
  R.stop();
});

test('タイル：短くした社名、段階、2日以内は赤く、終了は薄く', async () => {
  const R = await boot();
  const a = R.$(`.row[data-id="${R.ids.a}"]`);
  assert.equal(a.querySelector('.name').textContent, 'エー');
  assert.equal(a.querySelector('.stage').textContent, 'ES');
  assert.ok(a.classList.contains('is-hot'));
  R.click('[data-act="toggle-lane"][data-v="end"]');
  assert.ok(R.$(`.row[data-id="${R.ids.f}"]`).classList.contains('is-muted'));
  R.stop();
});

test('表示中のページ・区分・絞り込みを保存し、次に開いたときに戻す', async () => {
  const R = await boot();
  R.click('#tb-pass');
  R.click('#sg1');
  const saved = R.w.localStorage.getItem('sk2_ui');
  R.stop();
  const R2 = await boot({ ls: { sk2_ui: saved } });
  assert.ok(R2.$('.ptitle'));
  assert.match(R2.$('.ptitle').textContent, /本選考/);
  R2.stop();
});

test('会社名などに記号が入っていても、HTML として解釈しない', async () => {
  const R = await boot({ after: (T) => T.api('addCompany', { name: '<img src=x onerror=alert(1)>"社' }) });
  assert.equal(R.$$('#view img[src="x"]').length, 0);
  assert.ok(R.rows().includes('<img src=x onerror=alert(1)>"社'));
  R.stop();
});

// ============================================================
// 詳細
// ============================================================

test('スマホはシートで開き、戻る操作で閉じる。幅 1000px 以上は右パネル', async () => {
  const R = await boot();
  R.click(`.row[data-id="${R.ids.a}"]`);
  assert.ok(R.$('#sheet .card.detail'));
  assert.ok(R.d.body.classList.contains('sheet-open'));
  R.w.history.back();
  await until(() => !R.$('#sheet .sheet'), 1000);
  assert.equal(R.d.body.classList.contains('sheet-open'), false);
  R.stop();

  const W = await boot({ width: 1280 });
  W.click(`.row[data-id="${W.ids.a}"]`);
  assert.ok(W.$('#side .card-head'));
  assert.equal(W.$('#sheet').children.length, 0);
  W.click('#side [data-act="close-detail"]');
  assert.ok(W.$('#sideEmpty'));
  W.stop();
});

test('タブ：概要／予定（件数つき）／選考ルート', async () => {
  const R = await boot({ after: (T, ids) => T.api('addEvent', { companyId: ids.a, kind: '面接', startAt: at(3) }) });
  R.click(`.row[data-id="${R.ids.a}"]`);
  assert.deepEqual(R.$$('#sheet .tabs button').map((b) => b.textContent), ['概要', '予定 1', '選考ルート']);
  R.click('#sheet [data-act="tab"][data-v="route"]');
  assert.ok(R.$('#sheet .rail'));
  R.stop();
});

test('概要：締切を保存・未定にする（時刻は時・分のプルダウン）', async () => {
  const R = await boot();
  R.click(`.row[data-id="${R.ids.b}"]`);
  assert.deepEqual(R.$$('#sheet #coDueM option').map((o) => o.value), ['00', '30', '59']);
  R.$('#sheet #coDueD').value = '2030-04-01';
  R.$('#sheet #coDueH').value = '09';
  R.$('#sheet #coDueM').value = '30';
  R.click('#sheet [data-act="set-due"]');
  await until(() => R.T.api('getData', {}).companies.find((c) => c.id === R.ids.b).dueAt === '2030-04-01T09:30');
  R.click('#sheet [data-act="clear-due"]');
  await until(() => R.T.api('getData', {}).companies.find((c) => c.id === R.ids.b).dueAt === '');
  R.stop();
});

test('概要：結果待ちの経過日数と「通過／落選」。最後の手前なら内定・参加決定と出す', async () => {
  const R = await boot({ after: (T) => {
    const c = T.api('addCompany', { name: '最終社', stage: '最終面接' }).company;
    T.api('mutate', { id: c.id, op: 'done', args: {}, updatedAt: c.updatedAt });
  } });
  const id = R.T.api('getData', {}).companies.find((c) => c.name === '最終社').id;
  R.click(`.row[data-id="${id}"]`);
  assert.match(R.$('#sheet .cd').textContent, /日経過/);
  assert.equal(R.$('#sheet [data-act="pass"]').textContent, '参加決定');
  R.click('#sheet [data-act="pass"]');
  await until(() => R.T.api('getData', {}).companies.find((c) => c.id === id).status === 'joined');
  R.stop();
});

test('概要：落選は確認してから。1段階戻す・対応中に戻す・参加決定にする', async () => {
  const R = await boot();
  R.click(`.row[data-id="${R.ids.w}"]`);
  let asked = '';
  R.w.confirm = (m) => { asked = m; return false; };
  R.click('#sheet [data-act="fail"]');
  assert.match(asked, /選考終了/);
  assert.equal(R.mutates().length, 0);
  R.click('#sheet [data-act="join"]');
  await until(() => R.T.api('getData', {}).companies.find((c) => c.id === R.ids.w).status === 'joined');
  R.click('#sheet [data-act="reopen"]');
  R.click('#sheet [data-act="prev"]');
  await until(() => R.T.api('getData', {}).companies.find((c) => c.id === R.ids.w).stage === 'ES');
  R.stop();
});

test('概要：マイページを開く（Chrome で開く設定つき）、書類フォルダ、ログインIDをコピー', async () => {
  const R = await boot();
  R.click(`.row[data-id="${R.ids.a}"]`);
  const my = R.$$('#sheet a.big').find((a) => a.textContent === 'マイページ');
  assert.equal(my.getAttribute('href'), 'https://a.example');
  assert.ok(R.$$('#sheet a.big').some((a) => a.textContent === '書類フォルダ'));
  R.click('#sheet [data-act="copy-id"]');
  await until(() => R.clip.text === 'ida');
  Object.defineProperty(R.w.navigator, 'userAgent', { value: 'iPhone', configurable: true });
  const sw = R.$('#sheet #chromeSw');
  sw.checked = true;
  sw.dispatchEvent(new R.w.Event('change', { bubbles: true }));
  assert.equal(R.$$('#sheet a.big').find((a) => a.textContent === 'マイページ').getAttribute('href'), 'googlechromes://a.example');
  assert.equal(R.w.localStorage.getItem('sk2_chrome'), '1');
  R.stop();
});

test('パスワード：押したときだけ取りに行き、控え帳へ入れる。画面・端末・一覧には残さない', async () => {
  const R = await boot();
  assert.equal(R.calls.some((c) => c.action === 'getPassword'), false);
  R.click(`.row[data-id="${R.ids.a}"]`);
  assert.match(R.$('#sheet').textContent, /••••••/);
  R.click('#sheet [data-act="copy-pw"]');
  await until(() => R.clip.text === 'secret-pw');
  assert.equal(R.calls.filter((c) => c.action === 'getPassword').length, 1);
  assert.equal(R.d.documentElement.outerHTML.includes('secret-pw'), false);
  for (let i = 0; i < R.w.localStorage.length; i++) {
    assert.equal(R.w.localStorage.getItem(R.w.localStorage.key(i)).includes('secret-pw'), false);
  }
  R.stop();
});

test('パスワード：伏せ字の欄から変える。保存したら欄を空にする', async () => {
  const R = await boot();
  R.click(`.row[data-id="${R.ids.b}"]`);
  const pw = R.$('#sheet #coPw');
  assert.equal(pw.type, 'password');
  pw.value = 'new-pw';
  R.click('#sheet [data-act="set-pw"]');
  await until(() => R.$('#sheet #coPw').value === '');
  assert.equal(R.T.api('getPassword', { id: R.ids.b }).pw, 'new-pw');
  R.stop();
});

test('概要：本選考に引き継ぐと、本選考に切り替えて新しい行を開く', async () => {
  const R = await boot();
  R.click(`.row[data-id="${R.ids.a}"]`);
  R.click('#sheet [data-act="carry"]');
  await until(() => R.$('#sg1.on'));
  await until(() => /エー/.test((R.$('#sheet .card-head') || { textContent: '' }).textContent));
  assert.ok(R.rows().includes('エー'));
  R.stop();
});

test('設定：開閉を覚える。業種（候補つき）・会社名の変更・別の選考を追加', async () => {
  const R = await boot();
  R.click(`.row[data-id="${R.ids.b}"]`);
  const det = R.$('#sheet #setwrap');
  det.open = true;
  det.dispatchEvent(new R.w.Event('toggle'));
  assert.equal(R.w.localStorage.getItem('sk2_set_open'), '1');
  assert.ok(R.$$('#sheet #indList option').length > 5);
  R.$('#sheet #indVal').value = '金融';
  R.click('#sheet [data-act="set-industry"]');
  R.$('#sheet #renName').value = '株式会社エー';
  R.click('#sheet [data-act="rename"]');
  assert.match(R.toast(), /すでに登録/);
  R.$('#sheet #renName').value = 'ビー銀行（新）';
  R.click('#sheet [data-act="rename"]');
  await until(() => R.T.api('getData', {}).companies.some((c) => c.name === 'ビー銀行（新）' && c.industry === '金融'));
  R.$('#sheet #splitName').value = 'ビー銀行（別コース）';
  R.click('#sheet [data-act="split"]');
  await until(() => R.T.api('getData', {}).companies.some((c) => c.name === 'ビー銀行（別コース）'));
  R.stop();
});

test('設定：ロゴを URL で指定するとシートにも保存し、手動の印を付ける', async () => {
  const R = await boot();
  R.click(`.row[data-id="${R.ids.b}"]`);
  R.$('#sheet #logoUrl').value = 'https://logo.example/b.png';
  R.click('#sheet [data-act="logo-set"]');
  await until(() => R.T.api('getData', {}).companies.find((c) => c.id === R.ids.b).logoManual === true);
  assert.ok(R.$$(`.row[data-id="${R.ids.b}"] img`).some((i) => i.getAttribute('src') === 'https://logo.example/b.png'));
  R.stop();
});

test('設定：削除は2回確認し、行と予定を消す', async () => {
  const R = await boot();
  R.click(`.row[data-id="${R.ids.b}"]`);
  let n = 0;
  R.w.confirm = () => { n++; return n === 2; };
  R.click('#sheet [data-act="delete-company"]');
  assert.equal(n, 1);
  assert.ok(R.rows().includes('ビー銀行'));
  R.w.confirm = () => true;
  R.click('#sheet [data-act="delete-company"]');
  await until(() => !R.rows().includes('ビー銀行'));
  assert.equal(R.T.api('getData', {}).companies.some((c) => c.id === R.ids.b), false);
  R.stop();
});

test('予定タブ：残り日数つきの一覧、追加（終日・連日・場所）、削除', async () => {
  const R = await boot();
  R.click(`.row[data-id="${R.ids.b}"]`);
  R.click('#sheet [data-act="tab"][data-v="events"]');
  const set = (id, v) => { R.$('#sheet #' + id).value = v; };
  set('evKind', 'インターン');
  set('evAtD', '2030-08-01'); set('evAtH', '10'); set('evAtM', '00');
  set('evEndD', '2030-08-03'); set('evEndH', '17'); set('evEndM', '00');
  R.$('#sheet #evDaily').checked = true;
  set('evPlace', '本社');
  R.click('#sheet [data-act="add-event"]');
  await until(() => R.$$('#sheet [data-act="delete-event"]').length === 1);
  assert.match(R.$('#sheet .tab-pane').textContent, /3日間 連日/);
  assert.equal(R.$('#sheet #evPlace').value, '');     // 追加できたら欄を空にする
  const allDay = R.$('#sheet #evAll');
  allDay.checked = true;
  allDay.dispatchEvent(new R.w.Event('change', { bubbles: true }));
  assert.ok(R.$('#sheet #evAtWrap').classList.contains('no-time'));
  R.click('#sheet [data-act="delete-event"]');
  await until(() => R.$$('#sheet [data-act="delete-event"]').length === 0);
  R.stop();
});

test('ルートタブ：現在地・並べ替え・削除（2段階以上、現在地は消せない）・候補から追加・名前を付けて追加', async () => {
  const R = await boot();
  R.click(`.row[data-id="${R.ids.b}"]`);
  R.click('#sheet [data-act="tab"][data-v="route"]');
  R.click('#sheet [data-act="route-rm"][data-v="0"]');
  assert.match(R.toast(), /今の段階は外せません/);
  R.$('#sheet #newStage').value = 'リクルーター面談';
  R.click('#sheet [data-act="route-custom"]');
  assert.match(R.$('#sheet .railtxt').textContent, /リクルーター面談/);
  assert.ok(JSON.parse(R.w.localStorage.getItem('sk2_stages')).includes('リクルーター面談'));
  R.click('#sheet [data-act="route-cur"][data-v="2"]');
  assert.match(R.$('#sheet .card-head').textContent, /適性検査/);
  await until(() => R.T.api('getData', {}).companies.find((c) => c.id === R.ids.b).stage === '適性検査', 1500);
  R.stop();
});

// ============================================================
// 追加と検索
// ============================================================

test('追加：URL・ID・ドメイン・段階・締切を入れられる。同じ区分の重複は弾く', async () => {
  const R = await boot();
  R.click('[data-act="add"]');
  R.$('#nC').value = 'ビー銀行';
  R.click('[data-act="add-company"]');
  assert.match(R.toast(), /すでに登録/);
  R.$('#nC').value = 'ジェイ工業';
  R.$('#nU').value = 'https://j.example';
  R.$('#nD').value = 'j.example';
  R.$('#nS').value = 'GD';
  R.$('#nDueD').value = '2030-02-01';
  R.click('[data-act="add-company"]');
  await until(() => R.rows().includes('ジェイ工業'));
  const c = R.T.api('getData', {}).companies.find((x) => x.name === 'ジェイ工業');
  assert.deepEqual([c.url, c.domain, c.stage, c.dueAt], ['https://j.example', 'j.example', 'GD', '2030-02-01T23:59']);
  R.stop();
});

test('検索：両方の区分から探し、Enter で先頭を開く。Ctrl+K で開く', async () => {
  const R = await boot();
  R.d.dispatchEvent(new R.w.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  const q = R.$('#q');
  assert.ok(q);
  q.value = 'エイチ';
  q.dispatchEvent(new R.w.Event('input', { bubbles: true }));
  assert.equal(R.$$('#qres button').length, 1);
  q.dispatchEvent(new R.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => R.$('#sg1.on') && R.$('#sheet .card.detail'), 2000);
  assert.match(R.$('#sheet .card-head').textContent, /エイチ本選考/);
  R.stop();
});

// ============================================================
// 記録タブ
// ============================================================

test('記録タブ：社数・通過数・段階別・結果待ち・業界別・内訳を出す', async () => {
  const R = await boot();
  R.click('#tb-pass');
  const text = R.$('#view').textContent;
  assert.match(text, /エントリー社数/);
  assert.match(text, /段階別の通過率/);
  assert.match(text, /結果待ち/);
  assert.match(text, /業界別の進み方/);
  assert.match(text, /進行中の内訳/);
  assert.match(text, /社が面接で終了/);
  R.stop();
});

// ============================================================
// ロゴ・端末の保存
// ============================================================

test('ロゴの表示に失敗したら次の候補へ。同じ URL は繰り返さない', async () => {
  const R = await boot({ after: (T) => T.api('addCompany', { name: 'ロゴ社', domain: 'logo.example' }) });
  const store = await import(pathToFileURL(path.join(__dirname, '../js/store.js')).href);
  const logo = await import(pathToFileURL(path.join(__dirname, '../js/logo.js')).href);
  const id = R.T.api('getData', {}).companies.find((c) => c.name === 'ロゴ社').id;
  store.setLogoLocal(id, '', false);
  const img = () => R.$(`.row[data-id="${id}"] .logo img`);
  R.click('.chiprow [data-v="all"]');
  const first = img().getAttribute('src');
  assert.match(first, /duckduckgo/);
  logo.logoFailed(img());
  const second = img().getAttribute('src');
  assert.notEqual(second, first);
  assert.match(second, /google\.com\/s2/);
  logo.logoFailed(img());
  assert.ok(R.$(`.row[data-id="${id}"] .logo.mono`));
  R.stop();
});

test('新版の保存は sk2_ だけを使い、旧版の保存分には触らない', async () => {
  const R = await boot({ ls: { sk_cache: 'legacy', sk_ep: 'legacy-ep' } });
  R.click('#sg1');
  assert.equal(R.w.localStorage.getItem('sk_cache'), 'legacy');
  assert.equal(R.w.localStorage.getItem('sk_ep'), 'legacy-ep');
  for (let i = 0; i < R.w.localStorage.length; i++) {
    const k = R.w.localStorage.key(i);
    assert.ok(k.startsWith('sk2_') || k === 'sk_cache' || k === 'sk_ep', k);
  }
  R.stop();
});

test('どの画面を通っても、スクリプトのエラーを出さない', async () => {
  const R = await boot({ width: 1280 });
  R.click(`.row[data-id="${R.ids.a}"]`);
  for (const t of ['events', 'route', 'info']) R.click(`#side [data-act="tab"][data-v="${t}"]`);
  R.click('#tb-pass');
  R.click('#tb-list');
  R.click('#sg1');
  assert.deepEqual(R.errors.filter((e) => !/Not implemented/.test(e)), []);
  R.stop();
});
