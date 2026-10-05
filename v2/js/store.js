/*
 * データの保持と保存。
 *
 * 会社ごとに「サーバーで確定した写し」と「まだ確定していない操作の列」を持つ。
 * 画面に出すのは、確定した写しに、未確定の操作を Domain.apply で順にかけたもの。
 * こうしておくと、
 *   ・保存を待たずに画面を先に変えられる
 *   ・失敗した操作だけを列から外せば、元に戻る（ほかの操作は巻き込まない）
 *   ・裏で最新を取り直しても、未確定の操作は消えずに上に乗る
 * 操作は会社ごとに1つずつ送る。前の応答の updatedAt を次の操作に付けるため。
 * ルートの編集は 400ms 待ってから送り、その間の編集は1つにまとめる。
 */
import { call, note } from './api.js';
import * as storage from './storage.js';

const s = {};

export function resetStore() {
  clearData();
  s.listeners = [];
  s.errorListeners = [];
}

/* データだけを捨てる（接続設定をやり直すとき）。見張りの登録は残す */
export function clearData() {
  if (s.timers) s.timers.forEach((t) => clearTimeout(t));
  s.confirmed = new Map();   // id → サーバーで確定した会社
  s.order = [];              // シートの並び
  s.events = [];
  s.queues = new Map();      // id → 未確定の操作の列
  s.inflight = new Set();    // 送っている最中の会社
  s.timers = new Map();
  s.loaded = false;
}

export function onChange(fn) { s.listeners.push(fn); }
export function onError(fn) { s.errorListeners.push(fn); }

function emit(kind) { s.listeners.forEach((fn) => { try { fn(kind); } catch (e) { console.error(e); } }); }
function report(e, op) { s.errorListeners.forEach((fn) => { try { fn(e, op); } catch (x) { console.error(x); } }); }

function queueOf(id) {
  if (!s.queues.has(id)) s.queues.set(id, []);
  return s.queues.get(id);
}

function view(id) {
  let c = s.confirmed.get(id);
  if (!c) return null;
  for (const q of s.queues.get(id) || []) {
    /* 確定した写しが変わって、前は通った操作が通らなくなったら、その操作は見た目に乗せない */
    try { c = Domain.apply(c, Object.assign({}, q.args, { type: q.op }), q.at); } catch (e) { /* 何もしない */ }
  }
  return c;
}

// ============================================================
// 読む
// ============================================================

export function loaded() { return s.loaded; }

export function companies() {
  return s.order.map(view).filter(Boolean);
}

export function company(id) { return view(id); }

export function events() { return s.events.slice(); }

export function eventsOf(companyId) {
  return s.events.filter((e) => e.companyId === companyId);
}

export function hasPending() {
  for (const q of s.queues.values()) if (q.length) return true;
  return false;
}

// ============================================================
// 取り込む
// ============================================================

function saveCache() {
  storage.setJson('cache', { companies: s.order.map((id) => s.confirmed.get(id)), events: s.events, at: Date.now() });
}

/* 区分を今の名前にそろえる。前の名前（夏インターン）のままの行や端末の控えでも、一覧から消えないように */
function tidy(c) {
  const term = Domain.termOf(c.term);
  return c.term === term ? c : Object.assign({}, c, { term });
}

/* サーバーの一覧を丸ごと取り込む。未確定の操作は列に残るので、見た目は消えない */
function adopt(data) {
  const prev = s.confirmed;
  s.confirmed = new Map();
  s.order = [];
  for (const raw of data.companies || []) {
    if (!raw || !raw.id) continue;
    const c = tidy(raw);
    /* 裏で取った一覧が、直前に保存した応答より古いことがある。新しい方を残す */
    const old = prev.get(c.id);
    s.confirmed.set(c.id, old && String(old.updatedAt) > String(c.updatedAt) ? old : c);
    s.order.push(c.id);
  }
  s.events = Array.isArray(data.events) ? data.events.slice() : [];
  for (const id of Array.from(s.queues.keys())) if (!s.confirmed.has(id)) s.queues.delete(id);
  s.loaded = true;
}

