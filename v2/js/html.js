/*
 * HTML を組み立てる道具。
 *
 * html`...` の中に ${} で入れた値は、自動でエスケープする。esc の付け忘れで
 * 会社名などに < や " が入っていても、画面が壊れたり、スクリプトが動いたりしない。
 * 画面へ入れるときは setHtml を使う。html`` で作ったもの以外は受け付けない。
 */

class SafeHtml {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);
}

function part(v) {
  if (v instanceof SafeHtml) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  /* ${条件 && html`…`} と書けるよう、false と空は何も出さない */
  if (v == null || v === false) return '';
  return esc(v);
}

export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += part(vals[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/* 組み立て済みの HTML を1つにまとめる */
export function join(list) {
  return new SafeHtml(list.map(part).join(''));
}

export function setHtml(el, h) {
  if (!(h instanceof SafeHtml)) throw new Error('html`` で組み立てたものだけを入れる');
  el.innerHTML = h.s;
}

/* 要素ごと置き換える。これも html`` で作ったものだけ */
export function replaceHtml(el, h) {
  if (!(h instanceof SafeHtml)) throw new Error('html`` で組み立てたものだけを入れる');
  el.outerHTML = h.s;
}

/* href や src に入れてよい URL だけを通す。javascript: などは # にする */
export function safeUrl(u) {
  const s = String(u == null ? '' : u).trim();
  if (/^(https?:|googlechromes?:|intent:)/i.test(s)) return s;
  if (/^data:image\/(png|jpe?g|gif|webp);/i.test(s)) return s;
  return '#';
}
