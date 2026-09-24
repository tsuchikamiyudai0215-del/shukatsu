const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const D = require('../shared/domain.js');

/* 日本時間の壁時計の値から、その瞬間の Date を作る */
const jst = (s) => new Date(Date.parse(s + ':00+09:00'));
const NOW = jst('2026-09-24T12:00');

function co(over) {
  return Object.assign(D.create('c_1', { name: 'A株式会社', term: '本選考' }), over || {});
}

// ============================================================
// 読み込み方
// ============================================================

test('GAS と同じく、module が無い環境ではグローバルに Domain が1つだけ置かれる', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/domain.js'), 'utf8'), ctx);
  assert.equal(typeof ctx.Domain.apply, 'function');
  assert.deepEqual(Object.keys(ctx).filter((k) => k !== 'Domain'), []);
});

// ============================================================
// 通過・落選・結果待ちなど
// ============================================================

test('通過で次の段階へ進み、締切と提出日を消す', () => {
  const c = co({ stage: 'ES', status: 'waiting', dueAt: '2026-09-30T23:59', dueHasTime: true, submittedAt: '2026-09-20' });
  const n = D.apply(c, { type: 'pass' }, NOW);
  assert.equal(n.stage, '適性検査');
  assert.equal(n.status, 'todo');
  assert.equal(n.dueAt, '');
  assert.equal(n.dueHasTime, false);
  assert.equal(n.submittedAt, '');
  assert.equal(n.resultAt, '');
});

test('最後の手前で通過すると、本選考は内定・段階はルートの最後・結果日は今日', () => {
  const n = D.apply(co({ stage: '最終面接' }), { type: 'pass' }, NOW);
  assert.equal(n.status, 'offer');
  assert.equal(n.stage, '内定');
  assert.equal(n.resultAt, '2026-09-24');
});

test('インターンの区分は、最後まで通ると参加決定', () => {
  assert.equal(D.apply(co({ term: '夏インターン', stage: '最終面接' }), { type: 'pass' }, NOW).status, 'joined');
  assert.equal(D.apply(co({ term: '秋冬インターン', stage: '最終面接' }), { type: 'pass' }, NOW).status, 'joined');
  assert.equal(D.goalOf('本選考'), 'offer');
  assert.equal(D.goalOf(''), 'joined');
});

test('自分で組んだルートでも、最後の手前の判定はルートに合わせる', () => {
  const c = co({ route: ['エントリー', '面談', 'インターン参加'], stage: '面談' });
  assert.equal(D.isFinalStep(c), true);
  assert.equal(D.isFinalStep(co({ stage: 'ES' })), false);
  const n = D.apply(c, { type: 'pass' }, NOW);
  assert.equal(n.stage, 'インターン参加');
});

test('ルートに無い段階からは通過できない', () => {
  assert.throws(() => D.apply(co({ stage: 'メール自動検出' }), { type: 'pass' }, NOW), /ルートに今の段階がありません/);
});

test('落選は落ちた段階と結果日を記録し、締切を外す', () => {
  const n = D.apply(co({ stage: '面接', dueAt: '2026-10-01T10:00', dueHasTime: true }), { type: 'fail' }, NOW);
  assert.equal(n.status, 'failed');
  assert.equal(n.lostStage, '面接');
  assert.equal(n.resultAt, '2026-09-24');
  assert.equal(n.dueAt, '');
});

test('落選から対応中に戻すと、落ちた段階と結果日が残らない', () => {
  const failed = D.apply(co({ stage: '面接' }), { type: 'fail' }, NOW);
  const n = D.apply(failed, { type: 'reopen' }, NOW);
  assert.equal(n.status, 'todo');
  assert.equal(n.lostStage, '');
  assert.equal(n.resultAt, '');
  assert.equal(n.stage, '面接');
});

test('完了にすると結果待ちへ。提出日は今日、締切は残す', () => {
  const n = D.apply(co({ dueAt: '2026-09-30T23:59', dueHasTime: true }), { type: 'done' }, NOW);
  assert.equal(n.status, 'waiting');
  assert.equal(n.submittedAt, '2026-09-24');
  assert.equal(n.dueAt, '2026-09-30T23:59');
});

test('見送りは締切を外す。対応中に戻せる', () => {
  const n = D.apply(co({ dueAt: '2026-09-30T23:59', dueHasTime: true }), { type: 'skip' }, NOW);
  assert.equal(n.status, 'skipped');
  assert.equal(n.dueAt, '');
  assert.equal(D.apply(n, { type: 'reopen' }, NOW).status, 'todo');
});

