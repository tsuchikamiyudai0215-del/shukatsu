/**
 * 就活ボード ─ 外部配信（GitHub Pages）用 JSON API
 *
 * デプロイ設定
 *   実行するユーザー ：自分
 *   アクセスできるユーザー：全員
 *   URLは公開になるが、WA_KEY を知らないと全て弾かれる。
 *
 * 排他ロックはこのファイルの waRoute_ でまとめて取る。
 * WebApp.gs の api* は、必ずロックの内側で呼ばれる前提で書いてある。
 */

/* WA_SS_ID は WebApp.gs 側で定義済み。ここには書かないこと（重複定義エラーになる） */
const WA_KEY = ''; // 鍵は公開リポジトリに置かないため消してある

/* ロックを待つ上限。これを超えたらエラーを返し、画面側でトーストを出す */
const WA_LOCK_WAIT_MS = 20000;
const WA_CACHE_KEY = 'wa_data';
const WA_CACHE_SEC = 25;

/* ---------- 応答ヘルパー ---------- */
function waJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
function waText_(s) {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- ルーター ---------- */
const WA_ACTIONS = {
  apiGetData:       function(a){ return apiGetData(); },
  apiMarkDone:      function(a){ return apiMarkDone(a[0], a[1]); },
  apiMarkPass:      function(a){ return apiMarkPass(a[0], a[1]); },
  apiMarkFail:      function(a){ return apiMarkFail(a[0], a[1]); },
  apiSetStatus:     function(a){ return apiSetStatus(a[0], a[1], a[2]); },
  apiSetRoute:      function(a){ return apiSetRoute(a[0], a[1], a[2], a[3]); },
  apiSetDue:        function(a){ return apiSetDue(a[0], a[1], a[2]); },
  apiSetInfo:       function(a){ return apiSetInfo(a[0], a[1], a[2], a[3]); },
  apiPrevStage:     function(a){ return apiPrevStage(a[0], a[1], a[2]); },
  apiCarryOver:     function(a){ return apiCarryOver(a[0], a[1]); },
  apiAddEvent:      function(a){ return apiAddEvent(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]); },
  apiDeleteEvent:   function(a){ return apiDeleteEvent(a[0]); },
  apiAddCompany:    function(a){ return apiAddCompany(a[0]); },
  apiSaveLogo:      function(a){ return apiSaveLogo(a[0], a[1]); },
  apiDeleteCompany: function(a){ return apiDeleteCompany(a[0], a[1]); },
  apiRenameCompany: function(a){ return apiRenameCompany(a[0], a[1], a[2]); },
  apiSetIndustry:   function(a){ return apiSetIndustry(a[0], a[1], a[2]); },
  apiSplitCompany:  function(a){ return apiSplitCompany(a[0], a[1], a[2]); }
};

/* ---------- 読み取りの短期キャッシュ ---------- */
function waCacheGet_() {
  try { return CacheService.getScriptCache().get(WA_CACHE_KEY); } catch (e) { return null; }
}
function waStore_(json) {
  try { CacheService.getScriptCache().put(WA_CACHE_KEY, json, WA_CACHE_SEC); } catch (e) { /* 100KB 超なら諦める */ }
}
function waBust_() {
  try { CacheService.getScriptCache().remove(WA_CACHE_KEY); } catch (e) {}
}

function waRoute_(payload) {
  if (!payload || payload.key !== WA_KEY) {
    return waJson_({ ok: false, error: 'unauthorized' });
  }
  /* toString などの継承プロパティを関数として呼ばないよう、自前のキーだけ通す */
  if (!Object.prototype.hasOwnProperty.call(WA_ACTIONS, payload.action)) {
    return waJson_({ ok: false, error: 'unknown action: ' + payload.action });
  }
  const fn = WA_ACTIONS[payload.action];
  const lock = LockService.getScriptLock();

  try {
    if (payload.action === 'apiGetData') {
      const hit = waCacheGet_();
      if (hit) return waText_(hit);

      /* キャッシュが無いときの読み直しもロックの中で行う。
         書き込みの途中を読んで古い一覧を25秒間配り続けるのを防ぐため */
      lock.waitLock(WA_LOCK_WAIT_MS);
      try {
        const again = waCacheGet_();          /* 待っている間に誰かが入れていれば使う */
        if (again) return waText_(again);
        const fresh = apiGetData();
        waStore_(fresh);
        return waText_(fresh);
      } finally {
        lock.releaseLock();
      }
    }

    /* 書き込みは1件ずつ。行番号を引いてから書くまでの間に、
       別の処理の autoSort で行が入れ替わると、違う会社に書き込んでしまう */
    lock.waitLock(WA_LOCK_WAIT_MS);
    try {
      waBust_();
      const result = fn(payload.args || []);
      if (typeof result === 'string') {
        /* 全データを返した場合だけ、次の読み取り用に置いておく */
        if (result.indexOf('"items"') !== -1) waStore_(result);
        return waText_(result);
      }
      return waJson_({ ok: true, result: result });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return waJson_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/* ---------- GET（疎通確認と読み取り） ---------- */
function doGet(e) {
  const p = (e && e.parameter) ? e.parameter : {};
  if (p.action) {
    let args = [];
    try { args = p.args ? JSON.parse(p.args) : []; }
    catch (err) { return waJson_({ ok: false, error: 'bad args' }); }
    return waRoute_({ key: p.key, action: p.action, args: args });
  }
  return waJson_({ ok: true, service: '就活ボード API', hint: 'action と key を付けて呼び出してください' });
}

/* ---------- POST（本体） ----------
   Content-Type を text/plain にすると preflight を避けられる。
   フロント側もそう送っている。                                   */
function doPost(e) {
  let payload = {};
  try { payload = JSON.parse(e.postData.contents); }
  catch (err) { return waJson_({ ok: false, error: 'bad payload' }); }
  return waRoute_(payload);
}