/* 1社分の応答を取り込む。events を渡したら、その会社の予定も入れ替える */
function adoptCompany(raw, evs) {
  if (!raw || !raw.id) return;
  const c = tidy(raw);
  const old = s.confirmed.get(c.id);
  if (!old || String(c.updatedAt) >= String(old.updatedAt)) s.confirmed.set(c.id, c);
  if (!s.order.includes(c.id)) s.order.push(c.id);
  if (Array.isArray(evs)) s.events = s.events.filter((e) => e.companyId !== c.id).concat(evs);
}

function forget(id) {
  s.confirmed.delete(id);
  s.queues.delete(id);
  s.order = s.order.filter((x) => x !== id);
  s.events = s.events.filter((e) => e.companyId !== id);
}

/* 端末に残っている分を先に出す。無ければ false */
export function loadCache() {
  const c = storage.getJson('cache', null);
  if (!c || !Array.isArray(c.companies)) return false;
  adopt(c);
  emit('cache');
  return true;
}

export async function refresh() {
  /* 読むだけなので、通信が一瞬切れたくらいなら2回までやり直す */
  const r = await call('getData', {}, { retry: 2, expect: 'companies' });
  /* 手元に会社があるのに0社で返ってきたら、取り込まない。全部消した覚えは無いはずなので、
     GAS 側の一時的な読み違いとみなし、画面と端末の控えを空で上書きしない */
  const had = s.order.length;
  if (had && !(Array.isArray(r.companies) && r.companies.length)) {
    note('空の一覧', '取り込まずに ' + had + '社を残した');
    throw new Error('サーバーから空の一覧が返ってきました。手元の一覧はそのまま残します。');
  }
  adopt(r);
  saveCache();
  emit('fetched');
  return r;
}

// ============================================================
// 書く
// ============================================================

/**
 * 1社への操作。先に画面を変え、裏で送る。
 * できない操作なら、画面を変えずに Error を投げる（文言はそのまま画面に出せる）。
 * delay を付けると、その時間だけ待ってから送り、待っている間の同じ操作は1つにまとめる。
 */
export function mutate(id, op, args = {}, opts = {}) {
  const c = view(id);
  if (!c) throw new Error('会社が見つかりません。');
  const at = new Date();
  Domain.apply(c, Object.assign({}, args, { type: op }), at);

  const q = queueOf(id);
  const last = q[q.length - 1];
  const sendAt = Date.now() + (opts.delay || 0);
  let item;
  if (opts.delay && !opts.alone && last && last.op === op && !last.sent) {
    last.args = args;
    last.at = at;
    last.sendAt = sendAt;
    item = last;
  } else {
    item = { op, args, at, sendAt, sent: false };
    q.push(item);
  }
  /* 「取り消す」の待ち時間中にアプリを閉じても消えないよう、端末にも控える */
  if (opts.durable) {
    const base = s.confirmed.get(id);
    item.durable = true;
    item.base = base ? String(base.updatedAt) : '';
    saveOutbox();
  }
  emit('local');
  pump(id);
  return item;
}

/**
 * まだ送っていない操作を取り下げる（「取り消す」）。送ったあとなら false。
 * 送る前に捨てるので、サーバーには何も届かず、締切などの値もそのまま残る
 */
export function cancel(id, item) {
  const q = s.queues.get(id);
  const i = q ? q.indexOf(item) : -1;
  if (i < 0 || item.sent) return false;
  q.splice(i, 1);
  if (i === 0) clearTimeout(s.timers.get(id));
  saveOutbox();
  emit('local');
  pump(id);
  return true;
}

