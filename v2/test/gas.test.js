const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mk, DEV_SHEET, PROD_SHEET, DEV_CAL, PRIMARY_CAL, Sheet } = require('./gas_mock.js');

/* 日本時間の壁時計の値から、その瞬間の Date を作る */
const jst = (s) => new Date(Date.parse(s + ':00+09:00'));

function addCo(T, fields) {
  const r = T.api('addCompany', Object.assign({ name: 'A社', term: '本選考' }, fields));
  assert.equal(r.ok, true, r.error);
  return r.company;
}

function mutate(T, company, op, args) {
  return T.api('mutate', { id: company.id, op, args: args || {}, updatedAt: company.updatedAt });
}

function calOf(T, id) {
  return JSON.parse(T.rows('companies').find((r) => r.id === id).cal);
}

// ============================================================
// 置き方
// ============================================================

test('gas/domain.js は shared/domain.js と同じ（npm run sync の写し忘れ）', () => {
  const a = fs.readFileSync(path.join(__dirname, '../shared/domain.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '../gas/domain.js'), 'utf8');
  assert.equal(b, a, 'npm run sync を実行してください');
});

test('コードに秘密や本番の ID を書いていない。既定のカレンダーも使っていない', () => {
  const dir = path.join(__dirname, '../gas');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && x !== 'domain.js')) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /getDefaultCalendar\s*\(/, f);
    assert.doesNotMatch(src, /getUserProperties|getActiveSpreadsheet/, f);
    assert.doesNotMatch(src, /1v-nnIz3VQE2|1uP4LgaMzm|578c448e9fbc|1joW2cm8Z/, f);
  }
});

// ============================================================
// 設定と安全装置
// ============================================================

test('プロパティが無ければ、どれが足りないかを返す', () => {
  const T = mk({ SHEET_ID: '' });
  const r = T.api('getData', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /SHEET_ID/);
});

test('本番のシートを指していたら開かない', () => {
  const T = mk({ SHEET_ID: PROD_SHEET });
  const r = T.api('getData', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /本番/);
  assert.deepEqual(T.opened, []);
});

test('既定のカレンダーを指していたら使わない', () => {
  const T = mk({ CALENDAR_ID: PRIMARY_CAL });
  const r = T.api('addCompany', { name: 'A社', dueAt: '2030-01-10T12:00' });
  assert.equal(r.ok, false);
  assert.match(r.error, /既定のカレンダー/);
  assert.equal(T.live().length, 0);
});

test('ALLOW_PRODUCTION=yes のときだけ本番を開ける', () => {
  const T = mk({ SHEET_ID: PROD_SHEET, CALENDAR_ID: PRIMARY_CAL, ALLOW_PRODUCTION: 'yes' });
  assert.equal(T.api('addCompany', { name: 'A社', dueAt: '2030-01-10T12:00' }).ok, true);
  assert.equal(T.liveIn(PRIMARY_CAL).length, 1);
});

test('checkSetup で設定を確かめられる', () => {
  const T = mk();
  assert.equal(T.run('checkSetup'), 'ok');
  assert.ok(T.log.some((l) => l.includes('開発中')));
});

// ============================================================
// 認証とルーター
// ============================================================

test('鍵が違えば弾く。鍵が空のプロパティでも通さない', () => {
  let T = mk();
  assert.equal(T.api('getData', {}, 'wrong').error, 'unauthorized');
  assert.equal(T.api('getData', {}, undefined).ok, true);
  assert.equal(T.api('getData', {}, null).error, 'unauthorized');
  T = mk({ API_KEY: '' });
  assert.equal(T.api('getData', {}, '').error, 'unauthorized');
});

test('知らない操作と継承したプロパティは呼ばない', () => {
  const T = mk();
  assert.match(T.api('toString', {}).error, /知らない操作/);
  assert.match(T.api('constructor', {}).error, /知らない操作/);
  assert.match(T.api('migrate', {}).error, /知らない操作/);
});

test('doPost と doGet', () => {
  const T = mk();
  const out = T.ctx.doPost({ postData: { contents: JSON.stringify({ key: 'secret-key', action: 'getData' }) } });
  assert.equal(JSON.parse(out.s).ok, true);
  assert.equal(JSON.parse(T.ctx.doPost({ postData: { contents: '{' } }).s).error, 'bad payload');
  assert.equal(JSON.parse(T.ctx.doGet({ parameter: { key: 'secret-key', action: 'getData' } }).s).companies, undefined);
});

test('エラーでもロックを外す', () => {
  const T = mk();
  const r = T.api('mutate', { id: 'nope', op: 'pass', updatedAt: '' });
  assert.equal(r.ok, false);
  assert.equal(T.heldLock(), false);
  assert.equal(T.api('getData', {}).ok, true);
});

// ============================================================
// 読み取り
// ============================================================

test('getData はパスワードとカレンダーの対応表を載せない。25秒キャッシュに入れる', () => {
  const T = mk();
  addCo(T, { pw: 'secret-pw', dueAt: '2030-01-10T12:00' });
  const r = T.api('getData', {});
  assert.equal(r.companies.length, 1);
  assert.equal('pw' in r.companies[0], false);
  assert.equal('cal' in r.companies[0], false);
  assert.doesNotMatch(T.cache.data, /secret-pw/);
  // キャッシュがあればシートを読まない
  T.sheet('companies').d[1][2] = '書き換え';
  assert.equal(T.api('getData', {}).companies[0].name, 'A社');
  assert.equal(T.heldLock(), false);
});

test('書き込むとキャッシュを捨てる', () => {
  const T = mk();
  const c = addCo(T);
  T.api('getData', {});
  assert.ok(T.cache.data);
  mutate(T, c, 'setIndustry', { industry: '金融' });
  assert.equal(T.cache.data, undefined);
  assert.equal(T.api('getData', {}).companies[0].industry, '金融');
});

// ============================================================
// 会社の追加
// ============================================================

