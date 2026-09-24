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

/**
 * 呼び出す。失敗したら、画面にそのまま出せる文言の Error を投げる。
 * ほかの端末とぶつかったときは err.conflict と err.company を付ける。
 * keepalive は、画面を閉じる間際に送り切るときに使う。
 */
export async function call(action, args, opts = {}) {
  const { ep, key } = config();
  if (!ep || !key) throw new Error('接続設定がありません。');
  let res;
  try {
    res = await window.fetch(ep, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key, action, args: args || {} }),
      redirect: 'follow',
      keepalive: !!opts.keepalive
    });
  } catch (e) {
    throw new Error('通信できませんでした。');
  }
  if (!res.ok) throw new Error('通信に失敗しました（' + res.status + '）。');
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    /* Apps Script が止まると HTML のエラーページが返る */
    throw new Error(/<html/i.test(text) ? 'GAS でエラーが起きました。実行ログを見てください。' : '応答の形が違います。');
  }
  if (j && j.ok === false) {
    const err = new Error(j.error === 'unauthorized' ? '鍵が違います。' : String(j.error || 'エラーが起きました。'));
    if (j.conflict) { err.conflict = true; err.company = j.company; }
    throw err;
  }
  return j;
}
