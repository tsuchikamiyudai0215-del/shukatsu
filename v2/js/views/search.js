/*
 * 検索（Cmd/Ctrl+K）。両方の区分から探し、Enter で先頭を開く。
 */
import { html, setHtml } from '../html.js';
import * as store from '../store.js';
import { logo } from '../logo.js';
import { showSheet } from '../ui/sheet.js';

const LABEL = { todo: '対応中', waiting: '結果待ち', offer: '内定', joined: '参加決定', failed: '終了', skipped: '見送り' };

export function openSearch() {
  showSheet(html`<div class="sheet spot"><div class="spotbox"><input id="q" placeholder="会社名を入力" autocomplete="off" data-input="search" data-enter="search-first"><div id="qres"></div></div></div>`);
  searchRun('');
  setTimeout(() => { const q = document.getElementById('q'); if (q) q.focus(); }, 80);
}

export function searchRun(v) {
  const box = document.getElementById('qres');
  if (!box) return;
  const t = String(v || '').trim().toLowerCase();
  const now = new Date();
  const list = store.companies().filter((c) => !t || c.name.toLowerCase().includes(t) ||
    Domain.shortName(c.name).toLowerCase().includes(t)).slice(0, 8);
  setHtml(box, list.length
    ? html`${list.map((c) => html`<button data-act="pick" data-id="${c.id}">${logo(c, 32)}<span class="qn">${Domain.shortName(c.name)}</span><span class="qs">${c.term} ${LABEL[Domain.viewStatus(c, now)]} ${Domain.position(c)}</span></button>`)}`
    : html`<div class="qempty">見つかりません。</div>`);
}