test('追加：フォルダを作り、締切の予定（30分枠・4日前と2日前）を開発用カレンダーに作る', () => {
  const T = mk();
  const c = addCo(T, { url: 'https://a', loginId: 'ida', pw: 'pwa', dueAt: '2030-01-10T12:00' });
  assert.match(c.folderUrl, /drive\.google\.com/);
  assert.equal(c.status, 'todo');
  assert.ok(c.updatedAt);
  const evs = T.liveIn(DEV_CAL);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].start.toISOString(), jst('2030-01-10T12:00').toISOString());
  assert.equal(evs[0].end - evs[0].start, 30 * 60000);
  assert.deepEqual(evs[0].reminders, [5760, 2880]);
  assert.doesNotMatch(evs[0].desc, /pwa|パスワード/);
  assert.equal(T.rows('companies')[0].pw, 'pwa');
  assert.equal(calOf(T, c.id).due.id, evs[0].id);
});

test('追加：時刻なしの締切は終日の予定', () => {
  const T = mk();
  addCo(T, { dueAt: '2030-01-10' });
  const [e] = T.liveIn(DEV_CAL);
  assert.equal(e.allDay, true);
  assert.equal(e.end - e.start, 86400000);
});

test('追加：同じ区分の重複は弾き、違う区分なら通す', () => {
  const T = mk();
  addCo(T, { name: 'A社', term: '本選考' });
  assert.match(T.api('addCompany', { name: ' A社 ', term: '本選考' }).error, /すでに/);
  assert.equal(T.api('addCompany', { name: 'A社', term: '夏インターン' }).ok, true);
  assert.equal(T.rows('companies').length, 2);
});

test('追加：同じ名前のフォルダがあれば、それを使う', () => {
  const T = mk();
  const a = addCo(T, { name: 'A社', term: '夏インターン' });
  const b = addCo(T, { name: 'A社', term: '本選考' });
  assert.equal(a.folderUrl, b.folderUrl);
});

test('追加：入力がおかしければ保存しない', () => {
  const T = mk();
  assert.match(T.api('addCompany', { name: '' }).error, /空/);
  assert.match(T.api('addCompany', { name: 'B社', url: 'ftp://x' }).error, /https/);
  assert.equal(T.rows('companies').length, 0);
});

test('見出しの名前で列を探す（列の順番が変わっていても読める）', () => {
  const T = mk();
  addCo(T, { name: 'A社' });
  const sh = T.sheet('companies');
  // 1列目と2列目を入れ替える
  sh.d.forEach((r) => { [r[0], r[1]] = [r[1], r[0]]; });
  const r = T.api('getData', {});
  assert.equal(r.companies[0].name, 'A社');
  assert.match(r.companies[0].id, /^c_/);
});

// ============================================================
// 状態を変える
// ============================================================

test('通過：次の段階へ。締切の予定はカレンダーから消える', () => {
  const T = mk();
  const c = addCo(T, { stage: 'ES', dueAt: '2030-01-10T12:00' });
  const r = mutate(T, c, 'pass');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.company.stage, '適性検査');
  assert.equal(r.company.dueAt, '');
  assert.notEqual(r.company.updatedAt, c.updatedAt);
  assert.equal(T.liveIn(DEV_CAL).length, 0);
  assert.deepEqual(calOf(T, c.id), {});
});

test('最後まで通ると、本選考は内定・夏インターンは参加決定', () => {
  const T = mk();
  const a = addCo(T, { name: 'A社', term: '本選考', stage: '最終面接' });
  const b = addCo(T, { name: 'B社', term: '夏インターン', stage: '最終面接' });
  assert.equal(mutate(T, a, 'pass').company.status, 'offer');
  assert.equal(mutate(T, b, 'pass').company.status, 'joined');
  // 再読み込みしても段階が戻らない
  const d = T.api('getData', {});
  assert.deepEqual(d.companies.map((x) => x.stage), ['内定', '内定']);
});

test('古い updatedAt の操作は書かずに、最新の会社を返す', () => {
  const T = mk();
  const c = addCo(T, { stage: 'ES' });
  const first = mutate(T, c, 'done');
  assert.equal(first.ok, true);
  const stale = mutate(T, c, 'skip');
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  assert.equal(stale.company.status, 'waiting');
  assert.equal(T.rows('companies')[0].status, 'waiting');
  assert.match(T.api('mutate', { id: c.id, op: 'skip' }).error, /updatedAt/);
});

test('続けて2回書いても updatedAt は毎回変わる', () => {
  const T = mk();
  let c = addCo(T, { stage: 'ES' });
  const seen = new Set([c.updatedAt]);
  for (const ind of ['a', 'b', 'c', 'd']) {
    c = mutate(T, c, 'setIndustry', { industry: ind }).company;
    assert.equal(seen.has(c.updatedAt), false);
    seen.add(c.updatedAt);
  }
});

test('できない操作は、画面に出せる文言で返し、何も書かない', () => {
  const T = mk();
  const c = addCo(T, { stage: 'エントリー' });
  const writes = T.sheet('companies').writes;
  const r = mutate(T, c, 'prev');
  assert.equal(r.ok, false);
  assert.match(r.error, /これ以上前/);
  assert.equal(T.sheet('companies').writes, writes);
  assert.match(mutate(T, c, 'nope').error, /知らない操作/);
});

test('見送り：締切と、これから先の予定を消す。終わった予定は残す。対応中に戻すと作り直す', () => {
  const T = mk();
  const c = addCo(T, { dueAt: '2030-01-10T12:00' });
  assert.equal(T.api('addEvent', { companyId: c.id, kind: '説明会', startAt: '2020-01-01T10:00' }).ok, true);
  const r2 = T.api('addEvent', { companyId: c.id, kind: '面接', startAt: '2030-01-05T10:00' });
  assert.equal(T.liveIn(DEV_CAL).length, 3);

  const skipped = mutate(T, r2.company, 'skip');
  assert.equal(skipped.ok, true, skipped.error);
  assert.deepEqual(T.liveIn(DEV_CAL).map((e) => e.title), ['【説明会】A社']);

  const back = mutate(T, skipped.company, 'reopen');
  assert.equal(back.ok, true);
  assert.deepEqual(T.liveIn(DEV_CAL).map((e) => e.title).sort(), ['【説明会】A社', '【面接】A社']);
  // 見送りで締切は外れているので、締切の予定は戻らない
  assert.equal(back.company.dueAt, '');
});

