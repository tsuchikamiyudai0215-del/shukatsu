/*
 * 旧版のシート（Sheet1 と 予定）を、新しい companies と events に移す。エディタから実行する。
 *
 * ・旧版のシートは書き換えない。うまくいかなかったら、新しい2枚を消せばやり直せる。
 * ・旧版は I列と「状態」列の2か所で状態を持っていた。画面に出ていたのは「状態」列なので、
 *   そちらを優先し、空のときだけ I列から決める。
 * ・状態に合わない値（対応中の結果日、参加決定の締切など）は Domain.normalize で片付ける。
 * ・パスワード（D列）は pw 列へ移す。
 * ・結果発表の予定日（N列）は機能ごと外したので移さない。
 * ・今あるカレンダー予定の ID は、本番に切り替えるとき（ALLOW_PRODUCTION=yes）だけ引き継ぐ。
 *   開発用シートは本番のコピーなので、中の ID は本番のカレンダーの予定を指している。
 *   開発中にそれを引き継ぐと本番の予定に触ってしまうので、捨てて新しく作る。
 */

var LEGACY_SHEET = 'Sheet1';
var LEGACY_EVENTS = '予定';
var LEGACY_TERM = '夏インターン';
/* 旧版の固定列（1始まり） */
var LEGACY_COL = {
  name: 1, url: 2, loginId: 3, pw: 4, date: 5, hour: 6, minute: 7,
  stage: 8, oldStatus: 9, eventId: 11, resultAt: 12, lostStage: 13, resultEventId: 15, folder: 16
};
/* 旧版は会社名で管理用の行を見分けていた */
var LEGACY_MGMT_NAMES = ['テストセンター', 'テストセンター受験', 'Webテスト'];

function migrate() {
  resetRun_();
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    var res = migrate_();
    bustCache_();
    console.log('移行しました：会社 ' + res.companies + ' 件、予定 ' + res.events + ' 件' +
      (res.orphanEvents ? '、会社が見つからない予定 ' + res.orphanEvents + ' 件（移していません）' : '') +
      (res.badEvents ? '、日時が読めない予定 ' + res.badEvents + ' 件（移していません）' : '') +
      (res.carriedCalendar ? '。カレンダー予定の ID を引き継ぎました。' : '。カレンダー予定は引き継がず、syncAllCalendars で作ります。'));
    return res;
  } finally {
    lock.releaseLock();
  }
}

