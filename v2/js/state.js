/*
 * 画面の状態（表示中のページ・区分・絞り込み・開いている会社など）。
 * 表示中のページ・区分・絞り込みと、設定欄の開閉は端末に覚えておく。
 */
import * as storage from './storage.js';

export const TERMS = ['夏インターン', '本選考'];
export const PAGES = ['list', 'pass'];

export const ui = {};

export function resetUi() {
  const saved = storage.getJson('ui', {});
  ui.page = PAGES.includes(saved.page) ? saved.page : 'list';
  ui.term = TERMS.includes(saved.term) ? saved.term : TERMS[0];
  ui.filt = typeof saved.filt === 'string' ? saved.filt : 'all';
  ui.openId = null;         // 詳細を開いている会社の id
  ui.tab = 'info';
  ui.setOpen = storage.get('set_open', '0') === '1';
  ui.endOpen = false;
  ui.skipOpen = false;
  ui.openInChrome = storage.get('chrome', '0') === '1';
}

export function saveUi() {
  storage.setJson('ui', { page: ui.page, term: ui.term, filt: ui.filt });
}

export function setSetOpen(on) {
  ui.setOpen = !!on;
  storage.set('set_open', on ? '1' : '0');
}

export function setOpenInChrome(on) {
  ui.openInChrome = !!on;
  storage.set('chrome', on ? '1' : '0');
}

/* 段階の候補。自分で足した名前は端末に覚えておき、次から候補に出す */
export function stagePalette() {
  const list = Domain.STAGE_CANDIDATES.slice();
  storage.getJson('stages', []).forEach((s) => { if (s && !list.includes(s)) list.push(s); });
  return list;
}

export function rememberStage(name) {
  const a = storage.getJson('stages', []);
  if (name && !a.includes(name)) { a.push(name); storage.setJson('stages', a); }
}

export function isWide() {
  return window.innerWidth >= 1000;
}