test('落選：これから先の予定を消し、落ちた段階を記録する', () => {
  const T = mk();
  const c = addCo(T, { stage: '面接' });
  const r = T.api('addEvent', { companyId: c.id, kind: '面接', startAt: '2030-01-05T10:00' });
  const f = mutate(T, r.company, 'fail');
  assert.equal(f.company.lostStage, '面接');
  assert.equal(T.liveIn(DEV_CAL).length, 0);
  assert.equal(T.rows('events').length, 1);   // 予定の行そのものは残す
});

test('改名：同じ区分の重複は弾く。カレンダーの見出しも直す', () => {
  const T = mk();
  const a = addCo(T, { name: 'A社', dueAt: '2030-01-10T12:00' });
  addCo(T, { name: 'B社' });
  assert.match(mutate(T, a, 'rename', { name: 'B社' }).error, /すでに/);
  const r = mutate(T, a, 'rename', { name: 'A社（新）' });
  assert.equal(r.ok, true);
  assert.match(T.liveIn(DEV_CAL)[0].title, /A社（新）/);
  assert.equal(T.liveIn(DEV_CAL).length, 1);
});

test('中身が同じなら、カレンダーに問い合わせない', () => {
  const T = mk();
  const c = addCo(T, { dueAt: '2030-01-10T12:00' });
  T.resetCalls();
  mutate(T, c, 'setIndustry', { industry: '金融' });
  assert.deepEqual(T.calCalls, { create: 0, update: 0, remove: 0, get: 0 });
});

test('手で消されたカレンダー予定は作り直す', () => {
  const T = mk();
  const c = addCo(T, { dueAt: '2030-01-10T12:00' });
  T.liveIn(DEV_CAL)[0].alive = false;
  const r = mutate(T, c, 'setDue', { dueAt: '2030-01-11T12:00' });
  assert.equal(r.ok, true);
  assert.equal(T.liveIn(DEV_CAL).length, 1);
  assert.equal(T.liveIn(DEV_CAL)[0].start.toISOString(), jst('2030-01-11T12:00').toISOString());
});

test('終日と時刻ありを行き来したら作り直す', () => {
  const T = mk();
  const c = addCo(T, { dueAt: '2030-01-10T12:00' });
  mutate(T, c, 'setDue', { dueAt: '2030-01-10' });
  const evs = T.liveIn(DEV_CAL);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].allDay, true);
});

test('対応表がほかのカレンダーの予定を指していても、その予定には触らない', () => {
  const T = mk();
  const prod = T.calendars[PRIMARY_CAL].createEvent('本番の予定', jst('2030-01-10T12:00'), jst('2030-01-10T12:30'), { description: 'パスワード: x' });
  const c = addCo(T, { dueAt: '2030-01-10T12:00' });
  // 対応表を本番の予定に向ける
  const sh = T.sheet('companies');
  const calCol = sh.d[0].indexOf('cal');
  sh.d[1][calCol] = JSON.stringify({ due: { id: prod.id, sig: '' }, 'ev:old': { id: prod.id, sig: 'x' } });
  T.liveIn(DEV_CAL).forEach((e) => { e.alive = false; });

  const r = mutate(T, c, 'setDue', { dueAt: '2030-01-12T12:00' });
  assert.equal(r.ok, true);
  assert.equal(prod.alive, true);
  assert.equal(prod.title, '本番の予定');
  assert.equal(prod.desc, 'パスワード: x');
  assert.equal(T.liveIn(DEV_CAL).length, 1);
  assert.notEqual(calOf(T, c.id).due.id, prod.id);
  assert.ok(T.log.some((l) => l.includes('別のカレンダー')));
});

test('カレンダーの失敗は保存を止めず、次に試せるよう元の対応を残す', () => {
  const T = mk();
  const c = addCo(T, { dueAt: '2030-01-10T12:00' });
  const e = T.liveIn(DEV_CAL)[0];
  e.deleteEvent = () => { throw new Error('quota'); };
  const r = mutate(T, c, 'skip');
  assert.equal(r.ok, true);
  assert.match(r.warning, /カレンダー/);
  assert.equal(r.company.status, 'skipped');
  assert.equal(calOf(T, c.id).due.id, e.id);
});

// ============================================================
// 予定
// ============================================================

test('予定：単発は前日と1時間前に通知。場所とマイページを説明に入れる', () => {
  const T = mk();
  const c = addCo(T, { url: 'https://a' });
  const r = T.api('addEvent', { companyId: c.id, kind: '面接', startAt: '2030-03-01T10:00', place: 'オンライン' });
  assert.equal(r.ok, true);
  assert.equal(r.events.length, 1);
  const [e] = T.liveIn(DEV_CAL);
  assert.equal(e.title, '【面接】A社');
  assert.equal(e.desc, 'オンライン\nマイページ: https://a');
  assert.deepEqual(e.reminders, [1440, 60]);
  assert.equal(e.end - e.start, 3600000);
});

test('予定：連日は日ごとに作り、消すと全部消える', () => {
  const T = mk();
  const c = addCo(T);
  const r = T.api('addEvent', { companyId: c.id, kind: 'インターン', startAt: '2030-08-01T10:00', endAt: '2030-08-03T17:00', daily: true });
  assert.equal(T.liveIn(DEV_CAL).length, 3);
  const d = T.api('deleteEvent', { id: r.events[0].id });
  assert.equal(d.ok, true);
  assert.equal(T.liveIn(DEV_CAL).length, 0);
  assert.equal(T.rows('events').length, 0);
  assert.deepEqual(calOf(T, c.id), {});
});

test('予定：終日は終わりの翌日まで', () => {
  const T = mk();
  const c = addCo(T);
  T.api('addEvent', { companyId: c.id, kind: 'インターン', startAt: '2030-08-01', endAt: '2030-08-03', allDay: true });
  const [e] = T.liveIn(DEV_CAL);
  assert.equal(e.allDay, true);
  assert.equal(e.end - e.start, 3 * 86400000);
});