/* 待たせている操作の控え。届いたか取り消したら消す */
function saveOutbox() {
  const list = [];
  for (const [id, q] of s.queues) {
    for (const it of q) if (it.durable) list.push({ id, op: it.op, args: it.args, at: it.at.toISOString(), base: it.base });
  }
  if (list.length) storage.setJson('outbox', list);
  else storage.remove('outbox');
}

/**
 * 前に開いていたときに送れなかった操作を送り直す。最新を取ったあとに呼ぶ。
 * サーバーの会社が控えたときのまま（updatedAt が同じ）のときだけ送る。
 * 変わっていれば、実は届いていたか、ほかで変わったので、二重に保存しないよう捨てる
 */
export function replayOutbox() {
  const list = storage.getJson('outbox', []);
  storage.remove('outbox');
  let n = 0;
  for (const r of Array.isArray(list) ? list : []) {
    const c = s.confirmed.get(r.id);
    if (!c || String(c.updatedAt) !== r.base || (s.queues.get(r.id) || []).length) continue;
    queueOf(r.id).push({ op: r.op, args: r.args || {}, at: new Date(r.at), sendAt: 0, sent: false, durable: true, base: r.base });
    n++;
  }
  if (!n) return 0;
  saveOutbox();
  emit('local');
  for (const id of s.queues.keys()) pump(id);
  return n;
}

function pump(id, keepalive) {
  if (s.inflight.has(id)) return;
  const q = s.queues.get(id);
  if (!q || !q.length) return;
  const head = q[0];
  const wait = head.sendAt - Date.now();
  clearTimeout(s.timers.get(id));
  if (wait > 0 && !keepalive) {
    s.timers.set(id, setTimeout(() => pump(id), wait));
    return;
  }
  send(id, head, keepalive);
}

/* 保存したときに変わりうる中身。updatedAt・ロゴ・カレンダーの対応表・フォルダは、操作と関係なく変わるので比べない */
const STATE_KEYS = ['name', 'term', 'status', 'stage', 'route', 'routeLinks', 'lostStage', 'dueAt', 'dueHasTime',
  'submittedAt', 'resultAt', 'url', 'loginId', 'domain', 'industry'];

/* サーバーの最新（server）が、確定した写し（base）にこの操作（item）をかけた形と同じか */
function landed(base, item, server) {
  if (!base || !server) return false;
  let want;
  try { want = Domain.apply(base, Object.assign({}, item.args, { type: item.op }), item.at); } catch (e) { return false; }
  return STATE_KEYS.every((k) => JSON.stringify(want[k] == null ? '' : want[k]) === JSON.stringify(server[k] == null ? '' : server[k]));
}

/* 一時的に送れなかった保存を、もう一度送るまでの間。少しずつ延ばす */
let RESEND_MS = [5000, 15000, 30000, 60000];
/* テストで縮めるため */
export function setResendWait(list) { RESEND_MS = list; }