test('参加決定にする：段階はそのまま、結果日は今日', () => {
  const n = D.apply(co({ stage: 'GD', status: 'waiting', submittedAt: '2026-09-10' }), { type: 'join' }, NOW);
  assert.equal(n.status, 'joined');
  assert.equal(n.stage, 'GD');
  assert.equal(n.resultAt, '2026-09-24');
});

test('1段階戻すと、状態・結果の記録・締切をまとめて巻き戻す', () => {
  const failed = D.apply(co({ stage: '面接' }), { type: 'fail' }, NOW);
  const n = D.apply(failed, { type: 'prev' }, NOW);
  assert.equal(n.stage, 'GD');
  assert.equal(n.status, 'todo');
  assert.equal(n.lostStage, '');
  assert.equal(n.resultAt, '');
  assert.equal(n.submittedAt, '');
  assert.throws(() => D.apply(co({ stage: 'エントリー' }), { type: 'prev' }, NOW), /これ以上前/);
});

test('内定から1段階戻すと、最後の手前に戻って対応中になる', () => {
  const offer = D.apply(co({ stage: '最終面接' }), { type: 'pass' }, NOW);
  const n = D.apply(offer, { type: 'prev' }, NOW);
  assert.equal(n.stage, '最終面接');
  assert.equal(n.status, 'todo');
  assert.equal(n.resultAt, '');
});

test('今の状態でできない操作は、画面に出せる文言で止める', () => {
  const failed = D.apply(co(), { type: 'fail' }, NOW);
  assert.throws(() => D.apply(failed, { type: 'pass' }, NOW), /通過にできません。$/);
  assert.throws(() => D.apply(failed, { type: 'done' }, NOW), /結果待ちにできません。$/);
  assert.throws(() => D.apply(co(), { type: 'reopen' }, NOW), /もう対応中です。$/);
  assert.throws(() => D.apply(co(), { type: 'toString' }, NOW), /知らない操作/);
  assert.throws(() => D.apply(co(), { type: 'nope' }, NOW), /知らない操作/);
});

test('元の会社データは書き換えない（画面で巻き戻せるように）', () => {
  const c = co({ stage: 'ES', route: ['エントリー', 'ES', '内定'], cal: { due: 'x' } });
  const before = JSON.stringify(c);
  const n = D.apply(c, { type: 'setRoute', route: ['ES', 'エントリー', '内定'] }, NOW);
  D.apply(c, { type: 'pass' }, NOW);
  assert.equal(JSON.stringify(c), before);
  n.cal.due = 'y';
  assert.equal(c.cal.due, 'x');
});

test('知らない列（updatedAt など）はそのまま残す', () => {
  const n = D.apply(co({ updatedAt: '2026-09-20T10:00', folderUrl: 'https://drive/a' }), { type: 'done' }, NOW);
  assert.equal(n.updatedAt, '2026-09-20T10:00');
  assert.equal(n.folderUrl, 'https://drive/a');
});

test('時刻を渡さないと、結果日を決める操作は止まる', () => {
  assert.throws(() => D.apply(co(), { type: 'done' }), /今の時刻/);
});

// ============================================================
// 締切
// ============================================================

test('締切を入れる・時刻なしはその日いっぱい・空で外す', () => {
  let n = D.apply(co(), { type: 'setDue', dueAt: '2026-10-03T15:30' }, NOW);
  assert.equal(n.dueAt, '2026-10-03T15:30');
  assert.equal(n.dueHasTime, true);
  n = D.apply(n, { type: 'setDue', dueAt: '2026-10-05' }, NOW);
  assert.equal(n.dueAt, '2026-10-05T23:59');
  assert.equal(n.dueHasTime, false);
  n = D.apply(n, { type: 'setDue', dueAt: '' }, NOW);
  assert.equal(n.dueAt, '');
});

test('ありえない日時は弾く', () => {
  for (const v of ['2026-02-30T10:00', '2026-10-03T24:00', '2026/10/03', 'あした']) {
    assert.throws(() => D.apply(co(), { type: 'setDue', dueAt: v }, NOW), /形式/, v);
  }
});

test('締切を過ぎた対応中は結果待ちに見せる（保存はそのまま）', () => {
  const c = co({ dueAt: '2026-10-03T23:59', dueHasTime: true });
  assert.equal(D.viewStatus(c, jst('2026-10-03T23:58')), 'todo');
  assert.equal(D.viewStatus(c, jst('2026-10-03T23:59')), 'waiting');
  assert.equal(D.isAutoSent(c, jst('2026-10-04T00:00')), true);
  assert.equal(c.status, 'todo');
  // 見送りや結果待ちは締切に関係なくそのまま
  assert.equal(D.viewStatus(co({ status: 'skipped', dueAt: '2026-01-01T00:00' }), NOW), 'skipped');
  assert.equal(D.isAutoSent(co({ status: 'waiting', dueAt: '2026-01-01T00:00' }), NOW), false);
  // 状態が空の行は対応中として扱う
  assert.equal(D.viewStatus(co({ status: '' }), NOW), 'todo');
});

