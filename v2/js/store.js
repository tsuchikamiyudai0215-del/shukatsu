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
import { call } from './api.js';
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

/* サーバーの一覧を丸ごと取り込む。未確定の操作は列に残るので、見た目は消えない */
function adopt(data) {
  const prev = s.confirmed;
  s.confirmed = new Map();
  s.order = [];
  for (const c of data.companies || []) {
    if (!c || !c.id) continue;
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
function adoptCompany(c, evs) {
  if (!c || !c.id) return;
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
  const r = await call('getData', {});
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
  if (opts.delay && last && last.op === op && !last.sent) {
    last.args = args;
    last.at = at;
    last.sendAt = sendAt;
  } else {
    q.push({ op, args, at, sendAt, sent: false });
  }
  emit('local');
  pump(id);
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

async function send(id, item, keepalive) {
  s.inflight.add(id);
  item.sent = true;
  const base = s.confirmed.get(id);
  try {
    const r = await call('mutate', { id, op: item.op, args: item.args, updatedAt: base ? base.updatedAt : '' }, { keepalive });
    adoptCompany(r.company, r.events);
    if (r.warning) {
      /* 保存はできたが、カレンダーの一部が直せなかった。失敗とは分けて知らせる */
      const w = new Error(r.warning);
      w.warning = true;
      report(w, item.op);
    }
  } catch (e) {
    if (e.conflict && e.company) {
      adoptCompany(e.company);
      /* 古い画面を見て押した続きの操作も、送らずに捨てる */
      const q = s.queues.get(id);
      if (q) q.length = 1;
    }
    report(e, item.op);
  } finally {
    const q = s.queues.get(id);
    if (q && q[0] === item) q.shift();
    s.inflight.delete(id);
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