test('予定：入力がおかしい・会社が無いときは保存しない', () => {
  const T = mk();
  const c = addCo(T);
  assert.match(T.api('addEvent', { companyId: c.id, startAt: 'あした' }).error, /形式/);
  assert.match(T.api('addEvent', { companyId: 'nope', startAt: '2030-01-01T10:00' }).error, /会社/);
  assert.match(T.api('deleteEvent', { id: 'nope' }).error, /予定/);
  assert.equal(T.rows('events').length, 0);
});

// ============================================================
// 引き継ぎ・分割・削除
// ============================================================

test('本選考へ引き継ぐ：パスワードとフォルダも写す。応答にパスワードは載せない', () => {
  const T = mk();
  const c = addCo(T, { term: '夏インターン', url: 'https://a', loginId: 'ida', pw: 'pwa' });
  const r = T.api('carryOver', { id: c.id });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.company.term, '本選考');
  assert.equal(r.company.stage, 'エントリー');
  assert.equal(r.company.folderUrl, c.folderUrl);
  assert.equal('pw' in r.company, false);
  assert.equal(T.rows('companies').find((x) => x.id === r.company.id).pw, 'pwa');
  assert.match(T.api('carryOver', { id: c.id }).error, /すでに/);
});

test('別の選考を足す：同じ区分・同じマイページ・同じパスワード', () => {
  const T = mk();
  const c = addCo(T, { pw: 'pwa', url: 'https://a' });
  const r = T.api('splitCompany', { id: c.id, name: 'A社（別コース）' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.company.url, 'https://a');
  assert.equal(T.rows('companies').find((x) => x.id === r.company.id).pw, 'pwa');
  assert.match(T.api('splitCompany', { id: c.id, name: 'A社' }).error, /すでに/);
});

test('削除：行・予定・カレンダーをまとめて消す。フォルダは残す。ほかの行は動かさない', () => {
  const T = mk();
  const a = addCo(T, { name: 'A社', dueAt: '2030-01-10T12:00' });
  const b = addCo(T, { name: 'B社', dueAt: '2030-01-11T12:00' });
  const c = addCo(T, { name: 'C社' });
  T.api('addEvent', { companyId: b.id, kind: '面接', startAt: '2030-01-05T10:00' });
  T.api('addEvent', { companyId: a.id, kind: '面接', startAt: '2030-01-06T10:00' });
  const r = T.api('deleteCompany', { id: b.id });
  assert.equal(r.ok, true);
  assert.deepEqual(T.rows('companies').map((x) => x.id), [a.id, c.id]);
  assert.deepEqual(T.rows('events').map((x) => x.companyId), [a.id]);
  assert.deepEqual(T.liveIn(DEV_CAL).map((e) => e.title).sort(), ['【就活】A社 (エントリー) 締め切り', '【面接】A社']);
  assert.equal(T.folders.parent_folder.children.length, 3);
  // 残った会社の書き込みが、正しい行に入る
  const up = mutate(T, c, 'setIndustry', { industry: '金融' });
  assert.equal(up.ok, true);
  assert.equal(T.rows('companies')[1].industry, '金融');
  assert.equal(T.rows('companies')[0].industry, '');
});

test('行は id で探す。同じ名前が別の区分にあっても取り違えない', () => {
  const T = mk();
  const a = addCo(T, { name: 'A社', term: '夏インターン' });
  const b = addCo(T, { name: 'A社', term: '本選考', stage: 'ES' });
  mutate(T, b, 'pass');
  const rows = T.rows('companies');
  assert.equal(rows.find((x) => x.id === a.id).stage, 'エントリー');
  assert.equal(rows.find((x) => x.id === b.id).stage, '適性検査');
});

test('ロゴだけを書く：updatedAt もカレンダーも変えない', () => {
  const T = mk();
  const c = addCo(T, { dueAt: '2030-01-10T12:00' });
  T.resetCalls();
  const r = T.api('saveLogo', { id: c.id, logo: 'https://logo/a', manual: true });
  assert.equal(r.ok, true);
  assert.equal(r.company.logo, 'https://logo/a');
  assert.equal(r.company.logoManual, true);
  assert.equal(r.company.updatedAt, c.updatedAt);
  assert.deepEqual(T.calCalls, { create: 0, update: 0, remove: 0, get: 0 });
  // 自動で探して見つからなかった印
  assert.equal(T.api('saveLogo', { id: c.id, logo: 'none', manual: false }).company.logoManual, false);
  // ロゴを保存したあとでも、手元の updatedAt のまま操作できる
  assert.equal(mutate(T, c, 'setIndustry', { industry: '金融' }).ok, true);
});

// ============================================================
// パスワード
// ============================================================

test('パスワード：押したときに1社分だけ返す。キャッシュせず、実行ログには時刻だけ残す', () => {
  const T = mk();
  const c = addCo(T, { pw: 'pwa' });
  T.api('getData', {});
  const r = T.api('getPassword', { id: c.id });
  assert.deepEqual(r, { ok: true, pw: 'pwa' });
  assert.doesNotMatch(JSON.stringify(T.cache), /pwa/);
  assert.ok(T.log.some((l) => /^getPassword：\d{4}-/.test(l)));
  assert.equal(T.log.some((l) => l.includes('pwa')), false);
  assert.equal(T.api('getPassword', { id: c.id }, 'wrong').error, 'unauthorized');
});

test('パスワード：変えられる。ほかの列と updatedAt は変えない', () => {
  const T = mk();
  const c = addCo(T, { pw: 'old' });
  assert.equal(T.api('setPassword', { id: c.id, pw: 'new' }).ok, true);
  assert.equal(T.api('getPassword', { id: c.id }).pw, 'new');
  const row = T.rows('companies')[0];
  assert.equal(row.updatedAt, c.updatedAt);
  assert.equal(row.name, 'A社');
});

test('パスワードは、カレンダー・ログ・応答のどこにも出ない', () => {
  const T = mk();
  const c = addCo(T, { pw: 'topsecret', url: 'https://a', dueAt: '2030-01-10T12:00' });
  const r1 = T.api('addEvent', { companyId: c.id, kind: '面接', startAt: '2030-01-05T10:00' });
  const r2 = mutate(T, r1.company, 'rename', { name: 'A社2' });
  const r3 = T.api('carryOver', { id: c.id });
  const all = JSON.stringify([r1, r2, r3, T.api('getData', {}), T.live().map((e) => [e.title, e.desc]), T.log, T.cache]);
  assert.equal(all.includes('topsecret'), false);
});

// ============================================================
// シートの書き方
// ============================================================

test('書く範囲は書式なしテキストにしてから書く（日付に化けないように）', () => {
  const T = mk();
  addCo(T, { dueAt: '2030-01-10T12:00' });
  const sh = T.sheet('companies');
  assert.ok(sh.formats.some((f) => f.r === 2 && f.f === '@'));
  assert.equal(sh.frozen, 1);
});

test('行が足りなければ足してから書く', () => {
  const T = mk();
  addCo(T, { name: 'A社' });
  T.sheet('companies').maxRows = 2;
  addCo(T, { name: 'B社' });
  assert.equal(T.rows('companies').length, 2);
});

test('並べ替えは一度もしない（模擬環境の sort は呼ぶとエラー）', () => {
  const T = mk();
  const c = addCo(T, { dueAt: '2030-01-10T12:00' });
  for (const op of ['done', 'reopen', 'skip', 'reopen']) {
    const r = mutate(T, T.api('getData', {}).companies[0], op);
    assert.equal(r.ok, true, op + ' ' + r.error);
  }
  assert.equal(T.rows('companies')[0].id, c.id);
});

// ============================================================
// 移行
// ============================================================

const H = ['会社名', 'URL', 'ID', 'PW', '日付', '時', '分', '段階', '状況', '登録', 'eventId', '結果日', '落ちた段階',
  '結果予定', '結果eventId', 'フォルダ', '区分', '状態', '提出日', 'ルート', 'ドメイン', '業種'];

/* 旧版のシートを作る。ids には旧版のカレンダー予定の ID を入れる */
function legacy(T, bookId, ids = {}) {
  const book = T.books[bookId];
  const d = jst('2030-01-10T00:00');
  const row = (o) => H.map((h) => (h in o ? o[h] : ''));
  const sh = new Sheet('Sheet1', [H.slice(),
    row({ 会社名: 'A社', URL: 'https://a', ID: 'ida', PW: 'pwa', 日付: d, 時: 23, 分: 59, 段階: '最終面接', 状況: '未',
      eventId: ids.due || '', 結果eventId: ids.result || '', 結果予定: jst('2030-02-01T00:00'), 区分: '夏インターン', 状態: '対応中', ドメイン: 'a.co.jp' }),
    // 旧版の名残：結果待ちに前の段階の結果日、参加決定と見送りに締切、対応中に結果日が残っている
    row({ 会社名: 'B社', 日付: '2030/02/01', 段階: 'ES', 状況: '済', 区分: '', 状態: '', 提出日: '2026/09/20', 結果日: '2026/06/30' }),
    row({ 会社名: 'C社', 段階: '面接', 状況: '選考落ち', 結果日: jst('2026-09-10T00:00'), 区分: '本選考', 状態: '落選', 業種: '金融' }),
    row({ 会社名: 'D社', 日付: d, 時: 10, 分: 0, 段階: '内定', 状況: '内定', 結果日: '2026/09/01', 区分: '夏インターン', 状態: '内定' }),
    row({ 会社名: 'E社', 段階: '内定', 区分: '本選考', 状態: '内定' }),
    row({ 会社名: 'F社', 日付: d, 段階: '面談', 区分: '本選考', 状態: '見送り', 状況: '日程削除', ルート: 'エントリー>面談>内定' }),
    row({ 会社名: 'テストセンター', 日付: d, 時: 10, 分: '', 段階: '受験', 区分: '夏インターン', 状態: '対応中' }),
    row({ 会社名: 'A社', 段階: 'エントリー', 区分: '本選考', 状態: '対応中', PW: 'pwa2', 結果日: '2026/07/23' }),
    row({})
  ]);
  sh.f['2,16'] = '=HYPERLINK("https://drive/a", "📁 フォルダを開く")';
  book.sheets.Sheet1 = sh;
  book.sheets['予定'] = new Sheet('予定', [
    ['会社名', '種別', '日時', '場所', 'eventId', 'uid', '区分', '終了', '終日', '毎日'],
    ['A社', '面接', jst('2030-01-05T10:00'), 'オンライン', ids.ev || '', 'u1', '夏インターン', '', '', ''],
    ['A社', 'インターン', jst('2030-08-01T10:00'), '', (ids.daily || []).join(','), 'u2', '夏インターン', jst('2030-08-03T17:00'), '', 'TRUE'],
    ['A社', '説明会', jst('2030-01-07T13:00'), '', '', 'u3', '本選考', '', '', ''],
    ['Z社', '面接', jst('2030-01-05T10:00'), '', '', 'u4', '夏インターン', '', '', ''],
    ['A社', '面接', '', '', '', 'u5', '夏インターン', '', '', '']
  ]);
  return { sheet: sh, before: JSON.stringify(book.sheets.Sheet1.d) + JSON.stringify(book.sheets['予定'].d) };
}

test('移行：状態・締切・フォルダ・パスワード・ルートを新しい形にする', () => {
  const T = mk();
  const { before } = legacy(T, DEV_SHEET);
  const res = T.run('migrate');
  assert.deepEqual(res, { companies: 8, events: 3, orphanEvents: 1, badEvents: 1, scrubbed: 0, carriedCalendar: false });

  const rows = T.rows('companies');
  const by = (name, term) => rows.find((r) => r.name === name && r.term === term);
  const a = by('A社', '夏インターン');
  assert.match(a.id, /^c_/);
  assert.equal(a.status, 'todo');
  assert.equal(a.dueAt, '2030-01-10T23:59');
  assert.equal(a.dueHasTime, 'TRUE');
  assert.equal(a.folderUrl, 'https://drive/a');
  assert.equal(a.pw, 'pwa');
  assert.equal(a.domain, 'a.co.jp');
  assert.deepEqual(JSON.parse(a.route), ['エントリー', 'ES', '適性検査', 'GD', '面接', '最終面接', '内定']);
  assert.deepEqual(JSON.parse(a.cal), {});

  const b = by('B社', '夏インターン');
  assert.equal(b.status, 'waiting');           // 状態が空なので I列の「済」から
  assert.equal(b.dueAt, '2030-02-01T23:59');   // 時が空ならその日いっぱい
  assert.equal(b.dueHasTime, 'FALSE');
  assert.equal(b.submittedAt, '2026-09-20');

  const c = by('C社', '本選考');
  assert.deepEqual([c.status, c.lostStage, c.resultAt, c.industry], ['failed', '面接', '2026-09-10', '金融']);
  assert.equal(by('D社', '夏インターン').status, 'joined');   // 夏インターンの「内定」は参加決定
  assert.equal(by('D社', '夏インターン').resultAt, '2026-09-01');
  assert.equal(by('E社', '本選考').status, 'offer');
  const f = by('F社', '本選考');
  assert.equal(f.status, 'skipped');
  assert.deepEqual(JSON.parse(f.route), ['エントリー', '面談', '内定']);
  const t = by('テストセンター', '夏インターン');
  assert.equal(t.kind, 'mgmt');
  assert.equal(t.dueAt, '2030-01-10T10:00');
  assert.equal(by('A社', '本選考').pw, 'pwa2');

  // 状態に合わない旧版の名残は片付ける
  assert.equal(b.resultAt, '');                                  // 結果待ちに前の結果日
  assert.equal(by('A社', '本選考').resultAt, '');                // 対応中に結果日
  assert.equal(by('D社', '夏インターン').dueAt, '');             // 参加決定に締切
  assert.equal(by('D社', '夏インターン').dueHasTime, 'FALSE');
  assert.equal(f.dueAt, '');                                     // 見送りに締切
  // 結果発表の予定日（N列）は移さない
  assert.equal(Object.keys(a).some((k) => /result(Expected|EventId)/.test(k)), false);

  const evs = T.rows('events');
  assert.deepEqual(evs.map((e) => [e.kind, e.startAt, e.endAt, e.daily]), [
    ['面接', '2030-01-05T10:00', '', 'FALSE'],
    ['インターン', '2030-08-01T10:00', '2030-08-03T17:00', 'TRUE'],
    ['説明会', '2030-01-07T13:00', '', 'FALSE']
  ]);
  assert.equal(evs[0].companyId, a.id);
  assert.equal(evs[2].companyId, by('A社', '本選考').id);   // 会社名＋区分で引く

  // 旧版のシートは書き換えない
  assert.equal(JSON.stringify(T.dev.sheets.Sheet1.d) + JSON.stringify(T.dev.sheets['予定'].d), before);
  assert.equal(T.heldLock(), false);
});

test('移行：開発中は旧版のカレンダー予定（本番のカレンダー）に一切触らない', () => {
  const T = mk();
  const cal = T.calendars[PRIMARY_CAL];
  const due = cal.createEvent('【就活】A社 (最終面接) 締め切り', jst('2030-01-10T23:59'), jst('2030-01-11T00:29'), { description: 'パスワード: pwa' });
  legacy(T, DEV_SHEET, { due: due.id, result: due.id, ev: due.id });
  T.resetCalls();
  T.run('migrate');
  assert.deepEqual(T.calCalls, { create: 0, update: 0, remove: 0, get: 0 });

  // 移行のあとで全社を合わせても、作るのは開発用カレンダーだけ
  const res = T.run('syncAllCalendars');
  assert.equal(res.left, 0);
  assert.equal(T.liveIn(PRIMARY_CAL).length, 1);
  assert.equal(due.desc, 'パスワード: pwa');
  assert.ok(T.liveIn(DEV_CAL).length > 0);
  assert.equal(T.opened.includes(PROD_SHEET), false);
});

test('移行のあと、全社のカレンダーを合わせる。2回目は何もしない', () => {
  const T = mk();
  legacy(T, DEV_SHEET);
  T.run('migrate');
  const res = T.run('syncAllCalendars');
  assert.equal(res.failed, 0);
  const titles = T.liveIn(DEV_CAL).map((e) => e.title).sort();
  // 締切は対応中の A社（夏）とテストセンターだけ。見送りの F社・結果待ちの B社は作らない
  assert.deepEqual(titles, [
    '【インターン】A社（1/3日目）', '【インターン】A社（2/3日目）', '【インターン】A社（3/3日目）',
    '【就活】A社 (最終面接) 締め切り', '【就活】テストセンター (受験) 締め切り',
    '【説明会】A社', '【面接】A社'
  ].sort());
  T.resetCalls();
  const again = T.run('syncAllCalendars');
  assert.equal(again.changed, 0);
  assert.deepEqual(T.calCalls, { create: 0, update: 0, remove: 0, get: 0 });
});

test('移行：もう行があれば止める', () => {
  const T = mk();
  legacy(T, DEV_SHEET);
  T.run('migrate');
  assert.throws(() => T.ctx.migrate(), /もう行があります/);
  assert.equal(T.heldLock(), false);
});

test('移行：旧版のロゴの記録を LEGACY_LOGOS から列へ移す', () => {
  const T = mk({ LEGACY_LOGOS: JSON.stringify({ A社: 'https://logo/a' }) });
  legacy(T, DEV_SHEET);
  T.run('migrate');
  const rows = T.rows('companies').filter((r) => r.name === 'A社');
  assert.deepEqual(rows.map((r) => r.logo), ['https://logo/a', 'https://logo/a']);
  assert.equal(rows[0].logoManual, 'FALSE');
});

const LOGOS = JSON.stringify({
  'A社': 'https://logo/a.png',
  'B社': 'https://logo/b.png',
  'C社': 'https://logo/c.png',
  'テストセンター': 'SPI３',
  '伊藤忠テクノソリューションズ': 'https://thumb.wikimedia.org/building.jpg',
  '履修データセンター': 'https://upload.wikimedia.org/campus.jpg',
  '無い社': 'https://logo/none.png'
});

test('旧版のロゴの取り込み：空か自動のものだけ上書きし、手で入れたものは残す。同じ名前の行には全部入れる', () => {
  const T = mk({ LEGACY_LOGOS: LOGOS });
  const a1 = addCo(T, { name: 'A社', term: '夏インターン' });
  const a2 = addCo(T, { name: 'A社', term: '本選考' });
  const b = addCo(T, { name: 'B社' });
  const c = addCo(T, { name: 'C社' });
  addCo(T, { name: 'テストセンター', kind: 'mgmt' });
  addCo(T, { name: '伊藤忠テクノソリューションズ' });
  T.api('saveLogo', { id: b.id, logo: 'https://auto/b.ico', manual: false });   // 画面が自動で見つけたもの
  T.api('saveLogo', { id: c.id, logo: 'https://mine/c.png', manual: true });    // 手で入れたもの

  const res = T.run('importLegacyLogos');
  assert.equal(res.updated, 3);
  assert.equal(res.kept, 1);
  const logo = (id) => T.rows('companies').find((r) => r.id === id);
  assert.equal(logo(a1.id).logo, 'https://logo/a.png');
  assert.equal(logo(a2.id).logo, 'https://logo/a.png');
  assert.equal(logo(b.id).logo, 'https://logo/b.png');
  assert.equal(logo(b.id).logoManual, 'FALSE');
  assert.equal(logo(c.id).logo, 'https://mine/c.png');
  assert.equal(T.rows('companies').find((r) => r.name === 'テストセンター').logo, '');
  assert.equal(T.rows('companies').find((r) => r.name === '伊藤忠テクノソリューションズ').logo, '');
  // 写真の会社は、行が無くても「対応しなかった」には入れない（最初から外している）
  assert.deepEqual(res.unmatched, ['無い社']);
  assert.ok(T.log.some((l) => l.includes('同じ名前の行が無かった会社：無い社')));
  assert.ok(T.log.some((l) => l.includes('テストセンター（https:// で始まらない）') && l.includes('伊藤忠テクノソリューションズ（写真なので外す）') && l.includes('履修データセンター（写真なので外す）')));
  assert.equal(T.heldLock(), false);

  // もう一度実行しても変わらない
  const again = T.run('importLegacyLogos');
  assert.deepEqual([again.updated, again.same], [0, 3]);
});

test('旧版のロゴの取り込み：updatedAt もカレンダーも変えない', () => {
  const T = mk({ LEGACY_LOGOS: LOGOS });
  const a = addCo(T, { name: 'A社', dueAt: '2030-01-10T12:00' });
  T.resetCalls();
  T.run('importLegacyLogos');
  assert.equal(T.api('getData', {}).companies[0].updatedAt, a.updatedAt);
  assert.deepEqual(T.calCalls, { create: 0, update: 0, remove: 0, get: 0 });
});

test('旧版のロゴの取り込み：JSON として読めなければ止める', () => {
  const T = mk({ LEGACY_LOGOS: '{"A社": ' });
  assert.throws(() => T.ctx.importLegacyLogos(), /JSON として読めません/);
  assert.equal(T.heldLock(), false);
});

test('パスワードの一括入力：空の行にだけ入れる。入っている行と管理用の行は触らない。ログは件数だけ', () => {
  const T = mk();
  const a = addCo(T, { name: 'A社' });
  const b = addCo(T, { name: 'B社', pw: 'keep-me' });
  const m = addCo(T, { name: 'テストセンター', kind: 'mgmt' });
  const c = addCo(T, { name: 'C社', term: '夏インターン', dueAt: '2030-01-10T12:00' });
  T.resetCalls();
  const n = T.ctx.fillEmptyPasswords_('dummy-fill');
  assert.equal(n, 2);
  const pw = (id) => T.api('getPassword', { id }).pw;
  assert.equal(pw(a.id), 'dummy-fill');
  assert.equal(pw(c.id), 'dummy-fill');
  assert.equal(pw(b.id), 'keep-me');
  assert.equal(pw(m.id), '');
  assert.ok(T.log.includes('パスワードが空だった 2 社に入れました。'));
  assert.equal(T.log.some((l) => l.includes('dummy-fill')), false);
  assert.equal(T.api('getData', {}).companies.find((x) => x.id === c.id).updatedAt, c.updatedAt);
  assert.deepEqual([T.calCalls.create, T.calCalls.update, T.calCalls.remove], [0, 0, 0]);
  assert.equal(T.heldLock(), false);
  // もう一度実行しても、入っている行は変えない
  assert.equal(T.ctx.fillEmptyPasswords_('other'), 0);
  assert.equal(pw(a.id), 'dummy-fill');
  assert.throws(() => T.ctx.fillEmptyPasswords_(''), /空/);
});

test('gas/ の中の *.local.js は git に入らない', () => {
  const ignore = fs.readFileSync(path.join(__dirname, '../../.gitignore'), 'utf8');
  assert.match(ignore, /^v2\/gas\/\*\.local\.js$/m);
});

test('移行でも同じ決まりでロゴを入れる（写真と https でない値は入れない）', () => {
  const T = mk({ LEGACY_LOGOS: JSON.stringify({ 'A社': 'https://logo/a.png', 'テストセンター': 'SPI３' }) });
  legacy(T, DEV_SHEET);
  T.run('migrate');
  assert.equal(T.rows('companies').find((r) => r.name === 'テストセンター').logo, '');
  assert.equal(T.rows('companies').find((r) => r.name === 'A社').logo, 'https://logo/a.png');
});

test('移行（本番へ切り替えるとき）：予定の ID を引き継ぎ、説明欄のパスワードを消す。作り直さない', () => {
  const T = mk({ SHEET_ID: PROD_SHEET, CALENDAR_ID: PRIMARY_CAL, ALLOW_PRODUCTION: 'yes' });
  const cal = T.calendars[PRIMARY_CAL];
  const mkEv = (title, s, e, allDay) => (allDay ? cal.createAllDayEvent : cal.createEvent)(title, jst(s), jst(e),
    { description: 'マイページURL: https://a\nID: ida\nパスワード: pwa\n現在の状況: 未' });
  const due = mkEv('【就活】A社 (最終面接) 締め切り', '2030-01-10T23:59', '2030-01-11T00:29');
  const result = mkEv('【結果待ち】A社', '2030-02-01T00:00', '2030-02-02T00:00', true);
  const ev = mkEv('【面接】A社', '2030-01-05T10:00', '2030-01-05T11:00');
  const daily = [1, 2, 3].map((n) => mkEv('【インターン】A社（' + n + '/3日目）', `2030-08-0${n}T10:00`, `2030-08-0${n}T17:00`));
  legacy(T, PROD_SHEET, { due: due.id, result: result.id, ev: ev.id, daily: daily.map((e) => e.id) });

  const res = T.run('migrate');
  assert.equal(res.carriedCalendar, true);
  assert.equal(res.scrubbed, 1);
  assert.equal(result.desc, 'マイページURL: https://a\nID: ida\n現在の状況: 未');
  assert.equal(result.alive, true);   // 結果発表の予定は消さずに残す（引き継がないだけ）

  const book = T.books[PROD_SHEET];
  const head = book.sheets.companies.d[0];
  const a = book.sheets.companies.d.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])))
    .find((r) => r.name === 'A社' && r.term === '夏インターン');
  const map = JSON.parse(a.cal);
  assert.equal(map.due.id, due.id);
  assert.equal(Object.keys(map).length, 5);

  T.resetCalls();
  T.run('syncAllCalendars');
  // 作るのは、旧版で予定が無かったテストセンターの締切と、ID の無かった本選考の説明会だけ
  assert.equal(T.calCalls.create, 2);
  for (const e of [due, ev, ...daily]) {
    assert.equal(e.alive, true);
    assert.doesNotMatch(e.desc, /パスワード/);
  }
  assert.equal(due.desc, 'マイページURL: https://a\nID: ida');
});