test('締切の判定は日本時間で行い、端末の時計の地域に左右されない', () => {
  const c = co({ dueAt: '2026-10-03T09:00', dueHasTime: true });
  // 2026-10-03 00:00 UTC は日本時間の 09:00
  assert.equal(D.viewStatus(c, new Date('2026-10-02T23:59:59Z')), 'todo');
  assert.equal(D.viewStatus(c, new Date('2026-10-03T00:00:00Z')), 'waiting');
  assert.equal(D.today(new Date('2026-09-24T15:00:00Z')), '2026-09-25');
});

test('結果待ちの経過日数は、提出日が無ければ締切日から数える', () => {
  assert.equal(D.waitingSince(co({ submittedAt: '2026-09-20', dueAt: '2026-09-01T23:59' })), '2026-09-20');
  assert.equal(D.waitingSince(co({ dueAt: '2026-09-01T23:59' })), '2026-09-01');
  assert.equal(D.daysSince('2026-09-20', NOW), 4);
  assert.equal(D.daysSince('2026-09-30', NOW), 0);
  assert.equal(D.daysSince('', NOW), null);
});

// ============================================================
// 選考ルート
// ============================================================

test('ルートの並べ替え・現在地の付け替え', () => {
  let n = D.apply(co({ stage: 'ES' }), { type: 'setRoute', route: ['エントリー', 'ES', '独自面談', '内定'] }, NOW);
  assert.deepEqual(n.route, ['エントリー', 'ES', '独自面談', '内定']);
  n = D.apply(n, { type: 'setRoute', route: n.route, stage: '独自面談' }, NOW);
  assert.equal(n.stage, '独自面談');
});

test('落選中に現在地を付け替えると、落ちた段階も合わせて動く', () => {
  const failed = D.apply(co({ stage: '面接' }), { type: 'fail' }, NOW);
  const n = D.apply(failed, { type: 'setRoute', route: D.routeOf(failed), stage: 'GD' }, NOW);
  assert.equal(n.stage, 'GD');
  assert.equal(n.lostStage, 'GD');
});

test('ルートは2段階以上・現在地は消せない・空や重複は弾く', () => {
  const c = co({ stage: 'ES' });
  assert.throws(() => D.apply(c, { type: 'setRoute', route: ['ES'] }, NOW), /2つ以上/);
  assert.throws(() => D.apply(c, { type: 'setRoute', route: ['エントリー', '内定'] }, NOW), /外せません/);
  assert.throws(() => D.apply(c, { type: 'setRoute', route: ['ES', ' ', '内定'] }, NOW), /空/);
  assert.throws(() => D.apply(c, { type: 'setRoute', route: ['ES', 'ES', '内定'] }, NOW), /同じ段階/);
  assert.throws(() => D.apply(c, { type: 'setRoute', route: ['ES', '内定'], stage: '面接' }, NOW), /ルートに無い/);
});

test('今の段階がもともとルートに無い行は、ルートを直しても止めない', () => {
  const n = D.apply(co({ stage: 'メール自動検出' }), { type: 'setRoute', route: ['ES', '内定'] }, NOW);
  assert.deepEqual(n.route, ['ES', '内定']);
});

test('ルートが空なら既定のルートを使う', () => {
  assert.deepEqual(D.routeOf({ route: [] }), D.DEFAULT_ROUTE);
  assert.deepEqual(D.routeOf({}), D.DEFAULT_ROUTE);
  D.routeOf({}).push('x');
  assert.equal(D.DEFAULT_ROUTE.includes('x'), false);
});

// ============================================================
// そのほかの書き換え
// ============================================================