async function send(id, item, keepalive) {
  s.inflight.add(id);
  item.sent = true;
  const base = s.confirmed.get(id);
  /* 送り直しの前に、もう届いているかを確かめる。GAS は書き込んだあとの返事で 404 になることがあり、
     そのあと一覧を取り直すと、手元はもう保存後の形になっている。そこへ同じ操作を送ると二重にかかる（通過で2段階進むなど） */
  if (item.first && base && String(base.updatedAt) !== String(item.first.updatedAt) && landed(item.first, item, base)) {
    const q = s.queues.get(id);
    if (q && q[0] === item) q.shift();
    s.inflight.delete(id);
    note('送り直し', 'もう届いていた');
    saveOutbox();
    emit('saved');
    pump(id);
    return;
  }
  if (!item.first) item.first = base;
  let keep = false;
  try {
    /* 通信が切れたときは1回だけやり直す。1回目が実は届いていたら、やり直しは「ほかの端末で変わっている」と返る（下で扱う） */
    const r = await call('mutate', { id, op: item.op, args: item.args, updatedAt: base ? base.updatedAt : '' }, { keepalive, retry: 1, expect: 'company' });
    adoptCompany(r.company, r.events);
    if (r.warning) {
      /* 保存はできたが、カレンダーの一部が直せなかった。失敗とは分けて知らせる */
      const w = new Error(r.warning);
      w.warning = true;
      report(w, item.op);
    } else if (item.tries) {
      const w = new Error('保存できました。');
      w.warning = true;
      w.good = true;
      report(w, item.op);
    }
  } catch (e) {
    /* 前の送信で実は届いていたら、やり直しは「ほかの端末で変わっている」と返る */
    if (e.conflict && e.company && (e.retried || item.tries) && landed(item.first || base, item, e.company)) {
      /* やり直しでぶつかり、しかもサーバーの最新がこの操作をかけたあとの形になっている。1回目が届いて保存できていた。
         最新を出して、失敗とは言わない。形が違うなら、たまたまほかで変わっただけなので、下のふつうの「ぶつかった」として扱う */
      adoptCompany(e.company);
      const q = s.queues.get(id);
      if (q) q.length = 1;
      const w = new Error('通信が一度切れたので、最新を読み直しました。');
      w.warning = true;
      report(w, item.op);
      return;
    }
    if (e.conflict && e.company) {
      adoptCompany(e.company);
      /* 古い画面を見て押した続きの操作も、送らずに捨てる */
      const q = s.queues.get(id);
      if (q) q.length = 1;
    } else if (e.transient) {
      /* 通信や GAS の一時的な失敗。捨てて画面を戻すと「保存できない」になるので、列に残して少し置いてから送り直す。
         アプリを閉じても消えないよう、端末にも控える */
      keep = true;
      item.sent = false;
      item.tries = (item.tries || 0) + 1;
      item.sendAt = Date.now() + RESEND_MS[Math.min(item.tries - 1, RESEND_MS.length - 1)];
      if (!item.durable) { item.durable = true; item.base = item.first ? String(item.first.updatedAt) : ''; }
      if (item.tries === 1) {
        const w = new Error('つながりにくいので、保存はあとで自動で送り直します。');
        w.warning = true;
        report(w, item.op);
      }
      return;
    }
    report(e, item.op);
  } finally {
    const q = s.queues.get(id);
    if (!keep && q && q[0] === item) q.shift();
    s.inflight.delete(id);
    /* 届いた（または失敗を知らせた）ので、控えから外す。応答を受け取れずにページが閉じたら控えは残り、次に開いたときに確かめる */
    saveOutbox();
    saveCache();
    emit('saved');
    pump(id);
  }
}

/* 待たせている操作を今すぐ送る。画面を離れるときに呼ぶ */
export function flush(keepalive) {
  for (const [id, q] of s.queues) {
    if (!q.length || s.inflight.has(id)) continue;
    q[0].sendAt = 0;
    pump(id, keepalive);
  }
}

/**
 * 会社の追加・削除・予定など、先に画面を変えない操作。結果を取り込んでから返す。
 * パスワードの取り出しはここを通さない（手元に残さないため）。
 */
export async function run(action, args) {
  const r = await call(action, args);
  if (action === 'deleteCompany') forget(args.id);
  else if (r.company) adoptCompany(r.company, r.events);
  saveCache();
  emit('run');
  return r;
}

/* ロゴだけを書く。updatedAt は変わらないので、ほかの操作とはぶつからない */
export async function saveLogo(id, logo, manual) {
  const r = await call('saveLogo', { id, logo, manual: !!manual });
  const cur = s.confirmed.get(id);
  if (cur && r.company) s.confirmed.set(id, Object.assign({}, cur, { logo: r.company.logo, logoManual: r.company.logoManual }));
  saveCache();
  return r;
}

/* ロゴの見た目だけ先に変える（自動で見つけたとき） */
export function setLogoLocal(id, logo, manual) {
  const cur = s.confirmed.get(id);
  if (cur) s.confirmed.set(id, Object.assign({}, cur, { logo, logoManual: !!manual }));
}
