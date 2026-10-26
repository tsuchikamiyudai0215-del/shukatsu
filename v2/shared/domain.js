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

  /* 新しく足す会社の初期のルート。インターンは参加まで、本選考は内定まで */
  var DEFAULT_ROUTES = {
    intern: ['ES', 'テスト', '面接', 'インターン'],
    main: ['ES', 'テスト', '面接', '内定']
  };
  /* 前の初期のルート。ルートを自分で編集していない会社（route が空）は、これを書き込んで固定する。
     初期のルートを変えても、その会社の動きが変わらないように */
  var LEGACY_ROUTE = ['エントリー', 'ES', '適性検査', 'GD', '面接', '最終面接', '内定'];
  /* ルートに足すときの候補 */
  var STAGE_CANDIDATES = ['エントリー', 'ES', '適性検査', 'Webテスト', 'GD', '面談', '一次面接', '二次面接',
    '三次面接', '面接', '最終面接', 'インターン', '内定'];
  /* 記録タブで段階を並べる順。ここに無い段階は、出てきた順に後ろへ並べる */
  var STAGE_ORDER = ['エントリー', 'ES', 'テスト', '適性検査', 'Webテスト', 'GD', '面談', '一次面接', '二次面接',
    '三次面接', '面接', '最終面接', 'インターン', '内定'];
  var STATUSES = ['todo', 'waiting', 'offer', 'joined', 'failed', 'skipped'];
  var EVENT_KINDS = ['面接', '説明会', 'GD', '面談', 'インターン', '適性検査'];
  /* 区分は「インターン」と「本選考」の2つ。夏の行をそのまま秋冬にも使うので、インターンは季節で分けない */
  var DEFAULT_TERM = 'インターン';
  /* 前の区分の名前。シートや端末の控えに残っていても、今の名前として読む */
  var OLD_TERMS = { '夏インターン': 'インターン' };

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

  /* 区分の名前をそろえる。空なら初期の区分、前の名前なら今の名前にする */
  function termOf(term) {
    var t = str(term).trim();
    return (has(OLD_TERMS, t) ? OLD_TERMS[t] : t) || DEFAULT_TERM;
  }

  /* 区分ごとの「最後まで通った」ときの状態。インターンは参加決定、それ以外は内定 */
  function goalOf(term) { return /インターン/.test(termOf(term)) ? 'joined' : 'offer'; }

  function defaultRoute(term) {
    return (goalOf(term) === 'joined' ? DEFAULT_ROUTES.intern : DEFAULT_ROUTES.main).slice();
  }

  /* route が空の会社は初期のルートで動く。移行と fillEmptyRoutes で前の初期のルートを書き込むので、ふだんは空にならない */
  function routeOf(c) {
    return (c && Array.isArray(c.route) && c.route.length) ? c.route.slice() : defaultRoute(c && c.term);
  }

  /* 落選した会社は落ちた段階を、それ以外は今の段階を「現在地」とする */
  function position(c) { return str(c.lostStage) || str(c.stage); }

  // ------------------------------------------------------------
  // 「次とまとめて結果が出る」の印
  // ------------------------------------------------------------
  /* 印は routeLinks に段階名で持つ。「この段階は、次の段階とまとめて結果が出る」の意味。
     ES と適性検査のように、出したあと結果を待たずに次へ進む段階をつなぐ。
     ルートに無い段階と、最後の段階（次が無い）の印は外し、ルートの順に並べる */
  function normalizeLinks(route, links) {
    var want = Array.isArray(links) ? links.map(str) : [];
    return route.filter(function (s, i) { return i < route.length - 1 && want.indexOf(s) >= 0; });
  }

  function linksOf(c) { return normalizeLinks(routeOf(c), c && c.routeLinks); }

  function isLinked(c, stage) { return linksOf(c).indexOf(str(stage)) >= 0; }

  /* 関門の並び。印でつながった段階を1つにまとめる（[['ES','テスト'], ['面接'], ['内定']] など） */
  function gatesOf(c) {
    var links = linksOf(c), gates = [], cur = [];
    routeOf(c).forEach(function (s) {
      cur.push(s);
      if (links.indexOf(s) < 0) { gates.push(cur); cur = []; }
    });
    if (cur.length) gates.push(cur);
    return gates;
  }

  function gateIndex(gates, stage) {
    for (var i = 0; i < gates.length; i++) if (gates[i].indexOf(stage) >= 0) return i;
    return -1;
  }

  /* ルートで今の段階の次にある段階。無ければ空 */
  function nextStage(c) {
    var r = routeOf(c), i = r.indexOf(str(c.stage));
    return i >= 0 && i < r.length - 1 ? r[i + 1] : '';
  }

  /* 段階を消したときの新しい現在地。消すのが現在地でなければ空。
     次の段階にする。最後の段階を消すときは1つ前にする */
  function removalTarget(c, stage) {
    stage = str(stage);
    if (!stage || position(c) !== stage) return '';
    var r = routeOf(c), i = r.indexOf(stage);
    if (i < 0) return '';
    return r[i + 1] || r[i - 1] || '';
  }

  /* 次に通過すると最後（内定・参加決定）になるか。ボタンの文言を変えるのに使う */
  /* 行き着いた段階か。ルートの最後の段階のほか、インターンの区分では「インターン」も行き着いた段階とみなす
     （前の初期のルートの会社は、最後が「内定」で、「インターン」が途中にあるため） */
  function isGoalStage(term, route, stage) {
    stage = str(stage);
    if (!stage || !route || !route.length) return false;
    if (stage === route[route.length - 1]) return true;
    return goalOf(term) === 'joined' && stage === 'インターン';
  }

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

  // ------------------------------------------------------------
  // 結果の履歴
  // ------------------------------------------------------------
  /* 段階ごとの結果を history に積む。1件は { stage, dueAt, submittedAt, resultAt, outcome }。
     outcome は pass（次の段階へ）・fail・offer・joined。
     次の段階へ進むと提出日と結果日は上書きされるので、結果が出た時点の値をここに残す。
     履歴を残し始める前の会社は、今の値から最後の結果だけを1件として起こす（シートを書き換えずに済むように） */
  function historyOf(c) {
    if (c && Array.isArray(c.history) && c.history.length) return c.history.map(function (e) { return copy(e); });
    var s = c && c.status;
    if ((s === 'failed' || s === 'offer' || s === 'joined') && str(c.resultAt)) {
      return [{ stage: position(c), dueAt: '', submittedAt: str(c.submittedAt), resultAt: str(c.resultAt), outcome: s === 'failed' ? 'fail' : s }];
    }
    return [];
  }

  /* 結果が出たときに1件足す。before は操作をかける前の会社（締切と提出日が残っている） */
  function record(c, before, outcome, now) {
    c.history = historyOf(before).concat([{
      stage: position(before), dueAt: str(before.dueAt), submittedAt: str(before.submittedAt),
      resultAt: today(now), outcome: outcome
    }]);
  }

  /* 結果を取り消したとき（対応中に戻すなど）に、最後の1件が outcomes のどれかなら外す */
  function unrecord(c, outcomes) {
    var h = historyOf(c);
    if (h.length && outcomes.indexOf(h[h.length - 1].outcome) >= 0) h.pop();
    c.history = h;
  }

  /* 提出（無ければ締切）から結果までの日数。どちらかが無い・前後が逆なら null */
  function resultDays(e) {
    var from = parseWall(str(e && (e.submittedAt || e.dueAt)).slice(0, 10));
    var to = parseWall(str(e && e.resultAt).slice(0, 10));
    if (from == null || to == null || to < from) return null;
    return Math.round((to - from) / DAY_MS);
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
    if (Array.isArray(o.routeLinks)) o.routeLinks = o.routeLinks.slice();
    if (o.cal && typeof o.cal === 'object') o.cal = JSON.parse(JSON.stringify(o.cal));
    if (Array.isArray(o.history)) o.history = JSON.parse(JSON.stringify(o.history));
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
      record(c, copy(c), i >= r.length - 2 ? goalOf(c.term) : 'pass', now);
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
      record(c, copy(c), 'fail', now);
      c.status = 'failed';
      c.lostStage = str(c.stage);
      c.resultAt = today(now);
      clearDue(c);
    },

    /* 印の付いた段階を出したので、結果待ちを通らずに次の段階の対応中にする。
       結果は次の段階とまとめて出るので、ここでは通過も落選も記録しない。締切は空にする（締切の予定も消える） */
    advance: function (c) {
      need(c, ['todo'], 'いまの状態では次へ進めません。');
      if (!isLinked(c, c.stage)) fail('この段階は、次とまとめて結果が出る印が付いていません。');
      c.stage = nextStage(c);
      c.lostStage = '';
      c.submittedAt = '';
      c.resultAt = '';
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
      /* 落選・内定・参加決定を取り消すので、履歴からもその結果を外す */
      if (c.status === 'failed') unrecord(c, ['fail']);
      else if (c.status === 'offer' || c.status === 'joined') unrecord(c, ['offer', 'joined']);
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
      record(c, copy(c), 'joined', now);
      c.status = 'joined';
      c.lostStage = '';
      c.resultAt = today(now);
      clearDue(c);
    },

    /* 1段階戻す。状態も対応中に戻し、結果の記録を消す */
    prev: function (c) {
      var r = routeOf(c), i = r.indexOf(position(c));
      if (i <= 0) fail('これ以上前の段階はありません。');
      /* 戻る先の段階の「通過」を取り消す。今の段階の結果（落選など）が最後にあれば、先にそれも外す */
      unrecord(c, ['fail', 'offer', 'joined']);
      var h = historyOf(c);
      if (h.length && h[h.length - 1].stage === r[i - 1] && h[h.length - 1].outcome === 'pass') h.pop();
      c.history = h;
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

    /* ルートの並べ替え・追加と、現在地の付け替え。段階を消すときは removeStage を使う。
       印（links）を渡さなければ、今の印を新しいルートに合わせて残す */
    setRoute: function (c, op, now) {
      var next = normalizeRoute(op.route);
      var stage = str(op.stage).trim();
      if (stage) {
        if (next.indexOf(stage) < 0) fail('ルートに無い段階は現在地にできません。');
        c.stage = stage;
        if (c.lostStage) c.lostStage = stage;
        /* 現在地を「行き着いた段階」にしたら、通過で最後まで進んだときと同じく参加決定（本選考は内定）にする。
           そこから前の段階へ戻したら、対応中に戻す。落選・見送りは、現在地を動かしても状態は変えない */
        var goal = isGoalStage(c.term, next, stage);
        if (goal && (c.status === 'todo' || c.status === 'waiting')) {
          /* 現在地を付け替えて行き着いたので、提出日は無い。日数の集計には入らないが、結果としては残す */
          var before = copy(c);
          before.stage = stage;
          before.dueAt = '';
          before.submittedAt = '';
          record(c, before, goalOf(c.term), now);
          c.status = goalOf(c.term);
          c.resultAt = today(now);
          c.submittedAt = '';
          clearDue(c);
        } else if (!goal && (c.status === 'offer' || c.status === 'joined')) {
          unrecord(c, ['offer', 'joined']);
          c.status = 'todo';
          c.resultAt = '';
        }
      } else {
        /* 今の段階がもともとルートに無い行（移行前のデータなど）は、止めずに通す */
        var cur = position(c);
        if (routeOf(c).indexOf(cur) >= 0 && next.indexOf(cur) < 0) fail('今の段階は外せません。');
      }
      c.routeLinks = normalizeLinks(next, has(op, 'links') ? op.links : linksOf(c));
      c.route = next;
    },

    /* 「次とまとめて結果が出る」の印を付ける・外す。最後の段階には次が無いので付けられない */
    setLink: function (c, op) {
      var r = routeOf(c), stage = str(op.stage), i = r.indexOf(stage);
      if (i < 0) fail('ルートに無い段階です。');
      if (op.on && i === r.length - 1) fail('最後の段階には付けられません。');
      var links = linksOf(c).filter(function (s) { return s !== stage; });
      if (op.on) links.push(stage);
      c.route = r;
      c.routeLinks = normalizeLinks(r, links);
    },

    /**
     * 段階を1つ消す。今の段階（落選なら落ちた段階）も消せる。そのときの現在地は removalTarget の決まり
     * （次の段階。最後の段階なら1つ前）。締切はそのまま残す。段階が2つより少なくなる削除はできない。
     * 印のつながりは崩さない：つながりの最後を消したら1つ前がつながりの最後になり、次の関門とはつながらない。
     */
    removeStage: function (c, op) {
      var r = routeOf(c), stage = str(op.stage), i = r.indexOf(stage);
      if (i < 0) fail('ルートに無い段階です。');
      if (r.length - 1 < 2) fail('段階は2つ以上必要です。');
      var links = linksOf(c);
      if (links.indexOf(stage) < 0 && i > 0 && links.indexOf(r[i - 1]) >= 0) {
        links = links.filter(function (s) { return s !== r[i - 1]; });
      }
      links = links.filter(function (s) { return s !== stage; });
      var to = removalTarget(c, stage);
      if (to) {
        if (c.lostStage) c.lostStage = to;
        c.stage = to;
      }
      c.route = r.slice(0, i).concat(r.slice(i + 1));
      c.routeLinks = normalizeLinks(c.route, links);
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
    term = termOf(term);
    var route = defaultRoute(term);
    return {
      id: id, kind: 'company', name: name, term: term,
      status: 'todo', stage: route[0], route: route, routeLinks: [], lostStage: '',
      dueAt: '', dueHasTime: false, submittedAt: '', resultAt: '',
      url: '', loginId: '', domain: '', industry: '',
      logo: '', logoManual: false, folderUrl: '', cal: {}, updatedAt: '', history: []
    };
  }

  /* 追加フォームから。URL・ID・ドメイン・段階・締切を一緒に入れられる */
  function create(id, f) {
    f = f || {};
    var c = blank(id, f.name, f.term);
    if (f.kind === 'mgmt') c.kind = 'mgmt';
    if (f.route) {
      c.route = normalizeRoute(f.route);
      c.stage = c.route[0];
      c.routeLinks = normalizeLinks(c.route, f.routeLinks);
    }
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

  /* インターンの行から本選考の行を作る。選考は本選考の初期のルートの最初からやり直し */
  function carryOver(src, id, term) {
    term = str(term).trim() ? termOf(term) : '本選考';
    if (termOf(src.term) === term) fail('同じ区分には引き継げません。');
    return inherit(src, blank(id, src.name, term));
  }

  /* 同じマイページで別の選考（別コース）を足す。
     元の会社のルートが前の初期のルートのままなら、今の初期のルート（簡単なほう）で作る。前から登録してある会社は
     前の初期のルートを書き込んで固定してあるので、写すと新しい選考まで長いルートになるため。
     自分で並べ替えたり足したりしたルートは、その会社のために作ったものなので、印ごと写す */
  function split(src, id, newName) {
    var c = inherit(src, blank(id, newName, src.term));
    var r = routeOf(src);
    if (r.join('\n') !== LEGACY_ROUTE.join('\n')) {
      c.route = r;
      c.routeLinks = linksOf(src);
    }
    c.stage = c.route[0];
    return c;
  }

  /**
   * 状態に合わない値を片付けた写しを返す。移行のときに、旧版の名残を消すのに使う。
   * apply の各操作が残す値と同じ決まりにしてある：
   *   対応中      … 提出日・結果日・落ちた段階を持たない
   *   結果待ち    … 結果日・落ちた段階を持たない（締切は対応中に戻したときのために残す）
   *   内定・参加決定 … 締切・落ちた段階を持たない
   *   落選        … 締切を持たない。落ちた段階が空なら今の段階で落ちたとみなす
   *   見送り      … 締切・結果日・落ちた段階を持たない
   */
  function normalize(company) {
    var c = copy(company);
    c.term = termOf(c.term);
    var s = STATUSES.indexOf(c.status) >= 0 ? c.status : 'todo';
    c.status = s;
    if (s !== 'failed') c.lostStage = '';
    if (s === 'todo') { c.submittedAt = ''; c.resultAt = ''; }
    if (s === 'waiting' || s === 'skipped') c.resultAt = '';
    if (s !== 'todo' && s !== 'waiting') clearDue(c);
    if (s === 'failed' && !c.lostStage) c.lostStage = str(c.stage);
    if (!str(c.dueAt)) c.dueHasTime = false;
    c.routeLinks = linksOf(c);
    if (!Array.isArray(c.history)) c.history = [];
    return c;
  }

  /* 同じ区分に同じ名前の会社があれば返す。exceptId は改名中の本人を除くため */
  function duplicateOf(companies, name, term, exceptId) {
    var n = str(name).trim(), t = termOf(term);
    for (var i = 0; i < (companies || []).length; i++) {
      var c = companies[i];
      if (!c || c.id === exceptId) continue;
      if (str(c.name).trim() === n && termOf(c.term) === t) return c;
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

  /* Wikipedia の記事の画像は、本社ビルや社長の写真のことが多い。ファイル名がロゴらしいものだけを使う */
  function isWikipediaPhoto(url) {
    var u = str(url);
    if (!/^https:\/\/upload\.wikimedia\.org\//i.test(u)) return false;
    var name = u;
    try { name = decodeURIComponent(u); } catch (e) { /* そのまま見る */ }
    return !/logo|ロゴ|シンボル|マーク|emblem|symbol|\.svg/i.test(name);
  }

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

  /* 上から順に見て最初に当たったものを採るので、細かい方を先に置く。
     同じ業界が2回出てくるのは、銀行の「システム」コースを IT にしないため。
     会社名で決まるもの → 金融 → 「システム」などの広い言葉、の順に見る */
  var INDUSTRY = [
    ['コンサル', ['総研', '総合研究', '研究所', '経営研究', 'DATA研究', 'データ研究', 'コンサル', 'リサーチ', 'NRI', 'ＮＲＩ', 'シンクタンク']],
    ['IT・SIer', ['NTTデータ', 'ＮＴＴデータ', 'NTTDATA', 'NTT DATA', 'ドコモソリューション', '日鉄ソリューション', 'MUIT', 'インフォメーションテクノロジー',
      '富士通', '日立', 'ＮＥＣ', 'NEC', 'IBM', 'ＩＢＭ', 'アイ・ビー・エム', 'SCSK', 'TIS', '伊藤忠テク', 'デル・テクノロジーズ', 'Dell', '電算']],
    ['旅行・観光', ['旅行', 'トラベル', 'ツーリズム', '観光', 'JTB', 'ＪＴＢ', 'HIS', 'ＨＩＳ', 'エイチ・アイ・エス']],
    ['金融', ['銀行', '信託', '証券', '保険', '生命', '損保', '海上日動', 'カード', 'CARD', 'キャピタル', 'ファイナンス', 'フィナンシャル', 'リース',
      'UFJ', 'ＵＦＪ', 'みずほ', '三井住友', 'りそな', 'SBI', 'ＳＢＩ', 'セゾン', 'ニコス', 'JCB', 'ＪＣＢ', 'ジェーシービー', 'SMFL', 'SMCC', '日本政策', '信金', '信用金庫']],
    ['IT・SIer', ['システム', 'ソリューション', 'ソフト', 'テクノロジ', 'テック', 'デジタル', '情報サービス']],
    ['通信', ['NTT', 'KDDI', 'ドコモ', 'ソフトバンク', '通信', '楽天モバイル']],
    ['航空・運輸', ['航空', 'JAL', 'ＪＡＬ', 'ANA', 'ＡＮＡ', '空港', '鉄道', '旅客', '海運', '汽船', '商船', '郵船', '物流', '運輸', '交通', '日本通運', '近鉄']],
    ['インフラ', ['電力', 'ガス', '石油', 'エネルギー', 'JERA', 'ＪＥＲＡ', '電源', '水道', '鉄道建設']],
    ['メーカー', ['製作所', '工業', '重工', '製鉄', '鉄鋼', '製鋼', 'JFE', 'ＪＦＥ', '化学', '化成', '電機', '自動車', 'フイルム', 'フィルム', '精機', '製薬', '食品', '飲料',
      'パナソニック', 'キヤノン', 'キャノン', 'ソニー', '東芝', 'ニコン', '三菱電機', '川崎重', '製造']],
    ['商社', ['商事', '物産', '商社', '双日', '丸紅', '伊藤忠', '豊田通商', 'JALUX', 'ＪＡＬＵＸ']],
    ['不動産・建設', ['不動産', '建設', '地所', '住宅', 'ハウス', 'ゼネコン', '大成', '鹿島', '清水建']],
    ['人材・広告', ['人材', 'リクルート', 'パーソル', 'マイナビ', '電通', '博報堂', '広告']],
    ['公共・その他', ['郵政', '日本郵便', '公社', '機構', '公団', '協会']]
  ];
  var INDUSTRY_NAMES = INDUSTRY.map(function (x) { return x[0]; }).filter(function (x, i, a) { return a.indexOf(x) === i; });

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

  var JOIN = '＋';

  /* 関門の名前。つながった段階は「ES＋テスト」のように1つにする */
  function gateLabel(gate) { return gate.join(JOIN); }

  /* 関門の並び。先頭の段階の STAGE_ORDER の順 → つながりの短い順 → 出てきた順 */
  function stageOrder(labels) {
    var rank = function (label) {
      var i = STAGE_ORDER.indexOf(label.split(JOIN)[0]);
      return i < 0 ? STAGE_ORDER.length : i;
    };
    return labels.slice().sort(function (a, b) {
      return rank(a) - rank(b) || a.split(JOIN).length - b.split(JOIN).length || labels.indexOf(a) - labels.indexOf(b);
    });
  }

  /* 会社1社の、関門ごとの結果。前の関門は通過、今の関門は k（落選・通過・結果待ち）。
     つながった段階の途中にいても、その関門として1回だけ数える */
  function eachGate(c, k, fn) {
    var gates = gatesOf(c), cur = position(c), at = gateIndex(gates, cur);
    if (at < 0) { fn(cur, k); return; }
    for (var j = 0; j < at; j++) fn(gateLabel(gates[j]), 'p');
    fn(gateLabel(gates[at]), k);
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

    /* 関門ごとの勝敗。ルート上で今より前の関門は全部「通過」として数える。
       印でつながった段階は1つの関門（「ES＋テスト」）として数える */
    var t = {}, seenNames = [];
    var bump = function (s, k) {
      if (!t[s]) { t[s] = { p: 0, f: 0, w: 0 }; seenNames.push(s); }
      t[s][k]++;
    };
    list.forEach(function (c, i) {
      var s = st[i];
      if (s === 'skipped') return;
      eachGate(c, s === 'failed' ? 'f' : got(s) ? 'p' : 'w', bump);
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
      var r = routeOf(c), at = r.indexOf(position(c));

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
      eachGate(c, s === 'failed' ? 'f' : got(s) ? 'p' : null, function (name, k) {
        if (k) (x.st[name] || (x.st[name] = { p: 0, f: 0 }))[k]++;
      });
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

  /* 日数の並びの、件数・平均（小数1桁）・真ん中の値 */
  function summarize(days) {
    if (!days.length) return { n: 0, avg: null, median: null };
    var s = days.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    var median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    var avg = s.reduce(function (a, d) { return a + d; }, 0) / s.length;
    return { n: s.length, avg: Math.round(avg * 10) / 10, median: Math.round(median * 10) / 10 };
  }

  /**
   * 提出（無ければ締切）から結果までの日数の集計。companies は表示中の区分の分だけを渡す。
   * 履歴の1件ごとに数える。提出日も締切も無い結果（ルートで現在地を付け替えたなど）は数えない。
   * 戻り値：{ all, pass, fail, stages: [{ stage, ... }], industries: [{ name, ... }], companies: [{ id, name, items, ... }] }（どれも summarize の形）
   * companies は返事の早い順。items はその会社の結果の1件ずつ（{ stage, resultAt, days, outcome }、結果日の古い順）。
   * 夏と冬で同じ段階が2回出ることがあるので、結果日を付けて見分けられるようにする。
   * 日数の出ない結果も items には入れる（件数が履歴と合わないと変に見えるため）。日数の集計には入れない
   */
  function resultSpeed(companies) {
    var all = [], pass = [], failed = [], byStage = {}, byInd = {}, names = [], cos = [];
    (companies || []).forEach(function (c) {
      if (!c || c.kind === 'mgmt') return;
      var items = [];
      historyOf(c).forEach(function (e) {
        var d = resultDays(e);
        items.push({ stage: str(e.stage), resultAt: str(e.resultAt).slice(0, 10), days: d, outcome: e.outcome });
        if (d == null) return;
        all.push(d);
        (e.outcome === 'fail' ? failed : pass).push(d);
        if (!byStage[e.stage]) { byStage[e.stage] = []; names.push(e.stage); }
        byStage[e.stage].push(d);
        var k = industryFor(c);
        (byInd[k] || (byInd[k] = [])).push(d);
      });
      var ds = items.filter(function (x) { return x.days != null; }).map(function (x) { return x.days; });
      if (ds.length) {
        /* 結果日の無いものは最後に回す */
        var key = function (x) { return x.resultAt || '9999'; };
        items.sort(function (a, b) { return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0; });
        cos.push(Object.assign({ id: c.id, name: str(c.name), items: items }, summarize(ds)));
      }
    });
    /* 同じ早さなら件数の多い方（当てになる方）を先に */
    cos.sort(function (a, b) { return a.median - b.median || b.n - a.n; });
    var indMap = {};
    Object.keys(byInd).forEach(function (k) { indMap[k] = { n: byInd[k].length }; });
    return {
      all: summarize(all),
      pass: summarize(pass),
      fail: summarize(failed),
      stages: stageOrder(names).map(function (s) { return Object.assign({ stage: s }, summarize(byStage[s])); }),
      industries: sortByCount(indMap).map(function (k) { return Object.assign({ name: k }, summarize(byInd[k])); }),
      companies: cos
    };
  }

  /* 結果待ちの目安の日数。その段階の結果が2件以上あればその真ん中の値、無ければ全体（3件以上）の真ん中の値 */
  function expectedDays(companies, stage) {
    var sp = resultSpeed(companies);
    var st = sp.stages.filter(function (x) { return x.stage === str(stage); })[0];
    if (st && st.n >= 2) return { days: st.median, n: st.n, scope: 'stage' };
    if (sp.all.n >= 3) return { days: sp.all.median, n: sp.all.n, scope: 'all' };
    return null;
  }

  return {
    DEFAULT_ROUTES: DEFAULT_ROUTES,
    LEGACY_ROUTE: LEGACY_ROUTE,
    STAGE_CANDIDATES: STAGE_CANDIDATES,
    STATUSES: STATUSES,
    EVENT_KINDS: EVENT_KINDS,
    DEFAULT_TERM: DEFAULT_TERM,
    OLD_TERMS: OLD_TERMS,
    INDUSTRY_NAMES: INDUSTRY_NAMES,

    apply: apply,
    create: create,
    historyOf: historyOf,
    resultDays: resultDays,
    resultSpeed: resultSpeed,
    expectedDays: expectedDays,
    carryOver: carryOver,
    split: split,
    duplicateOf: duplicateOf,
    normalize: normalize,
    createEvent: createEvent,

    routeOf: routeOf,
    defaultRoute: defaultRoute,
    linksOf: linksOf,
    isLinked: isLinked,
    gatesOf: gatesOf,
    gateLabel: gateLabel,
    nextStage: nextStage,
    removalTarget: removalTarget,
    position: position,
    termOf: termOf,
    goalOf: goalOf,
    isFinalStep: isFinalStep,
    isGoalStage: isGoalStage,
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
    isWikipediaPhoto: isWikipediaPhoto,

    today: today,
    daysSince: daysSince,
    parseWall: parseWall
  };
})();

if (typeof module === 'object' && module.exports) module.exports = Domain;