test('マイページ・業種・ドメイン・ロゴ・改名', () => {
  let n = D.apply(co(), { type: 'setInfo', url: ' https://a.example/ ', loginId: ' id1 ' }, NOW);
  assert.equal(n.url, 'https://a.example/');
  assert.equal(n.loginId, 'id1');
  assert.throws(() => D.apply(co(), { type: 'setInfo', url: 'javascript:alert(1)' }, NOW), /https:\/\//);
  n = D.apply(n, { type: 'setIndustry', industry: ' NTT系 ' }, NOW);
  assert.equal(n.industry, 'NTT系');
  n = D.apply(n, { type: 'setDomain', domain: 'a.co.jp' }, NOW);
  assert.equal(n.domain, 'a.co.jp');
  n = D.apply(n, { type: 'setLogo', logo: 'https://logo', manual: true }, NOW);
  assert.equal(n.logoManual, true);
  n = D.apply(n, { type: 'setLogo', logo: '', manual: true }, NOW);
  assert.equal(n.logoManual, false);
  n = D.apply(n, { type: 'rename', name: ' A社（新） ' }, NOW);
  assert.equal(n.name, 'A社（新）');
  assert.throws(() => D.apply(n, { type: 'rename', name: '  ' }, NOW), /空/);
});

// ============================================================
// 会社を作る
// ============================================================

test('追加：既定の値と、URL・ID・ドメイン・段階・締切', () => {
  const c = D.create('c_9', { name: ' D社 ', term: '本選考', url: 'https://d', loginId: 'x', domain: 'd.jp', stage: 'ES', dueAt: '2030-01-01T09:30' });
  assert.equal(c.name, 'D社');
  assert.equal(c.kind, 'company');
  assert.equal(c.status, 'todo');
  assert.equal(c.stage, 'ES');
  assert.deepEqual(c.route, D.DEFAULT_ROUTE);
  assert.equal(c.dueAt, '2030-01-01T09:30');
  assert.equal(c.dueHasTime, true);
  assert.equal(D.create('c_8', { name: 'E社' }).term, '夏インターン');
  assert.equal(D.create('c_7', { name: 'テストセンター', kind: 'mgmt' }).kind, 'mgmt');
  assert.throws(() => D.create('c_6', { name: '' }), /空/);
  assert.throws(() => D.create('', { name: 'F社' }), /ID/);
});

test('状態に合わない値を片付ける（旧版の名残）', () => {
  const junk = { submittedAt: '2026-09-01', resultAt: '2026-07-23', lostStage: 'ES', dueAt: '2026-10-01T10:00', dueHasTime: true };
  const n = (status) => D.normalize(co(Object.assign({ status, stage: '面接' }, junk)));
  assert.deepEqual(pick(n('todo')), ['todo', '', '', '', '2026-10-01T10:00', true]);
  assert.deepEqual(pick(n('waiting')), ['waiting', '2026-09-01', '', '', '2026-10-01T10:00', true]);
  assert.deepEqual(pick(n('joined')), ['joined', '2026-09-01', '2026-07-23', '', '', false]);
  assert.deepEqual(pick(n('offer')), ['offer', '2026-09-01', '2026-07-23', '', '', false]);
  assert.deepEqual(pick(n('failed')), ['failed', '2026-09-01', '2026-07-23', 'ES', '', false]);
  assert.deepEqual(pick(n('skipped')), ['skipped', '2026-09-01', '', '', '', false]);
  assert.equal(D.normalize(co({ status: 'failed', stage: 'GD', lostStage: '' })).lostStage, 'GD');
  assert.equal(D.normalize(co({ status: '' })).status, 'todo');
  assert.equal(D.normalize(co({ dueAt: '', dueHasTime: true })).dueHasTime, false);
  function pick(c) { return [c.status, c.submittedAt, c.resultAt, c.lostStage, c.dueAt, c.dueHasTime]; }
});

test('片付けたあとの値は、操作で作る値と食い違わない', () => {
  const base = co({ stage: 'ES', dueAt: '2026-10-01T10:00', dueHasTime: true });
  for (const type of ['pass', 'fail', 'done', 'skip', 'join']) {
    const after = D.apply(base, { type }, NOW);
    assert.deepEqual(D.normalize(after), after, type);
  }
  const failed = D.apply(base, { type: 'fail' }, NOW);
  assert.deepEqual(D.normalize(D.apply(failed, { type: 'reopen' }, NOW)), D.apply(failed, { type: 'reopen' }, NOW));
});

test('同じ区分の重複を見つける。改名中の本人は除く', () => {
  const list = [co({ id: 'a', name: 'A社', term: '本選考' }), co({ id: 'b', name: 'B社', term: '夏インターン' })];
  assert.equal(D.duplicateOf(list, ' A社 ', '本選考').id, 'a');
  assert.equal(D.duplicateOf(list, 'A社', '夏インターン'), null);
  assert.equal(D.duplicateOf(list, 'A社', '本選考', 'a'), null);
  assert.equal(D.duplicateOf(list, 'B社', '').id, 'b');
});

test('本選考へ引き継ぐ：会社情報とフォルダを写し、選考はエントリーから', () => {
  const src = co({ term: '夏インターン', stage: '内定', status: 'joined', url: 'https://a', loginId: 'ida',
    domain: 'a.co.jp', industry: '金融', logo: 'L', folderUrl: 'https://drive/a', route: ['エントリー', 'GD', '内定'], pw: 'secret' });
  const n = D.carryOver(src, 'c_2');
  assert.equal(n.id, 'c_2');
  assert.equal(n.term, '本選考');
  assert.equal(n.stage, 'エントリー');
  assert.equal(n.status, 'todo');
  assert.equal(n.loginId, 'ida');
  assert.equal(n.folderUrl, 'https://drive/a');
  assert.deepEqual(n.route, D.DEFAULT_ROUTE);
  assert.equal('pw' in n, false);
  assert.throws(() => D.carryOver(co({ term: '本選考' }), 'c_3'), /同じ区分/);
});

test('別の選考を足す：同じ区分・同じマイページ・同じルート', () => {
  const src = co({ url: 'https://a', route: ['説明会', 'ES', '内定'], stage: 'ES', folderUrl: 'https://drive/a' });
  const n = D.split(src, 'c_4', 'A社（別コース）');
  assert.equal(n.term, src.term);
  assert.equal(n.url, 'https://a');
  assert.deepEqual(n.route, ['説明会', 'ES', '内定']);
  assert.equal(n.stage, '説明会');
  assert.equal(n.folderUrl, 'https://drive/a');
});

// ============================================================
// カレンダー
// ============================================================

test('締切の予定：時刻ありは30分枠、通知は4日前と2日前。パスワードは書かない', () => {
  const c = co({ name: 'A社', stage: 'ES', url: 'https://a', loginId: 'ida', pw: 'secret',
    dueAt: '2026-10-03T23:59', dueHasTime: true });
  const [d] = D.desiredCalendar(c, []);
  assert.equal(d.key, 'due');
  assert.equal(d.allDay, false);
  assert.equal(d.start, '2026-10-03T23:59');
  assert.equal(d.end, '2026-10-04T00:29');
  assert.deepEqual(d.reminders, [5760, 2880]);
  assert.match(d.title, /A社/);
  assert.match(d.description, /https:\/\/a/);
  assert.match(d.description, /ida/);
  assert.doesNotMatch(JSON.stringify(d), /secret|パスワード/);
});

test('締切の予定：時刻なしは終日（終わりは翌日）', () => {
  const [d] = D.desiredCalendar(co({ dueAt: '2026-12-31T23:59', dueHasTime: false }), []);
  assert.equal(d.allDay, true);
  assert.equal(d.start, '2026-12-31');
  assert.equal(d.end, '2027-01-01');
});

test('締切の予定は対応中のときだけ。見送り・落選・結果待ち・通過で消える', () => {
  const c = co({ stage: 'ES', dueAt: '2026-10-03T23:59', dueHasTime: true });
  const keys = (x) => D.desiredCalendar(x, []).map((i) => i.key);
  assert.deepEqual(keys(c), ['due']);
  for (const type of ['skip', 'fail', 'done', 'pass']) {
    assert.deepEqual(keys(D.apply(c, { type }, NOW)), [], type);
  }
  // 結果待ちから対応中に戻すと、残しておいた締切の予定が戻る
  assert.deepEqual(keys(D.apply(D.apply(c, { type: 'done' }, NOW), { type: 'reopen' }, NOW)), ['due']);
});

test('予定：単発は開始から1時間（終わりが無いとき）、通知は前日と1時間前', () => {
  const c = co({ id: 'c_1', name: 'A社', url: 'https://a' });
  const items = D.desiredCalendar(c, [
    { id: 'e1', companyId: 'c_1', kind: '面接', startAt: '2026-10-01T10:00', place: 'オンライン' },
    { id: 'e2', companyId: 'c_1', kind: '説明会', startAt: '2026-10-02T13:00', endAt: '2026-10-02T15:00' },
    { id: 'e3', companyId: 'c_other', kind: '面接', startAt: '2026-10-01T10:00' }
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.key), ['ev:e1', 'ev:e2']);
  assert.equal(items[0].title, '【面接】A社');
  assert.equal(items[0].end, '2026-10-01T11:00');
  assert.equal(items[0].description, 'オンライン\nマイページ: https://a');
  assert.deepEqual(items[0].reminders, [1440, 60]);
  assert.equal(items[1].end, '2026-10-02T15:00');
});

test('予定：終日は終わりの翌日まで、通知は前日だけ', () => {
  const [a] = D.desiredCalendar(co(), [{ id: 'e', companyId: 'c_1', kind: 'インターン', startAt: '2026-10-01T00:00', endAt: '2026-10-03T00:00', allDay: true }]);
  assert.equal(a.allDay, true);
  assert.equal(a.start, '2026-10-01');
  assert.equal(a.end, '2026-10-04');
  assert.deepEqual(a.reminders, [1440]);
});

test('予定：連日は日ごとに別の予定。初日だけ前日にも通知', () => {
  const items = D.desiredCalendar(co({ name: 'A社' }), [{ id: 'e', companyId: 'c_1', kind: 'インターン',
    startAt: '2026-08-01T10:00', endAt: '2026-08-03T17:00', daily: true }]);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.key), ['ev:e#0', 'ev:e#1', 'ev:e#2']);
  assert.equal(items[1].start, '2026-08-02T10:00');
  assert.equal(items[1].end, '2026-08-02T17:00');
  assert.equal(items[2].title, '【インターン】A社（3/3日目）');
  assert.deepEqual(items[0].reminders, [1440, 60]);
  assert.deepEqual(items[1].reminders, [60]);
});

