/*
 * iPhone の「探す」「設定」と同じ並べ方のまとまり。詳細と追加の画面で使う。
 * 頭に色の丸いアイコンと太字の見出し、その下に行（入力の欄・押せる文字の行）を細い線で区切って並べる。
 */
import { html } from '../html.js';

/* まとまりの頭に置く、色の丸のアイコン */
export const ICONS = {
  due: html`<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/></svg>`,
  wait: html`<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10M7 20h10M8 4c0 5 8 5 8 8s-8 3-8 8M16 4c0 5-8 5-8 8"/></svg>`,
  day: html`<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><rect x="4.5" y="6" width="15" height="13.5" rx="2.5"/><path d="M4.5 10.5h15M9 4v3.5M15 4v3.5"/></svg>`,
  key: html`<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.5" cy="12" r="3.5"/><path d="M12 12h8M17 12v3M20 12v2"/></svg>`,
  more: html`<svg viewBox="0 0 24 24" fill="#fff"><circle cx="6.5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="17.5" cy="12" r="1.9"/></svg>`,
  plus: html`<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg>`,
  list: html`<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M9 7h10M9 12h10M9 17h10"/><circle cx="5" cy="7" r=".6"/><circle cx="5" cy="12" r=".6"/><circle cx="5" cy="17" r=".6"/></svg>`,
  flag: html`<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 20V4.5M6 5h11l-2.5 4L17 13H6"/></svg>`,
  building: html`<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20V5.5h9V20M14 10h5v10M3.5 20h17M8 9h3M8 12.5h3M8 16h3"/></svg>`,
  tag: html`<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5V5h7.5L20 13.5 13.5 20z"/><circle cx="8" cy="9" r="1.2"/></svg>`,
  pencil: html`<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19l1-4L16 5l3 3L9 18z"/></svg>`,
  split: html`<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4v6a4 4 0 004 4h8M14 10l4 4-4 4M6 20v-2"/></svg>`,
  photo: html`<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5.5" width="16" height="13" rx="2.5"/><circle cx="9" cy="10" r="1.5"/><path d="M5 17l4.5-4 3 2.5 3-3L19 16"/></svg>`,
  trash: html`<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 7V4.8h4V7M7 7l1 12h8l1-12"/></svg>`
};

/* 見出しつきのまとまり。中身は行を並べ、行どうしは細い線で区切る */
export const section = (icon, color, title, body) => html`<section class="ig"><div class="ig-head"><span class="ig-ic" style="background:${color}">${ICONS[icon]}</span><span class="ig-title">${title}</span></div>${body}</section>`;

/* まとまりの中の、押せる行。文字だけで、色で意味を分ける（青：ふつう、赤：やめる方向） */
export const rowBtn = (act, text, tone) => html`<button class="irow ${tone || ''}" data-act="${act}">${text}</button>`;
