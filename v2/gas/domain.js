/*
 * 就活ボードの「状態の変わり方」をまとめたファイル。画面と GAS の両方で同じものを読み込む。
 * 計算を1か所にしておけば、画面とシートで結果が食い違わない。
 *
 * ・DOM にもシートにも触らない。受け取った値から結果を返すだけにする。
 * ・GAS は ES モジュールを読めないので、グローバルに Domain を1つだけ置く。
 *   Node（テスト）では module.exports からも取れるようにしておく。
 * ・パスワードはここでは扱わない。会社データに pw が混ざっていても、どこにも書き出さない。
 */
var Domain = (function () {
  'use strict';

  var DEFAULT_ROUTE = ['エントリー', 'ES', '適性検査', 'GD', '面接', '最終面接', '内定'];
  /* ルートに足すときの候補。記録タブで段階を並べる順にも使う */
  var STAGE_CANDIDATES = ['エントリー', 'ES', '適性検査', 'Webテスト', 'GD', '面談', '一次面接', '二次面接',
    '三次面接', '面接', '最終面接', 'インターン', '内定'];
  var STATUSES = ['todo', 'waiting', 'offer', 'joined', 'failed', 'skipped'];
  var EVENT_KINDS = ['面接', '説明会', 'GD', '面談', 'インターン', '適性検査'];
  var DEFAULT_TERM = '夏インターン';

  var MIN_MS = 60000;
  var DAY_MS = 86400000;
  var JST_OFFSET_MS = 9 * 3600000;
  /* 連日の予定は、これより多くの日に分けない（カレンダーを埋め尽くさないため） */
  var DAILY_MAX_DAYS = 60;

  var REMIND_DUE = [5760, 2880];          // 締切：4日前と2日前
  var REMIND_EVENT = [1440, 60];          // 予定：前日と1時間前
  var REMIND_ALLDAY = [1440];             // 終日の予定：前日だけ
  var REMIND_DAILY_FIRST = [1440, 60];    // 連日の初日：前日と1時間前
  var REMIND_DAILY_REST = [60];           // 連日の2日目以降：1時間前だけ

  function fail(msg) { throw new Error(msg); }
  function str(v) { return v == null ? '' : String(v); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  // ============================================================
  // 日時
  // ============================================================
  /* 日時は「日本時間の壁時計の値」を、そのまま UTC の数値として扱う。
     こうしておけば、画面の端末や GAS のタイムゾーン設定に左右されない */

  var DT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

  /* '2026-10-03' か '2026-10-03T23:59' を数値に。形が違う・ありえない日付なら null */
  function parseWall(s) {
    var m = DT_RE.exec(str(s).trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3], h = m[4] ? +m[4] : 0, mi = m[5] ? +m[5] : 0;
    if (h > 23 || mi > 59) return null;
    var ms = Date.UTC(y, mo - 1, d, h, mi);
    var t = new Date(ms);
    /* 2月30日のように繰り上がった日付は弾く */
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
    return ms;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function formatWall(ms, withTime) {
    var t = new Date(ms);
    var s = t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
    return withTime ? s + 'T' + pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes()) : s;
  }

  /* now は Date でも数値でもよい。日本時間の壁時計の値に直す */
  function wallNow(now) {
    var ms = now instanceof Date ? now.getTime() : +now;
    if (!isFinite(ms)) fail('今の時刻がわかりません。');
    return ms + JST_OFFSET_MS;
  }

  function today(now) { return formatWall(wallNow(now), false); }

  function addMinutes(s, n) { return formatWall(parseWall(s) + n * MIN_MS, true); }
  function addDays(date, n) { return formatWall(parseWall(date) + n * DAY_MS, false); }

  /* その日から今日まで何日たったか。未来の日付は 0、日付が無ければ null */
  function daysSince(date, now) {
    var d = parseWall(str(date).slice(0, 10));
    if (d == null) return null;
    var t = parseWall(today(now));
    return Math.max(0, Math.floor((t - d) / DAY_MS));
  }

  // ============================================================
  // 会社データの読み方
  // ============================================================

  function routeOf(c) {
    return (c && Array.isArray(c.route) && c.route.length) ? c.route.slice() : DEFAULT_ROUTE.slice();
  }

  /* 落選した会社は落ちた段階を、それ以外は今の段階を「現在地」とする */
  function position(c) { return str(c.lostStage) || str(c.stage); }

  /* 区分ごとの「最後まで通った」ときの状態。インターンは参加決定、それ以外は内定 */
  function goalOf(term) { return /インターン/.test(str(term) || DEFAULT_TERM) ? 'joined' : 'offer'; }

  /* 次に通過すると最後（内定・参加決定）になるか。ボタンの文言を変えるのに使う */
  function isFinalStep(c) {
    var r = routeOf(c), i = r.indexOf(str(c.stage));
    return i >= 0 && i >= r.length - 2;
  }

  function isOverdue(c, now) {
    var d = parseWall(c && c.dueAt);
    return d != null && d <= wallNow(now);
  }

  /* 画面上の状態。締切を過ぎた対応中は、保存はそのままで結果待ちとして見せる */
  function viewStatus(c, now) {
    var s = STATUSES.indexOf(c && c.status) >= 0 ? c.status : 'todo';
    if (s === 'todo' && isOverdue(c, now)) return 'waiting';
    return s;
  }

  function isAutoSent(c, now) {
    return viewStatus(c, now) === 'waiting' && c.status !== 'waiting';
  }

  /* 結果待ちの起点。提出日が無ければ（締切経過で自動送りのとき）締切日を使う */
  function waitingSince(c) {
    return str(c.submittedAt) || str(c.dueAt).slice(0, 10);
  }

  // ============================================================
  // 操作
  // ============================================================

  /* 受け取った会社データは書き換えず、写しを作って返す。
     画面は失敗したときに元のデータへ戻すので、元が変わっていると困る */
  function copy(c) {
    var o = {};
    for (var k in c) if (has(c, k)) o[k] = c[k];
    if (Array.isArray(o.route)) o.route = o.route.slice();
    if (o.cal && typeof o.cal === 'object') o.cal = JSON.parse(JSON.stringify(o.cal));
    return o;
  }

  function clearDue(c) { c.dueAt = ''; c.dueHasTime = false; }

  function need(c, allowed, msg) {
    if (allowed.indexOf(c.status || 'todo') < 0) fail(msg);
  }

  function checkUrl(url) {
    if (url && !/^https?:\/\//i.test(url)) fail('URLは https:// から始めてください。');
  }

  /* 画面の日付欄から来る値をそろえる。時刻なしは、その日いっぱいを締切とみなす */
  function normalizeDue(value, hasTime) {
    var v = str(value).trim();
    if (!v) return { dueAt: '', dueHasTime: false };
    if (parseWall(v) == null) fail('日時の形式が正しくありません。');
    if (v.length === 10) return { dueAt: v + 'T23:59', dueHasTime: false };
    return { dueAt: v, dueHasTime: hasTime !== false };
  }

  function normalizeRoute(route) {
    if (!Array.isArray(route)) fail('選考ルートの形が正しくありません。');
    var out = [];
    for (var i = 0; i < route.length; i++) {
      var s = str(route[i]).trim();
      if (!s) fail('段階の名前が空です。');
      if (out.indexOf(s) >= 0) fail('同じ段階が2つあります。');
      out.push(s);
    }
    if (out.length < 2) fail('段階は2つ以上必要です。');
    return out;
  }

  var OPS = {
    /* 通過。最後の手前なら内定（インターンは参加決定）まで進める */
    pass: function (c, op, now) {
      need(c, ['todo', 'waiting'], 'いまの状態では通過にできません。');
      var r = routeOf(c), i = r.indexOf(str(c.stage));
      if (i < 0) fail('選考ルートに今の段階がありません。');
      clearDue(c);
      c.submittedAt = '';
      c.lostStage = '';
      if (i >= r.length - 2) {
        c.stage = r[r.length - 1];
        c.status = goalOf(c.term);
        c.resultAt = today(now);
      } else {
        c.stage = r[i + 1];
        c.status = 'todo';
        c.resultAt = '';
      }
    },

    fail: function (c, op, now) {
      need(c, ['todo', 'waiting'], 'いまの状態では落選にできません。');
      c.status = 'failed';
      c.lostStage = str(c.stage);
      c.resultAt = today(now);
      clearDue(c);
    },

    /* 出し終えたので結果待ちへ。締切は消さずに残し、対応中に戻したときに使えるようにする */
    done: function (c, op, now) {
      need(c, ['todo'], 'いまの状態では結果待ちにできません。');
      c.status = 'waiting';
      c.submittedAt = today(now);
      c.lostStage = '';
      c.resultAt = '';
    },

    /* 対応中に戻す。落ちた段階や結果日が残ると、記録タブの数字がずれる */
    reopen: function (c) {
      need(c, ['waiting', 'offer', 'joined', 'failed', 'skipped'], 'もう対応中です。');
      c.status = 'todo';
      c.lostStage = '';
      c.resultAt = '';
      c.submittedAt = '';
    },

    skip: function (c) {
      need(c, ['todo', 'waiting'], 'いまの状態では見送りにできません。');
      c.status = 'skipped';
      clearDue(c);
    },

    /* 結果待ちから、段階はそのままで参加決定にする */
    join: function (c, op, now) {
      need(c, ['todo', 'waiting'], 'いまの状態では参加決定にできません。');
      c.status = 'joined';
      c.lostStage = '';
      c.resultAt = today(now);
      clearDue(c);
    },

    /* 1段階戻す。状態も対応中に戻し、結果の記録を消す */
    prev: function (c) {
      var r = routeOf(c), i = r.indexOf(position(c));
      if (i <= 0) fail('これ以上前の段階はありません。');
      c.stage = r[i - 1];
      c.status = 'todo';
      c.lostStage = '';
      c.resultAt = '';
      c.submittedAt = '';
      clearDue(c);
    },

    setDue: function (c, op) {
      var d = normalizeDue(op.dueAt, op.hasTime);
      c.dueAt = d.dueAt;
      c.dueHasTime = d.dueHasTime;
    },

    /* ルートの並べ替え・追加・削除と、現在地の付け替え */
    setRoute: function (c, op) {
      var next = normalizeRoute(op.route);
      var stage = str(op.stage).trim();
      if (stage) {
        if (next.indexOf(stage) < 0) fail('ルートに無い段階は現在地にできません。');
        c.stage = stage;
        if (c.lostStage) c.lostStage = stage;
      } else {
        /* 今の段階がもともとルートに無い行（移行前のデータなど）は、止めずに通す */
        var cur = position(c);
        if (routeOf(c).indexOf(cur) >= 0 && next.indexOf(cur) < 0) fail('今の段階は外せません。');
      }
      c.route = next;
    },

    setInfo: function (c, op) {
      var url = str(op.url).trim();
      checkUrl(url);
      c.url = url;
      c.loginId = str(op.loginId).trim();
    },

    setIndustry: function (c, op) { c.industry = str(op.industry).trim(); },

    setDomain: function (c, op) { c.domain = str(op.domain).trim(); },

    setLogo: function (c, op) {
      c.logo = str(op.logo).trim();
      c.logoManual = !!op.manual && !!c.logo;
    },

    /* 同じ区分に同じ名前が無いかは、全社を見られる呼び出し側で duplicateOf を使って確かめる */
    rename: function (c, op) {
      var name = str(op.name).trim();
      if (!name) fail('会社名が空です。');
      c.name = name;
    }
  };

  /**
   * 会社に操作をかけ、新しい会社データを返す。元のデータは書き換えない。
   * op は { type: 'pass' } や { type: 'setDue', dueAt: '2026-10-03T23:59' } の形。
   * できない操作なら、画面にそのまま出せる文言で Error を投げる。
   */
  function apply(company, op, now) {
    if (!company) fail('会社が見つかりません。');
    var type = op && op.type;
    if (!type || !has(OPS, type)) fail('知らない操作です：' + type);
    var c = copy(company);
    OPS[type](c, op, now);
    return c;
  }

  // ============================================================
  // 会社を作る
  // ============================================================
  /* ID は呼び出し側で作って渡す（ここで乱数を使うと、同じ入力で同じ結果にならない） */

  function blank(id, name, term) {
    if (!id) fail('ID がありません。');
    name = str(name).trim();
    if (!name) fail('会社名が空です。');
    return {
      id: id, kind: 'company', name: name, term: str(term).trim() || DEFAULT_TERM,
      status: 'todo', stage: DEFAULT_ROUTE[0], route: DEFAULT_ROUTE.slice(), lostStage: '',
      dueAt: '', dueHasTime: false, submittedAt: '', resultAt: '',
      url: '', loginId: '', domain: '', industry: '',
      logo: '', logoManual: false, folderUrl: '', cal: {}, updatedAt: ''
    };
  }

  /* 追加フォームから。URL・ID・ドメイン・段階・締切を一緒に入れられる */
  function create(id, f) {
    f = f || {};
    var c = blank(id, f.name, f.term);
    if (f.kind === 'mgmt') c.kind = 'mgmt';
    if (f.route) c.route = normalizeRoute(f.route);
    if (f.stage) c.stage = str(f.stage).trim();
    var url = str(f.url).trim();
    checkUrl(url);
    c.url = url;
    c.loginId = str(f.loginId).trim();
    c.domain = str(f.domain).trim();
    c.industry = str(f.industry).trim();
    var d = normalizeDue(f.dueAt, f.hasTime);
    c.dueAt = d.dueAt;
    c.dueHasTime = d.dueHasTime;
    return c;
  }

  /* 同じ会社として引き継ぐ項目。パスワードはシート側で別に写す */
  function inherit(src, c) {
    c.url = str(src.url);
    c.loginId = str(src.loginId);
    c.domain = str(src.domain);
    c.industry = str(src.industry);
    c.logo = str(src.logo);
    c.logoManual = !!src.logoManual;
    c.folderUrl = str(src.folderUrl);   // 書類を1か所にまとめたいので、同じフォルダを指す
    return c;
  }

  /* インターンの行から本選考の行を作る。選考はエントリーからやり直し */
  function carryOver(src, id, term) {
    term = str(term).trim() || '本選考';
    if (str(src.term) === term) fail('同じ区分には引き継げません。');
    return inherit(src, blank(id, src.name, term));
  }

  /* 同じマイページで別の選考（別コース）を足す。ルートも写す */
  function split(src, id, newName) {
    var c = inherit(src, blank(id, newName, src.term));
    c.route = routeOf(src);
    c.stage = c.route[0];
    return c;
  }

  /* 同じ区分に同じ名前の会社があれば返す。exceptId は改名中の本人を除くため */
  function duplicateOf(companies, name, term, exceptId) {
    var n = str(name).trim(), t = str(term).trim() || DEFAULT_TERM;
    for (var i = 0; i < (companies || []).length; i++) {
      var c = companies[i];
      if (!c || c.id === exceptId) continue;
      if (str(c.name).trim() === n && (str(c.term).trim() || DEFAULT_TERM) === t) return c;
    }
    return null;
  }

  // ============================================================
  // 予定
  // ============================================================

  /**
   * 予定タブの入力をそろえる。終わりが始まり以前なら終わりは無しとみなす。
   * 連日は「毎日同じ時間帯」の意味なので、終日でなく、終わりがあるときだけ効かせる。
   */
  function createEvent(id, companyId, f) {
    f = f || {};
    if (!id) fail('ID がありません。');
    if (!companyId) fail('会社が見つかりません。');
    var startAt = str(f.startAt).trim();
    var s = parseWall(startAt);
    if (s == null) fail('日時の形式が正しくありません。');
    if (startAt.length === 10) startAt += 'T00:00';
    var endAt = str(f.endAt).trim();
    if (endAt) {
      var e = parseWall(endAt);
      if (e == null) fail('終わりの日時の形式が正しくありません。');
      if (endAt.length === 10) endAt += 'T00:00';
      if (parseWall(endAt) <= parseWall(startAt)) endAt = '';
    }
    var allDay = !!f.allDay;
    return {
      id: id, companyId: companyId,
      kind: str(f.kind).trim() || '予定',
      startAt: startAt, endAt: endAt,
      allDay: allDay,
      daily: !allDay && !!f.daily && !!endAt,
      place: str(f.place).trim()
    };
  }

  // ============================================================
  // カレンダー
  // ============================================================

  function mypageLines(c, label) {
    var a = [];
    if (c.url) a.push(label + c.url);
    return a;
  }

  function dueItem(c) {
    var title = '【就活】' + c.name + ' (' + (str(c.stage) || '未定') + ') 締め切り';
    var desc = mypageLines(c, 'マイページURL: ');
    if (c.loginId) desc.push('ID: ' + c.loginId);
    var item = { key: 'due', title: title, description: desc.join('\n'), reminders: REMIND_DUE.slice() };
    if (c.dueHasTime) {
      item.allDay = false;
      item.start = c.dueAt;
      item.end = addMinutes(c.dueAt, 30);
    } else {
      var d = c.dueAt.slice(0, 10);
      item.allDay = true;
      item.start = d;
      item.end = addDays(d, 1);   // 終日の終わりは翌日を指す決まり
    }
    return item;
  }

  function eventItems(c, e) {
    var start = str(e.startAt), s = parseWall(start);
    if (s == null) return [];
    var title = '【' + (str(e.kind) || '予定') + '】' + c.name;
    var desc = (e.place ? [str(e.place)] : []).concat(mypageLines(c, 'マイページ: ')).join('\n');
    var key = 'ev:' + e.id;
    var endMs = parseWall(e.endAt);
    var end = endMs != null && endMs > s ? str(e.endAt) : '';

    if (e.allDay) {
      var d0 = start.slice(0, 10);
      var d1 = end ? end.slice(0, 10) : d0;
      return [{ key: key, title: title, description: desc, allDay: true,
        start: d0, end: addDays(d1, 1), reminders: REMIND_ALLDAY.slice() }];
    }

    if (e.daily && end) {
      /* 連日は日ごとに別の予定にする。1つの長い予定にすると、夜中も予定が入って見える */
      var first = parseWall(start.slice(0, 10)), last = parseWall(end.slice(0, 10));
      var span = Math.round((last - first) / DAY_MS);
      var sTime = start.slice(11), eTime = end.slice(11);
      var out = [];
      for (var i = 0; i <= span && i < DAILY_MAX_DAYS; i++) {
        var day = addDays(start.slice(0, 10), i);
        var s1 = day + 'T' + sTime, e1 = day + 'T' + eTime;
        if (parseWall(e1) <= parseWall(s1)) e1 = addMinutes(s1, 60);
        out.push({ key: key + '#' + i, allDay: false, start: s1, end: e1, description: desc,
          title: span > 0 ? title + '（' + (i + 1) + '/' + (span + 1) + '日目）' : title,
          reminders: (i === 0 ? REMIND_DAILY_FIRST : REMIND_DAILY_REST).slice() });
      }
      return out;
    }

    return [{ key: key, title: title, description: desc, allDay: false,
      start: start, end: end || addMinutes(start, 60), reminders: REMIND_EVENT.slice() }];
  }

  /* 予定が終わっているか。終日の end は翌日の0時を指すので、そのまま比べてよい */
  function hasEnded(item, now) {
    return parseWall(item.end) <= wallNow(now);
  }

  /**
   * その会社に本来あるべきカレンダー予定の一覧。
   * 締切の予定は対応中のときだけ置く。結果待ち・見送り・落選などになれば、差分で消える。
   * 面接などの予定は、見送り・落選になったら、これから先の分だけを外す。
   * 終わった予定は記録として残し、対応中に戻せば先の分も差分で作り直される。
   */
  function desiredCalendar(company, events, now) {
    var out = [];
    if (company.status === 'todo' && parseWall(company.dueAt) != null) out.push(dueItem(company));
    var closed = company.status === 'failed' || company.status === 'skipped';
    (events || []).forEach(function (e) {
      if (!e || e.companyId !== company.id) return;
      eventItems(company, e).forEach(function (item) {
        if (!closed || hasEnded(item, now)) out.push(item);
      });
    });
    return out;
  }

  /* 内容が同じかを見るための指紋。通知の順番の違いは同じとみなす */
  function calendarSig(item) {
    var rem = (item.reminders || []).slice().sort(function (a, b) { return b - a; });
    return JSON.stringify([item.title, item.description || '', !!item.allDay, item.start, item.end, rem]);
  }

  /**
   * あるべき予定と、いま作ってある予定を照らして、やることを返す。
   * current は { キー: 予定ID } か { キー: { id, sig } }。sig が無ければ中身が同じかわからないので直す側に入れる。
   */
  function calendarDiff(desired, current) {
    current = current || {};
    var res = { create: [], update: [], keep: [], remove: [] };
    var seen = {};
    (desired || []).forEach(function (item) {
      seen[item.key] = true;
      var cur = has(current, item.key) ? current[item.key] : null;
      var id = cur && typeof cur === 'object' ? cur.id : cur;
      if (!id) { res.create.push(item); return; }
      var sig = cur && typeof cur === 'object' ? cur.sig : null;
      if (sig && sig === calendarSig(item)) res.keep.push({ key: item.key, id: id });
      else res.update.push({ key: item.key, id: id, item: item });
    });
    Object.keys(current).forEach(function (k) {
      var cur = current[k];
      var id = cur && typeof cur === 'object' ? cur.id : cur;
      if (!seen[k] && id) res.remove.push({ key: k, id: id });
    });
    return res;
  }

  // ============================================================
  // 社名と業種
  // ============================================================

  /* タイルに出す表示名。会社名そのものは触らず、見せ方だけ短くする。
     法人格と、幅を食う全角英数を落とす */
  function shortName(name) {
    var raw = str(name);
    var v = raw
      .replace(/株式会社|有限会社|合同会社|合資会社|合名会社/g, '')
      .replace(/[（(](?:株|有|社|合|資)[)）]/g, '')
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
      .replace(/\s{2,}/g, ' ')
      .trim();
    return v || raw;
  }

  /* 上から順に見て最初に当たったものを採るので、細かい方を先に置く */
  var INDUSTRY = [
    ['IT・SIer', ['NTTデータ', 'ドコモソリューション', '日鉄ソリューション', 'システム', 'ソリューション', 'ソフト', 'テクノロジ', 'テック', 'デジタル', '情報サービス', '富士通', '日立', 'ＮＥＣ', 'NEC', 'SCSK', 'TIS', '伊藤忠テク', '電算']],
    ['通信', ['NTT', 'KDDI', 'ドコモ', 'ソフトバンク', '通信', '楽天モバイル']],
    ['金融', ['銀行', '信託', '証券', '保険', 'カード', 'キャピタル', 'ファイナンス', 'フィナンシャル', 'リース', 'UFJ', 'ＵＦＪ', 'みずほ', '三井住友', 'SBI', 'ＳＢＩ', 'セゾン', 'ニコス', 'SMFL', 'SMCC', '日本政策', '信金', '信用金庫']],
    ['航空・運輸', ['航空', 'JAL', 'ＪＡＬ', 'ANA', 'ＡＮＡ', '空港', '鉄道', '旅客', '海運', '汽船', '商船', '郵船', '物流', '運輸', '交通', '日本通運', '近鉄']],
    ['インフラ', ['電力', 'ガス', '石油', 'エネルギー', 'JERA', 'ＪＥＲＡ', '電源', '水道', '鉄道建設']],
    ['メーカー', ['製作所', '工業', '重工', '製鉄', '化学', '電機', '自動車', 'フイルム', 'フィルム', '精機', '製薬', '食品', '飲料', 'パナソニック', 'キヤノン', 'キャノン', 'ソニー', '東芝', '三菱電機', '川崎重', '製造']],
    ['商社', ['商事', '物産', '商社', '双日', '丸紅', '伊藤忠', '豊田通商', 'JALUX', 'ＪＡＬＵＸ']],
    ['不動産・建設', ['不動産', '建設', '地所', '住宅', 'ハウス', 'ゼネコン', '大成', '鹿島', '清水建']],
    ['コンサル', ['総研', '総合研究', '研究所', 'コンサル', 'リサーチ', 'NRI', 'ＮＲＩ', 'シンクタンク']],
    ['人材・広告', ['人材', 'リクルート', 'パーソル', 'マイナビ', '電通', '博報堂', '広告', '旅行', 'HIS', 'ＨＩＳ']],
    ['公共・その他', ['郵政', '日本郵便', '公社', '機構', '公団', '協会']]
  ];
  var INDUSTRY_NAMES = INDUSTRY.map(function (x) { return x[0]; });

  function industryOf(name) {
    var n = str(name);
    for (var i = 0; i < INDUSTRY.length; i++) {
      var keys = INDUSTRY[i][1];
      for (var j = 0; j < keys.length; j++) if (n.indexOf(keys[j]) >= 0) return INDUSTRY[i][0];
    }
    return 'その他';
  }

  /* 手で入れた業種があればそれを使い、無ければ社名から推定する */
  function industryFor(c) {
    return str(c && c.industry).trim() || industryOf(c && c.name);
  }

  // ============================================================
  // 記録タブの集計
  // ============================================================

  function pct(a, b) { return b ? Math.round(a / b * 100) : null; }

  /* 段階名の並び。既定のルート → 候補 → それ以外は出てきた順 */
  function stageOrder(names) {
    var order = DEFAULT_ROUTE.slice();
    STAGE_CANDIDATES.concat(names).forEach(function (s) { if (order.indexOf(s) < 0) order.push(s); });
    return order;
  }

  /* 業界名の並び。件数の多い順、「その他」は最後 */
  function sortByCount(map) {
    return Object.keys(map).sort(function (a, b) {
      if (a === 'その他') return b === 'その他' ? 0 : 1;
      if (b === 'その他') return -1;
      return map[b].n - map[a].n;
    });
  }

  /**
   * 記録タブの数字をまとめて出す。companies は表示中の区分の分だけを渡す。
   * 管理用の行は数えない。見送りは「エントリーしなかった」扱いで、ほとんどの集計から外す。
   */
  function tally(companies, now) {
    var list = (companies || []).filter(function (c) { return c && c.kind !== 'mgmt'; });
    var st = list.map(function (c) { return viewStatus(c, now); });
    var got = function (s) { return s === 'offer' || s === 'joined'; };

    /* 段階ごとの勝敗。ルート上で今より前の段階は全部「通過」として数える */
    var t = {}, seenNames = [];
    var bump = function (s, k) {
      if (!t[s]) { t[s] = { p: 0, f: 0, w: 0 }; seenNames.push(s); }
      t[s][k]++;
    };
    list.forEach(function (c, i) {
      var s = st[i];
      if (s === 'skipped') return;
      var r = routeOf(c), cur = position(c), at = r.indexOf(cur);
      var k = s === 'failed' ? 'f' : got(s) ? 'p' : 'w';
      if (at < 0) { bump(cur, k); return; }
      for (var j = 0; j < at; j++) bump(r[j], 'p');
      bump(cur, k);
    });
    var order = stageOrder(seenNames);
    var stages = order.filter(function (s) { return t[s]; }).map(function (s) {
      var o = t[s];
      return { stage: s, pass: o.p, fail: o.f, wait: o.w, rate: pct(o.p, o.p + o.f) };
    });

    var count = function (k) { return st.filter(function (s) { return s === k; }).length; };
    var failed = count('failed');
    var passes = stages.reduce(function (a, x) { return a + x.pass; }, 0);

    var worst = null;
    stages.forEach(function (x) { if (!worst || x.fail > worst.fail) worst = x; });
    worst = worst && worst.fail > 0 && failed > 0
      ? { stage: worst.stage, count: worst.fail, share: pct(worst.fail, failed) } : null;

    /* 段階名の並びではなく、その会社のルートの中でどこまで進んだかで比べる */
    var deepest = null, deepestRate = -1;
    list.forEach(function (c) {
      var r = routeOf(c), i = r.indexOf(position(c));
      if (i < 0) return;
      var rate = r.length > 1 ? i / (r.length - 1) : 1;
      if (rate > deepestRate) { deepestRate = rate; deepest = r[i]; }
    });

    var waits = [];
    list.forEach(function (c, i) {
      if (st[i] === 'waiting') waits.push({ name: c.name, days: daysSince(waitingSince(c), now) || 0 });
    });
    waits.sort(function (a, b) { return b.days - a.days; });

    /* 業界別は社を単位にする。段階の勝敗で数えると、3段階進んで落ちた1社が「3勝1敗」になってしまう */
    var byInd = {}, xs = {};
    list.forEach(function (c, i) {
      var s = st[i];
      if (s === 'skipped') return;
      var key = industryFor(c);
      var r = routeOf(c), cur = position(c), at = r.indexOf(cur);

      var o = byInd[key] || (byInd[key] = { n: 0, got: 0, fail: 0, live: 0, sum: 0 });
      o.n++;
      if (s === 'failed') o.fail++;
      else if (got(s)) o.got++;
      else o.live++;
      /* 内定・参加決定は最後まで行ったものとして 100% */
      if (got(s)) o.sum += 1;
      else if (at >= 0 && r.length > 1) o.sum += at / (r.length - 1);

      /* 業界 × 段階は、結果が出たものだけを数える（結果待ちは分母に入れない） */
      var x = xs[key] || (xs[key] = { n: 0, st: {} });
      x.n++;
      var hit = function (name, k) { (x.st[name] || (x.st[name] = { p: 0, f: 0 }))[k]++; };
      var k = s === 'failed' ? 'f' : got(s) ? 'p' : null;
      if (at >= 0) for (var j = 0; j < at; j++) hit(r[j], 'p');
      if (k) hit(cur, k);
    });

    var industries = sortByCount(byInd).map(function (name) {
      var o = byInd[name];
      return { name: name, count: o.n, got: o.got, fail: o.fail, live: o.live,
        rate: pct(o.got, o.got + o.fail), reach: Math.round(o.sum / o.n * 100) };
    });
    var industryStages = sortByCount(xs).map(function (name) {
      var x = xs[name];
      var rows = order.filter(function (s) { return x.st[s]; }).map(function (s) {
        var v = x.st[s];
        return { stage: s, pass: v.p, fail: v.f, rate: pct(v.p, v.p + v.f) };
      });
      return { name: name, count: x.n, stages: rows };
    }).filter(function (x) { return x.stages.length; });

    return {
      entered: list.length - count('skipped'),
      passes: passes,
      live: count('todo') + count('waiting') + count('joined') + count('offer'),
      failed: failed,
      skipped: count('skipped'),
      deepest: deepest == null ? null : { stage: deepest, rate: Math.round(deepestRate * 100) },
      worst: worst,
      stages: stages,
      waiting: {
        count: waits.length,
        avg: waits.length ? Math.round(waits.reduce(function (a, w) { return a + w.days; }, 0) / waits.length) : 0,
        longest: waits[0] || null
      },
      industries: industries,
      industryStages: industryStages,
      breakdown: { todo: count('todo'), waiting: count('waiting'), joined: count('joined'), offer: count('offer') }
    };
  }

  return {
    DEFAULT_ROUTE: DEFAULT_ROUTE,
    STAGE_CANDIDATES: STAGE_CANDIDATES,
    STATUSES: STATUSES,
    EVENT_KINDS: EVENT_KINDS,
    DEFAULT_TERM: DEFAULT_TERM,
    INDUSTRY_NAMES: INDUSTRY_NAMES,

    apply: apply,
    create: create,
    carryOver: carryOver,
    split: split,
    duplicateOf: duplicateOf,
    createEvent: createEvent,

    routeOf: routeOf,
    position: position,
    goalOf: goalOf,
    isFinalStep: isFinalStep,
    isOverdue: isOverdue,
    viewStatus: viewStatus,
    isAutoSent: isAutoSent,
    waitingSince: waitingSince,

    desiredCalendar: desiredCalendar,
    calendarSig: calendarSig,
    calendarDiff: calendarDiff,

    tally: tally,
    industryOf: industryOf,
    industryFor: industryFor,
    shortName: shortName,

    today: today,
    daysSince: daysSince,
    parseWall: parseWall
  };
})();

if (typeof module === 'object' && module.exports) module.exports = Domain;