test('予定：連日は最大60日。終わりの時刻が開始より前なら1時間枠', () => {
  const items = D.desiredCalendar(co(), [{ id: 'e', companyId: 'c_1', kind: 'インターン',
    startAt: '2026-01-01T18:00', endAt: '2026-12-31T09:00', daily: true }]);
  assert.equal(items.length, 60);
  assert.equal(items[0].end, '2026-01-01T19:00');
});

test('見送り・落選では、これから先の予定だけを外し、終わった予定は残す', () => {
  const events = [
    { id: 'past', companyId: 'c_1', kind: '説明会', startAt: '2026-09-20T10:00' },
    { id: 'now', companyId: 'c_1', kind: '面接', startAt: '2026-09-24T11:30', endAt: '2026-09-24T12:30' },
    { id: 'future', companyId: 'c_1', kind: '面接', startAt: '2026-10-01T10:00' },
    { id: 'daily', companyId: 'c_1', kind: 'インターン', startAt: '2026-09-23T10:00', endAt: '2026-09-25T17:00', daily: true },
    { id: 'allday', companyId: 'c_1', kind: 'インターン', startAt: '2026-09-23T00:00', allDay: true }
  ];
  const keys = (c) => D.desiredCalendar(c, events, NOW).map((i) => i.key);
  const all = ['ev:past', 'ev:now', 'ev:future', 'ev:daily#0', 'ev:daily#1', 'ev:daily#2', 'ev:allday'];
  assert.deepEqual(keys(co()), all);
  for (const type of ['skip', 'fail']) {
    const closed = D.apply(co(), { type }, NOW);
    // 開催中（12:30 まで）と、連日の今日・あしたの分は外れる
    assert.deepEqual(keys(closed), ['ev:past', 'ev:daily#0', 'ev:allday'], type);
    assert.deepEqual(keys(D.apply(closed, { type: 'reopen' }, NOW)), all, type);
  }
  // 結果待ちや内定では予定をそのまま残す
  assert.deepEqual(keys(co({ status: 'waiting' })), all);
  assert.deepEqual(keys(co({ status: 'offer' })), all);
});

