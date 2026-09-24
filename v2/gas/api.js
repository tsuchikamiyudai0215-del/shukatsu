/*
 * 画面から呼ぶ API。
 *
 * デプロイ設定：実行するユーザーは「自分」、アクセスできるユーザーは「全員」。
 * URL は知られても、API_KEY を知らないと全部弾かれる。
 * 鍵が URL に残らないよう、呼び出しは POST だけで受ける。
 *
 * ロックはこのルーターで1回だけ取る。各処理の中では取らない（二重に取ると、内側の解放で外側まで外れる）。
 */

var LOCK_WAIT_MS = 20000;
var CACHE_KEY = 'data';
var CACHE_SEC = 25;

/* read: 書き込まない処理。lock: false ならロックも取らない */
var ACTIONS = {
  getData:       { fn: getData_, read: true },
  getPassword:   { fn: getPassword_, read: true, lock: false },
  mutate:        { fn: mutate_ },
  saveLogo:      { fn: saveLogo_ },
  addCompany:    { fn: addCompany_ },
  carryOver:     { fn: carryOver_ },
  splitCompany:  { fn: splitCompany_ },
  deleteCompany: { fn: deleteCompany_ },
  addEvent:      { fn: addEvent_ },
  deleteEvent:   { fn: deleteEvent_ },
  setPassword:   { fn: setPassword_ }
};

function doPost(e) {
  var payload;
  try { payload = JSON.parse(e.postData.contents); }
  catch (err) { return out_(JSON.stringify({ ok: false, error: 'bad payload' })); }
  return out_(route_(payload));
}

function doGet() {
  return out_(JSON.stringify({ ok: true, service: '就活ボード API' }));
}

function out_(s) {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}

