/*
 * GAS のウェブアプリとの通信。
 * ウェブアプリの URL と鍵は、この端末の保存領域にだけ置く（ページのソースには残さない）。
 * Content-Type を text/plain にすると、事前の確認（preflight）無しで送れる。
 */
import * as storage from './storage.js';

export function config() {
  return { ep: storage.get('ep', ''), key: storage.get('key', '') };
}

export function hasConfig() {
  const c = config();
  return !!(c.ep && c.key);
}

export function saveConfig(ep, key) {
  storage.set('ep', ep);
  storage.set('key', key);
}

export function clearConfig() {
  ['ep', 'key', 'cache', 'ui'].forEach(storage.remove);
}

/* 本番は Apps Script の URL だけ。手元で試すときだけ localhost も通す */
export function validEndpoint(ep) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(ep) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[\w\/-]*$/.test(ep);
}

/* 応答をこれ以上待たない。GAS は初めの1回が遅いことがあるので長めにとる */
const TIMEOUT_MS = 25000;
/* やり直すまでの間。スマホはアプリを切り替えた直後など、一瞬つながらないことが多い */
const RETRY_WAIT_MS = [1000, 3000];
/* GAS 側の一時的な失敗（混み合い・ロック待ちの時間切れなど）。少し置けば通ることが多い */
const TRANSIENT = /Lock|ロック|timed out|タイムアウト|Service|サービス|混み合|too many|多すぎ/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 通信の記録。「たまに切れる」を後から確かめるため、直近の分だけ端末に残す。
   鍵・送った中身・返ってきた中身は残さない（パスワードが混ざりうるので） */
const LOG_MAX = 40;

export function note(what, result, ms) {
  const d = new Date();
  const p = (v) => ('0' + v).slice(-2);
  const t = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  const log = storage.getJson('netlog', []);
  log.push({ t, what, result: String(result), ms: ms == null ? null : ms, bg: typeof document !== 'undefined' && document.hidden ? 1 : 0 });
  storage.setJson('netlog', log.slice(-LOG_MAX));
}

export function netlog() {
  return storage.getJson('netlog', []);
}

function transient(msg) {
  const e = new Error(msg);
  e.transient = true;
  return e;
}

/* 1回だけ送る。失敗は、やり直してよいもの（transient）と、そうでないものに分けて投げる */
async function once(action, args, opts) {
  const { ep, key } = config();
  if (!ep || !key) throw new Error('接続設定がありません。');
  const ctl = !opts.keepalive && typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : 0;
  let res, text;
  try {
    res = await window.fetch(ep, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key, action, args: args || {} }),
      redirect: 'follow',
      keepalive: !!opts.keepalive,
      signal: ctl ? ctl.signal : undefined
    });
    if (!res.ok) throw transient('通信に失敗しました（' + res.status + '）。');
    text = await res.text();
  } catch (e) {
    if (e.transient) throw e;
    throw transient('通信できませんでした。');
  } finally {
    clearTimeout(timer);
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    /* Apps Script が止まったり混み合ったりすると、HTML のエラーページが返る */
    throw /<html/i.test(text) ? transient('GAS でエラーが起きました。少し待ってから試してください。') : new Error('応答の形が違います。');
  }
  if (j && j.ok === false) {
    const msg = j.error === 'unauthorized' ? '鍵が違います。' : String(j.error || 'エラーが起きました。');
    const err = j.error !== 'unauthorized' && !j.conflict && TRANSIENT.test(msg) ? transient(msg) : new Error(msg);
    if (j.error === 'unauthorized') err.unauthorized = true;
    if (j.conflict) { err.conflict = true; err.company = j.company; }
    throw err;
  }
  return j;
}

/**
 * 呼び出す。失敗したら、画面にそのまま出せる文言の Error を投げる。
 * ・鍵が違うときは err.unauthorized、ほかの端末とぶつかったときは err.conflict と err.company を付ける
 * ・通信が切れた・GAS が一時的に失敗したときは、opts.retry の回数まで少し置いてやり直す。
 *   やり直したあとの失敗には err.retried を付ける（1回目が実は届いていたかもしれないので）
 * ・keepalive は、画面を閉じる間際に送り切るときに使う。やり直さない
 */
export async function call(action, args, opts = {}) {
  const times = opts.keepalive ? 0 : Math.max(0, opts.retry || 0);
  for (let n = 0; ; n++) {
    const t0 = Date.now();
    try {
      const j = await once(action, args, opts);
      note(action, Array.isArray(j.companies) ? 'ok ' + j.companies.length + '社' : 'ok', Date.now() - t0);
      return j;
    } catch (e) {
      note(action, e.message, Date.now() - t0);
      if (n > 0) e.retried = true;
      if (!e.transient || n >= times) throw e;
      await sleep(RETRY_WAIT_MS[Math.min(n, RETRY_WAIT_MS.length - 1)]);
    }
  }
}