test('予定の入力をそろえる', () => {
  const e = D.createEvent('e1', 'c_1', { kind: ' 面接 ', startAt: '2026-10-01T10:00', endAt: '2026-10-01T09:00', daily: true, place: ' 本社 ' });
  assert.deepEqual(e, { id: 'e1', companyId: 'c_1', kind: '面接', startAt: '2026-10-01T10:00', endAt: '', allDay: false, daily: false, place: '本社' });
  const a = D.createEvent('e2', 'c_1', { startAt: '2026-10-01', endAt: '2026-10-03', allDay: true, daily: true });
  assert.equal(a.kind, '予定');
  assert.equal(a.startAt, '2026-10-01T00:00');
  assert.equal(a.endAt, '2026-10-03T00:00');
  assert.equal(a.daily, false);
  assert.equal(D.createEvent('e3', 'c_1', { startAt: '2026-10-01T10:00', endAt: '2026-10-03T17:00', daily: true }).daily, true);
  assert.throws(() => D.createEvent('e4', 'c_1', { startAt: '' }), /形式/);
  assert.throws(() => D.createEvent('e5', 'c_1', { startAt: '2026-10-01T10:00', endAt: 'x' }), /終わり/);
  assert.throws(() => D.createEvent('e6', '', { startAt: '2026-10-01T10:00' }), /会社/);
});