function keyOk_(key) {
  var want = prop_('API_KEY');
  if (!want || typeof key !== 'string' || key.length !== want.length) return false;
  /* 1文字ずつ全部比べる。途中で抜けると、合っている長さが時間でわかってしまう */
  var diff = 0;
  for (var i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ key.charCodeAt(i);
  return diff === 0;
}

/* 返すのは JSON の文字列。キャッシュをそのまま返せるようにするため */
function route_(payload) {
  resetRun_();
  try {
    if (!payload || !keyOk_(payload.key)) return JSON.stringify({ ok: false, error: 'unauthorized' });
    /* toString などの継承したプロパティを、関数として呼ばないようにする */
    if (!has_(ACTIONS, payload.action)) {
      return JSON.stringify({ ok: false, error: '知らない操作です：' + payload.action });
    }
    var a = ACTIONS[payload.action];
    var args = payload.args && typeof payload.args === 'object' ? payload.args : {};

    if (payload.action === 'getData') {
      var hit = cacheGet_();
      if (hit) return hit;
    }
    if (a.lock === false) return JSON.stringify(a.fn(args));

    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_WAIT_MS);
    try {
      if (payload.action === 'getData') {
        /* 待っている間に誰かが入れていれば、それを使う */
        var again = cacheGet_();
        if (again) return again;
        var fresh = JSON.stringify(a.fn(args));
        cachePut_(fresh);
        return fresh;
      }
      /* 書き込みの前に捨てる。途中で失敗しても、古い一覧を配り続けないように */
      bustCache_();
      return JSON.stringify(a.fn(args));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    if (err && err.conflict) {
      return JSON.stringify({ ok: false, conflict: true, error: err.message, company: err.company });
    }
    return JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ============================================================
// 読み取りの短期キャッシュ
// ============================================================

function cacheGet_() {
  try { return CacheService.getScriptCache().get(CACHE_KEY); } catch (e) { return null; }
}
function cachePut_(json) {
  try { CacheService.getScriptCache().put(CACHE_KEY, json, CACHE_SEC); } catch (e) { /* 100KB を超えたらあきらめる */ }
}
function bustCache_() {
  try { CacheService.getScriptCache().remove(CACHE_KEY); } catch (e) {}
}

// ============================================================
// 処理
// ============================================================

function mustFind_(id) {
  var c = companies_().find(str_(id));
  if (!c) throw new Error('会社が見つかりません。');
  return c;
}

function checkDuplicate_(name, term, exceptId) {
  if (Domain.duplicateOf(companies_().all(), name, term, exceptId)) {
    throw new Error('その名前はすでに登録されています。');
  }
}

/* カレンダーを合わせてから、会社の行を書く */
function saveWithCalendar_(c, now) {
  var evs = eventsOf_(c.id);
  var res = syncCalendar_(c, evs, now);
  c.cal = res.cal;
  companies_().write(c);
  var out = { ok: true, company: publicCompany_(c), events: evs.map(publicEvent_) };
  if (res.failed) out.warning = 'カレンダーの一部を直せませんでした。次に保存したときにもう一度試します。';
  return out;
}

function getData_() {
  return {
    ok: true,
    companies: companies_().all().map(publicCompany_),
    events: events_().all().map(publicEvent_),
    route: Domain.DEFAULT_ROUTE
  };
}

/**
 * 1社への操作。args は { id, op, args, updatedAt }。
 * updatedAt が保存済みの値と違えば書かない。スマホとPCで同時に触ったときに、
 * 後から届いた古い操作で上書きしないため。
 */
function mutate_(args) {
  var c = mustFind_(args.id);
  if (!has_(args, 'updatedAt')) throw new Error('updatedAt がありません。');
  if (str_(args.updatedAt) !== str_(c.updatedAt)) {
    var err = new Error('ほかの端末で先に書き換えられました。最新の内容を読み込みました。');
    err.conflict = true;
    err.company = publicCompany_(c);
    throw err;
  }
  var op = {};
  var given = args.args && typeof args.args === 'object' ? args.args : {};
  for (var k in given) if (has_(given, k)) op[k] = given[k];
  op.type = str_(args.op);
  if (op.type === 'rename') checkDuplicate_(op.name, c.term, c.id);

  var now = new Date();
  var next = Domain.apply(c, op, now);
  next.updatedAt = stampAfter_(c.updatedAt);
  return saveWithCalendar_(next, now);
}

function folderFor_(name) {
  try {
    var parent = driveParent_();
    var it = parent.getFoldersByName(name);
    return (it.hasNext() ? it.next() : parent.createFolder(name)).getUrl();
  } catch (e) {
    console.warn('フォルダを作れませんでした（' + name + '）：' + e);
    return '';
  }
}

function addCompany_(f) {
  f = f || {};
  var c = Domain.create(newId_('c'), f);
  checkDuplicate_(c.name, c.term, null);
  c.folderUrl = folderFor_(c.name);
  c.pw = str_(f.pw);
  c.updatedAt = nowIso_();
  return saveWithCalendar_(c, new Date());
}

/* インターンの行から本選考の行を作る。パスワードとフォルダも引き継ぐ */
function carryOver_(args) {
  var src = mustFind_(args.id);
  var c = Domain.carryOver(src, newId_('c'), args.term);
  checkDuplicate_(c.name, c.term, null);
  c.pw = src.pw;
  c.updatedAt = nowIso_();
  return saveWithCalendar_(c, new Date());
}

/* 同じマイページで別の選考を足す */
function splitCompany_(args) {
  var src = mustFind_(args.id);
  var c = Domain.split(src, newId_('c'), args.name);
  checkDuplicate_(c.name, c.term, null);
  c.pw = src.pw;
  c.updatedAt = nowIso_();
  return saveWithCalendar_(c, new Date());
}

/* 行と予定とカレンダーをまとめて消す。Drive のフォルダは書類が入っているので残す */
function deleteCompany_(args) {
  var c = mustFind_(args.id);
  var failed = removeAllCalendar_(c);
  var evIds = eventsOf_(c.id).map(function (e) { return e.id; });
  events_().removeMany(evIds);
  companies_().removeMany([c.id]);
  var out = { ok: true, id: c.id };
  if (failed) out.warning = 'カレンダーの予定を一部消せませんでした。';
  return out;
}

function addEvent_(f) {
  f = f || {};
  var c = mustFind_(f.companyId);
  var e = Domain.createEvent(newId_('e'), c.id, f);
  events_().write(e);
  return saveWithCalendar_(c, new Date());
}

function deleteEvent_(args) {
  var e = events_().find(str_(args.id));
  if (!e) throw new Error('予定が見つかりません。');
  events_().removeMany([e.id]);
  return saveWithCalendar_(mustFind_(e.companyId), new Date());
}

/**
 * ロゴだけを書く。画面は開くたびに自動でロゴを探して保存するので、
 * updatedAt を変えると、同じ端末の操作とぶつかってしまう。見た目だけの値なので、ここでは変えない。
 */
function saveLogo_(args) {
  var c = mustFind_(args.id);
  var next = Domain.apply(c, { type: 'setLogo', logo: args.logo, manual: args.manual }, new Date());
  companies_().write({ id: c.id, logo: next.logo, logoManual: next.logoManual });
  c.logo = next.logo;
  c.logoManual = next.logoManual;
  return { ok: true, company: publicCompany_(c) };
}

/* パスワードは押したときに1社分だけ返す。キャッシュもしない。呼んだ時刻だけ実行ログに残す */
function getPassword_(args) {
  var c = mustFind_(args.id);
  console.log('getPassword：' + nowIso_() + ' id=' + c.id);
  return { ok: true, pw: str_(c.pw) };
}

function setPassword_(args) {
  var c = mustFind_(args.id);
  companies_().write({ id: c.id, pw: str_(args.pw) });
  return { ok: true };
}