test('inspectCalendar は何も書き換えず、パスワードも出さない', () => {
  const T = mk();
  addCo(T, { name: 'A社', pw: 'topsecret', dueAt: '2030-01-10T12:00' });
  const before = JSON.stringify(T.sheet('companies').d);
  T.resetCalls();
  T.run('inspectCalendar');
  assert.equal(JSON.stringify(T.sheet('companies').d), before);
  assert.deepEqual([T.calCalls.create, T.calCalls.update, T.calCalls.remove], [0, 0, 0]);
  assert.ok(T.log.some((l) => l.includes('A社') && l.includes('あるべき=due') && l.includes('対応表=due')));
  assert.ok(T.log.some((l) => l === '開発用カレンダーの予定：1 件'));
  assert.equal(T.log.some((l) => l.includes('topsecret')), false);
});

function prodSetup() {
  const T = mk({ SHEET_ID: PROD_SHEET, CALENDAR_ID: PRIMARY_CAL, ALLOW_PRODUCTION: 'yes' });
  const cal = T.calendars[PRIMARY_CAL];
  const mkEv = (title, s, e) => cal.createEvent(title, jst(s), jst(e), { description: 'パスワード: pwa' });
  const due = mkEv('【就活】A社 (最終面接) 締め切り', '2030-01-10T23:59', '2030-01-11T00:29');
  const result = mkEv('【結果待ち】A社', '2030-02-01T00:00', '2030-02-01T01:00');
  const ev = mkEv('【面接】A社', '2030-01-05T10:00', '2030-01-05T11:00');
  const daily = [1, 2, 3].map((n) => mkEv('【インターン】A社（' + n + '/3日目）', `2030-08-0${n}T10:00`, `2030-08-0${n}T17:00`));
  legacy(T, PROD_SHEET, { due: due.id, result: result.id, ev: ev.id, daily: daily.map((e) => e.id) });
  return { T, legacyEvents: [due, result, ev, ...daily] };
}