test('予定：開始が読めないものは置かない', () => {
  assert.deepEqual(D.desiredCalendar(co(), [{ id: 'e', companyId: 'c_1', startAt: '' }]), []);
});

test('差分：無いものは作り、違うものは直し、要らないものは消す', () => {
  const c = co({ dueAt: '2026-10-03T23:59', dueHasTime: true });
  const events = [{ id: 'e1', companyId: 'c_1', kind: '面接', startAt: '2026-10-01T10:00' }];
  const want = D.desiredCalendar(c, events);
  const res = D.calendarDiff(want, {
    due: { id: 'g1', sig: D.calendarSig(want[0]) },   // 同じ中身
    'ev:e1': 'g2',                                     // 中身がわからない
    'ev:old': 'g3'                                     // もう要らない
  });
  assert.deepEqual(res.keep, [{ key: 'due', id: 'g1' }]);
  assert.deepEqual(res.update.map((u) => u.id), ['g2']);
  assert.deepEqual(res.remove, [{ key: 'ev:old', id: 'g3' }]);
  assert.deepEqual(res.create, []);

  // 見送りにすると、締切とこれから先の面接は消す側に回る
  const skipped = D.apply(c, { type: 'skip' }, NOW);
  const res2 = D.calendarDiff(D.desiredCalendar(skipped, events, NOW), { due: 'g1', 'ev:e1': 'g2' });
  assert.deepEqual(res2.remove, [{ key: 'due', id: 'g1' }, { key: 'ev:e1', id: 'g2' }]);
  assert.deepEqual(D.calendarDiff(want, {}).create.length, 2);
});

test('差分：改名すると見出しが変わるので直す側に入る', () => {
  const c = co({ name: 'A社', dueAt: '2026-10-03T23:59', dueHasTime: true });
  const before = D.desiredCalendar(c, []);
  const after = D.desiredCalendar(D.apply(c, { type: 'rename', name: 'A社（新）' }, NOW), []);
  const res = D.calendarDiff(after, { due: { id: 'g1', sig: D.calendarSig(before[0]) } });
  assert.equal(res.update.length, 1);
});

test('指紋は通知の順番に左右されない', () => {
  const a = { title: 't', start: '2026-01-01', end: '2026-01-02', allDay: true, reminders: [60, 1440] };
  assert.equal(D.calendarSig(a), D.calendarSig(Object.assign({}, a, { reminders: [1440, 60] })));
});

// ============================================================
// 社名と業種
// ============================================================

test('社名の短縮：法人格と全角英数を落とす', () => {
  assert.equal(D.shortName('株式会社ＮＴＴデータ'), 'NTTデータ');
  assert.equal(D.shortName('（株）日立製作所'), '日立製作所');
  assert.equal(D.shortName('ソニー(株)'), 'ソニー');
  assert.equal(D.shortName('株式会社'), '株式会社');
  assert.equal(D.shortName(null), '');
});

test('業種の推定：細かい方を先に当てる。手で入れた業種が優先', () => {
  assert.equal(D.industryOf('株式会社NTTデータ'), 'IT・SIer');
  assert.equal(D.industryOf('NTT東日本'), '通信');
  assert.equal(D.industryOf('三菱UFJ銀行'), '金融');
  assert.equal(D.industryOf('日本航空（JAL）'), '航空・運輸');
  assert.equal(D.industryOf('謎の会社'), 'その他');
  assert.equal(D.industryFor({ name: '三菱UFJ銀行', industry: 'メガバンク' }), 'メガバンク');
  assert.equal(D.industryFor({ name: '三菱UFJ銀行', industry: ' ' }), '金融');
});

// ============================================================
// 記録タブ
// ============================================================

function sample() {
  const mk = (id, over) => Object.assign(D.create(id, { name: id, term: '本選考' }), over);
  return [
    mk('A銀行', { stage: '面接', status: 'failed', lostStage: '面接' }),                                // エントリー〜GD 通過、面接で落選
    mk('B銀行', { stage: '内定', status: 'offer' }),                                                   // 最後まで
    mk('C商事', { stage: 'ES', status: 'waiting', submittedAt: '2026-09-14' }),                         // 結果待ち 10日
    mk('Dシステム', { stage: 'ES', status: 'todo', dueAt: '2026-09-20T23:59', dueHasTime: true }),      // 締切経過で結果待ち
    mk('E社', { stage: 'エントリー', status: 'skipped' }),                                              // 数えない
    mk('F社', { stage: '面接', status: 'failed', lostStage: '面接', industry: '金融' }),
    mk('テストセンター', { kind: 'mgmt', stage: 'ES' })                                                  // 管理用は数えない
  ];
}