function migrate_() {
  var ss = spreadsheet_();
  var old = ss.getSheetByName(LEGACY_SHEET);
  if (!old) throw new Error('旧版のシート「' + LEGACY_SHEET + '」が見つかりません。');
  var ct = companies_(), et = events_();
  if (ct.all().length || et.all().length) {
    throw new Error('companies か events にもう行があります。やり直すときは、その2枚のシートを消してから実行してください。');
  }

  var tz = ss.getSpreadsheetTimeZone();
  var carry = allowProduction_();
  var logos = legacyLogoMap_().map;
  var now = nowIso_();
  var res = { companies: 0, events: 0, orphanEvents: 0, badEvents: 0, scrubbed: 0, carriedCalendar: carry };

  // ---------- 会社 ----------
  var head = legacyHead_(old);
  var last = old.getLastRow();
  var width = Math.max(old.getLastColumn(), LEGACY_COL.folder);
  var rows = last >= 2 ? old.getRange(2, 1, last - 1, width).getValues() : [];
  var formulas = last >= 2 ? old.getRange(2, LEGACY_COL.folder, last - 1, 1).getFormulas() : [];
  var at = function (r, n) { return r[n - 1]; };
  var byHead = function (r, h) { return head[h] ? r[head[h] - 1] : ''; };

  var byKey = {};
  var list = [];
  rows.forEach(function (r, i) {
    var name = str_(at(r, LEGACY_COL.name)).trim();
    if (!name) return;
    var term = str_(byHead(r, '区分')).trim() || LEGACY_TERM;
    var status = legacyStatus_(byHead(r, '状態'), at(r, LEGACY_COL.oldStatus), term);
    var stage = str_(at(r, LEGACY_COL.stage)).trim();
    var route = str_(byHead(r, 'ルート')).split('>').map(function (s) { return s.trim(); }).filter(String);
    var lost = str_(at(r, LEGACY_COL.lostStage)).trim();
    var due = legacyDue_(at(r, LEGACY_COL.date), at(r, LEGACY_COL.hour), at(r, LEGACY_COL.minute), tz);
    var fm = str_(formulas[i] && formulas[i][0]).match(/HYPERLINK\(\s*"([^"]+)"/i);

    var c = {
      id: newId_('c'),
      kind: LEGACY_MGMT_NAMES.indexOf(name) >= 0 ? 'mgmt' : 'company',
      name: name,
      term: term,
      status: status,
      stage: stage,
      route: route.length >= 2 ? route : Domain.DEFAULT_ROUTE.slice(),
      lostStage: lost,
      dueAt: due.dueAt,
      dueHasTime: due.dueHasTime,
      submittedAt: legacyWall_(byHead(r, '提出日'), tz, false),
      resultAt: legacyWall_(at(r, LEGACY_COL.resultAt), tz, false),
      url: str_(at(r, LEGACY_COL.url)).trim(),
      loginId: str_(at(r, LEGACY_COL.loginId)).trim(),
      pw: str_(at(r, LEGACY_COL.pw)),
      domain: str_(byHead(r, 'ドメイン')).trim(),
      industry: str_(byHead(r, '業種')).trim(),
      logo: str_(logos[name]),
      logoManual: false,
      folderUrl: fm ? fm[1] : '',
      cal: {},
      updatedAt: now
    };
    /* 旧版は状態を変えても前の結果日や締切が残ることがあったので、状態に合わせて片付ける */
    c = Domain.normalize(c);

    if (carry) {
      var dueId = str_(at(r, LEGACY_COL.eventId)).trim();
      if (dueId) c.cal.due = { id: dueId, sig: '' };   // sig が空なので、次に合わせるときに中身を書き直す
      /* 結果発表の予定は引き継がない。パスワードが書いてあるので、説明欄からそこだけ消す */
      var resultId = str_(at(r, LEGACY_COL.resultEventId)).trim();
      if (resultId && scrubPassword_(resultId)) res.scrubbed++;
    }

    var key = name + '\u0000' + term;
    if (byKey[key]) console.warn('同じ区分に同じ名前の行があります：' + name + '（' + term + '）。予定は先の行につなぎます。');
    else byKey[key] = c;
    list.push(c);
  });

  // ---------- 予定 ----------
  var evs = [];
  var es = ss.getSheetByName(LEGACY_EVENTS);
  var eLast = es ? es.getLastRow() : 0;
  if (eLast >= 2) {
    es.getRange(2, 1, eLast - 1, 10).getValues().forEach(function (r) {
      var name = str_(r[0]).trim();
      if (!name) return;
      var c = byKey[name + '\u0000' + (str_(r[6]).trim() || LEGACY_TERM)];
      if (!c) { res.orphanEvents++; console.warn('会社が見つからない予定：' + name); return; }
      var e;
      try {
        e = Domain.createEvent(newId_('e'), c.id, {
          kind: str_(r[1]) || '予定',
          startAt: legacyWall_(r[2], tz, true),
          endAt: legacyWall_(r[7], tz, true),
          place: str_(r[3]),
          allDay: str_(r[8]).toUpperCase() === 'TRUE',
          daily: str_(r[9]).toUpperCase() === 'TRUE'
        });
      } catch (err) {
        res.badEvents++;
        console.warn('日時が読めない予定：' + name + '（' + err.message + '）');
        return;
      }
      if (carry) {
        var ids = str_(r[4]).split(',').map(function (s) { return s.trim(); }).filter(String);
        /* 連日は日ごとの予定を、日付の順に並べて持っていた */
        if (e.daily) ids.forEach(function (id, n) { c.cal['ev:' + e.id + '#' + n] = { id: id, sig: '' }; });
        else if (ids.length) c.cal['ev:' + e.id] = { id: ids[0], sig: '' };
      }
      evs.push(e);
    });
  }

  ct.appendMany(list);
  et.appendMany(evs);
  res.companies = list.length;
  res.events = evs.length;
  return res;
}