test('本番で移したあと、inspectCalendar で引き継いだ予定が見つかるかを数える', () => {
  const { T } = prodSetup();
  T.run('migrate');
  T.run('inspectCalendar');
  assert.ok(T.log.includes('対応表の予定のうち、このカレンダーで見つかった 5 件、見つからない 0 件'));
  assert.equal(T.log.some((l) => l.startsWith('開発用カレンダーの予定')), false);   // 本番では全部は並べない
});

test('本番で移したあと、別のカレンダーの予定を指していたら「見つからない」に数える', () => {
  const { T, legacyEvents } = prodSetup();
  legacyEvents.forEach((e) => { e.calId = 'someone-else@gmail.com'; });
  T.run('migrate');
  T.run('inspectCalendar');
  assert.ok(T.log.includes('対応表の予定のうち、このカレンダーで見つかった 0 件、見つからない 5 件'));
});

test('切り替えを戻す：新版が作った予定だけを消し、旧版の予定は残す', () => {
  const { T, legacyEvents } = prodSetup();
  T.run('migrate');
  T.run('syncAllCalendars');
  const created = T.liveIn(PRIMARY_CAL).filter((e) => !legacyEvents.includes(e));
  assert.equal(created.length, 2);        // テストセンターの締切と、本選考の説明会
  const res = T.run('undoMigration');
  assert.deepEqual(res, { removed: 2, kept: 5, failed: 0 });
  assert.equal(created.every((e) => !e.alive), true);
  assert.equal(legacyEvents.every((e) => e.alive), true);
  assert.ok(T.log.some((l) => l.includes('companies と events の2枚のシートを手で消してください')));
  assert.equal(T.heldLock(), false);
});

test('全社の合わせ込みは時間切れの前に止まり、もう一度実行すると続きから進む', () => {
  const T = mk();
  for (let i = 0; i < 3; i++) addCo(T, { name: 'X' + i });
  const realNow = Date.now;
  let calls = 0;
  // 2社目で時間切れにする
  T.ctx.Date.now = () => realNow() + (++calls > 2 ? 300000 : 0);
  let res;
  try { res = T.run('syncAllCalendars'); } finally { T.ctx.Date.now = realNow; }
  assert.ok(res.left > 0);
  assert.ok(T.log.some((l) => l.includes('もう一度実行')));
  assert.equal(T.run('syncAllCalendars').left, 0);
});