test('記録：社数・通過数・進行中・終了・見送り', () => {
  const t = D.tally(sample(), NOW);
  assert.equal(t.entered, 5);
  assert.equal(t.skipped, 1);
  assert.equal(t.failed, 2);
  assert.equal(t.live, 3);
  // A:4 + B:7 + C:1 + D:1 + F:4 = 17
  assert.equal(t.passes, 17);
  assert.deepEqual(t.breakdown, { todo: 0, waiting: 2, joined: 0, offer: 1 });
});

test('記録：段階別の通過率と、一番多く終わった段階', () => {
  const t = D.tally(sample(), NOW);
  const s = Object.fromEntries(t.stages.map((x) => [x.stage, x]));
  assert.deepEqual(t.stages.map((x) => x.stage), D.DEFAULT_ROUTE);
  assert.deepEqual([s['面接'].pass, s['面接'].fail, s['面接'].rate], [1, 2, 33]);
  assert.deepEqual([s['ES'].pass, s['ES'].wait, s['ES'].rate], [3, 2, 100]);
  assert.equal(s['内定'].rate, 100);
  assert.deepEqual(t.worst, { stage: '面接', count: 2, share: 100 });
});

test('記録：最も進んだ段階はルート内の割合で比べる', () => {
  const t = D.tally(sample(), NOW);
  assert.deepEqual(t.deepest, { stage: '内定', rate: 100 });
  const short = D.tally([Object.assign(D.create('x', { name: 'X' }), { route: ['ES', '面談', '内定'], stage: '面談' }),
    Object.assign(D.create('y', { name: 'Y' }), { stage: '面接' })], NOW);
  // 3段階中の2つ目（50%）より、7段階中の5つ目（67%）の方が進んでいる
  assert.deepEqual(short.deepest, { stage: '面接', rate: 67 });
});

test('記録：結果待ちの件数・平均・最長（締切経過の行は締切日から数える）', () => {
  const t = D.tally(sample(), NOW);
  assert.equal(t.waiting.count, 2);
  assert.equal(t.waiting.avg, 7);   // (10 + 4) / 2
  assert.deepEqual(t.waiting.longest, { name: 'C商事', days: 10 });
});

test('記録：業界別は社を単位に、決着した社のうち決定まで行った割合', () => {
  const t = D.tally(sample(), NOW);
  const fin = t.industries.find((x) => x.name === '金融');
  assert.deepEqual([fin.count, fin.got, fin.fail, fin.live, fin.rate], [3, 1, 2, 0, 33]);
  // (4/6 + 1 + 4/6) / 3 = 78%
  assert.equal(fin.reach, 78);
  assert.equal(t.industries[0].name, '金融');
});

test('記録：業界は件数の多い順、「その他」は多くても最後', () => {
  const mk = (id) => D.create(id, { name: id });
  const t = D.tally([mk('謎1'), mk('謎2'), mk('謎3'), mk('X銀行')], NOW);
  assert.deepEqual(t.industries.map((x) => x.name), ['金融', 'その他']);
});

test('記録：業界×段階は結果が出たものだけ数える', () => {
  const t = D.tally(sample(), NOW);
  const fin = t.industryStages.find((x) => x.name === '金融');
  const s = Object.fromEntries(fin.stages.map((x) => [x.stage, x]));
  assert.deepEqual([s['面接'].pass, s['面接'].fail, s['面接'].rate], [1, 2, 33]);
  // C商事（商社）は ES が結果待ちなので、通過したエントリーだけが出る
  const trade = t.industryStages.find((x) => x.name === '商社');
  assert.deepEqual(trade.stages.map((x) => x.stage), ['エントリー']);
});

test('記録：ルートに無い段階も数え、既定の段階の後ろに並べる', () => {
  const t = D.tally([Object.assign(D.create('x', { name: 'X' }), { stage: '独自面談', status: 'failed', lostStage: '独自面談' })], NOW);
  assert.deepEqual(t.stages.map((x) => [x.stage, x.fail]), [['独自面談', 1]]);
  assert.deepEqual(t.worst, { stage: '独自面談', count: 1, share: 100 });
});

test('記録：0件でも落ちない', () => {
  const t = D.tally([], NOW);
  assert.equal(t.entered, 0);
  assert.equal(t.deepest, null);
  assert.equal(t.worst, null);
  assert.equal(t.waiting.longest, null);
  assert.deepEqual(t.industries, []);
});