// ============================================================
// 旧版のロゴの記録
// ============================================================

/* ロゴではなく建物の写真が入っていた会社。取り込まない */
var LEGACY_LOGO_EXCLUDE = ['伊藤忠テクノソリューションズ', '履修データセンター'];

/**
 * スクリプトのプロパティ LEGACY_LOGOS（旧版のロゴの記録。会社名 → URL の JSON）を読み、
 * 使えるものだけを返す。https:// で始まらない値（メモ書きなど）と、写真の会社は外す。
 * 戻り値：{ map: 会社名 → URL, skipped: 外した会社名と理由 }
 */
function legacyLogoMap_() {
  var raw = prop_('LEGACY_LOGOS');
  var src;
  try { src = JSON.parse(raw || '{}'); } catch (e) { throw new Error('LEGACY_LOGOS が JSON として読めません。'); }
  if (!src || typeof src !== 'object' || Array.isArray(src)) throw new Error('LEGACY_LOGOS は「会社名: URL」の形の JSON にしてください。');
  var map = {}, skipped = [];
  Object.keys(src).forEach(function (name) {
    var url = str_(src[name]).trim();
    var key = str_(name).trim();
    if (LEGACY_LOGO_EXCLUDE.indexOf(key) >= 0) { skipped.push(key + '（写真なので外す）'); return; }
    if (!/^https:\/\//i.test(url)) { skipped.push(key + '（https:// で始まらない）'); return; }
    map[key] = url;
  });
  return { map: map, skipped: skipped };
}

/**
 * 旧版のロゴの記録を companies の logo 列へ取り込む。エディタから実行する。移行のあとに何度実行してもよい。
 * 会社名で行を探し、同じ名前の行（夏インターンと本選考など）には全部入れる。
 * logo 列が空か、画面が自動で見つけたもの（logoManual が FALSE）だけを上書きし、手で入れたものは残す。
 * 取り込んだロゴは自動の扱いにしておく。表示に失敗したとき、画面が次の候補へ差し替えられるように。
 */
function importLegacyLogos() {
  resetRun_();
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    var src = legacyLogoMap_();
    var table = companies_();
    var rows = table.all();
    var updated = 0, kept = 0, same = 0;
    var unmatched = [];
    Object.keys(src.map).forEach(function (name) {
      var hits = rows.filter(function (c) { return str_(c.name).trim() === name; });
      if (!hits.length) { unmatched.push(name); return; }
      hits.forEach(function (c) {
        if (c.logoManual && c.logo) { kept++; return; }
        if (c.logo === src.map[name]) { same++; return; }
        table.write({ id: c.id, logo: src.map[name], logoManual: false });
        updated++;
      });
    });
    bustCache_();
    console.log('ロゴを ' + updated + ' 行に入れました。手で入れたロゴを残した行 ' + kept + '、もう同じだった行 ' + same + '。');
    if (src.skipped.length) console.log('取り込まなかった記録：' + src.skipped.join('、'));
    if (unmatched.length) console.log('companies に同じ名前の行が無かった会社：' + unmatched.join('、'));
    return { updated: updated, kept: kept, same: same, skipped: src.skipped, unmatched: unmatched };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// パスワードの一括入力
// ============================================================

/**
 * pw 列が空の会社に、同じパスワードをまとめて入れる。すでに入っている行と、管理用の行は触らない。
 * パスワードの文字列はコードにもログにも残さないので、ここでは受け取るだけにする。
 * 呼び出し元は、git に入れない一時ファイル（gas/*.local.js）に置き、実行したらすぐ消す（手順は GAS_SETUP.md の 6-5）。
 * 実行ログに出すのは件数だけ。updatedAt もカレンダーも変えない。
 */
function fillEmptyPasswords_(pw) {
  pw = str_(pw);
  if (!pw) throw new Error('パスワードが空です。');
  resetRun_();
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    var table = companies_();
    var n = 0;
    table.all().forEach(function (c) {
      if (c.kind === 'mgmt' || str_(c.pw) !== '') return;
      table.write({ id: c.id, pw: pw });
      n++;
    });
    console.log('パスワードが空だった ' + n + ' 社に入れました。');
    return n;
  } finally {
    lock.releaseLock();
  }
}

/* 旧版の見出し（区分・状態・提出日・ルート・ドメイン・業種）の列番号 */
function legacyHead_(sheet) {
  var n = sheet.getLastColumn();
  var map = {};
  if (n < 1) return map;
  sheet.getRange(1, 1, 1, n).getValues()[0].forEach(function (h, i) {
    var k = str_(h).trim();
    if (k && !map[k]) map[k] = i + 1;
  });
  return map;
}

function legacyStatus_(state, oldStatus, term) {
  var s = str_(state).trim();
  var goal = Domain.goalOf(term);
  var byState = { '対応中': 'todo', '結果待ち': 'waiting', '参加決定': 'joined', '落選': 'failed', '見送り': 'skipped' };
  /* 旧版の画面は、夏インターンの「内定」を参加決定として出していた */
  if (s === '内定') return goal;
  if (byState[s]) return byState[s];
  var o = str_(oldStatus).trim();
  var byOld = { '済': 'waiting', '選考落ち': 'failed', '合格': 'joined', '日程削除': 'skipped' };
  if (o === '内定') return goal;
  return byOld[o] || 'todo';
}

/* 日付・時・分の3列を1つにまとめる。時が空なら、その日いっぱいの締切 */
function legacyDue_(date, hour, minute, tz) {
  var d = legacyWall_(date, tz, false);
  if (!d) return { dueAt: '', dueHasTime: false };
  if (hour === '' || hour == null || isNaN(parseInt(hour, 10))) return { dueAt: d + 'T23:59', dueHasTime: false };
  var pad = function (n) { return ('0' + n).slice(-2); };
  var m = minute === '' || minute == null || isNaN(parseInt(minute, 10)) ? 0 : parseInt(minute, 10);
  return { dueAt: d + 'T' + pad(parseInt(hour, 10)) + ':' + pad(m), dueHasTime: true };
}

/* 旧版の日付は Date のことも「2026/09/20」の文字列のこともある */
function legacyWall_(v, tz, withTime) {
  if (v === '' || v == null) return '';
  if (isDate_(v)) return dateToWall_(v, tz, withTime);
  var m = str_(v).trim().match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return '';
  var pad = function (n) { return ('0' + n).slice(-2); };
  var s = m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
  if (!withTime) return s;
  return s + 'T' + (m[4] ? pad(+m[4]) + ':' + m[5] : '00:00');
}

/* 説明欄から「パスワード: …」の行だけを消す。消したら true */
function scrubPassword_(id) {
  try {
    var ev = ownEvent_(calendar_(), id);
    if (!ev) return false;
    var desc = str_(ev.getDescription());
    var next = desc.split('\n').filter(function (line) { return !/^\s*パスワード/.test(line); }).join('\n');
    if (next === desc) return false;
    ev.setDescription(next);
    return true;
  } catch (e) {
    console.warn('説明欄を直せませんでした（' + id + '）：' + e);
    return false;
  }
}
