/*
 * 起動と画面の切り替え。
 *
 * クリックなどは document で1か所にまとめて受け、data-act の名前で処理を選ぶ。
 * HTML に onclick を書かないので、画面の文字列から処理が動くことはない。
 * start() で始め、戻り値の関数で止める（テストで何度も起動し直すため）。
 */
import { html, setHtml } from './html.js';
import { ui, resetUi, saveUi, TERMS, isWide } from './state.js';
import * as store from './store.js';
import { hasConfig, clearConfig } from './api.js';
import { resetLogos, hydrate, logoLoaded, logoFailed, onLogoChange, importLegacyManual } from './logo.js';
import { toast, staleShow, staleHide, busy, clearNoticeTimers } from './ui/notice.js';
import { initSheet, closeSheet, closeThen, dropSheet, isSheetOpen } from './ui/sheet.js';
import { attachLiquid } from './ui/liquid.js';
import { renderList, tickHero, applyFilter } from './views/list.js';
import { renderPassport } from './views/passport.js';
import { renderDetail, openDetail, closeDetail, sideEmpty, detailShown, detailActions, detailChanges, onDetailRerender, onToggle } from './views/detail.js';
import { openAdd, suggest, addActions, resetAdd } from './views/add.js';
import { openSearch, searchRun } from './views/search.js';
import { renderSetup, renderConnecting, readSetup } from './views/setup.js';
import { isEditing } from './views/fields.js';

let cleanups = [];
let booted = false;
let detailDirty = false;
let lastFetch = 0;

function listen(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  cleanups.push(() => target.removeEventListener(type, fn, opts));
}

// ============================================================
// 描く
// ============================================================

function hideSplash() {
  if (booted) return;
  booted = true;
  const el = document.getElementById('splash');
  if (el) { el.classList.add('gone'); setTimeout(() => el.remove(), 340); }
}

function ensureShell() {
  if (document.getElementById('view')) return;
  setHtml(document.getElementById('app'), html`<div id="segHost"><div class="seg" id="seg"><span class="pill"></span>${TERMS.map((t, i) => html`<button id="sg${i}" data-act="term" data-v="${i}"><span>${t}</span><span class="sgn"></span></button>`)}</div></div><div id="view"></div>`);
  const dock = document.getElementById('tabbar');
  if (dock) dock.style.display = '';
  attachLiquid(document.getElementById('seg'), ['sg0', 'sg1'], (i) => setTerm(i), (i) => ui.term === TERMS[i]);
  attachLiquid(dock, ['tb-list', 'tb-pass'], (i) => setPage(i === 0 ? 'list' : 'pass'), (i) => (i === 0) === (ui.page === 'list'));
}

function syncPills() {
  const dock = document.getElementById('tabbar');
  if (dock) {
    dock.classList.toggle('p1', ui.page !== 'list');
    const a = document.getElementById('tb-list'), b = document.getElementById('tb-pass');
    if (a) a.className = ui.page === 'list' ? 'on' : '';
    if (b) b.className = ui.page === 'pass' ? 'on' : '';
  }
  const seg = document.getElementById('seg');
  if (!seg) return;
  const all = store.companies();
  TERMS.forEach((t, i) => {
    const b = document.getElementById('sg' + i);
    if (!b) return;
    b.className = ui.term === t ? 'on' : '';
    b.querySelector('.sgn').textContent = all.filter((c) => (c.term || Domain.DEFAULT_TERM) === t).length;
  });
  seg.classList.toggle('i1', ui.term === TERMS[1]);
}

function enter() {
  const el = document.getElementById('view');
  if (!el) return;
  el.classList.remove('enter');
  void el.offsetWidth;
  el.classList.add('enter');
  setTimeout(() => el.classList.remove('enter'), 1000);
}

/* 画面全体を描き直す。入力中は詳細だけ描き直しを待たせ、入力が終わってから描く */
function renderAll(pageChanged) {
  if (!hasConfig()) { renderSetup(); return; }
  /* 自動のロゴ探しより先に、旧版で手で入れたロゴを写しておく（写すのは最初の1回だけ） */
  importLegacyManual(store.companies());
  ensureShell();
  syncPills();
  /* 切り替えの直後（1秒ほど）に保存などで描き直すと、入場の動きがもう一度流れる。切り替え以外では先に外す */
  if (!pageChanged) { const v = document.getElementById('view'); if (v) v.classList.remove('enter'); }
  if (ui.page === 'pass') renderPassport(); else renderList(() => { if (!isEditing()) renderAll(); });
  if (pageChanged) enter();
  if (ui.openId) {
    if (!store.company(ui.openId)) { ui.openId = null; if (isWide()) sideEmpty(); else if (isSheetOpen()) closeSheet(); }
    else if (detailShown() || isWide()) {
      if (isEditing() && editingInDetail()) detailDirty = true; else renderDetail();
    }
  } else if (isWide()) sideEmpty();
  hydrate(store.companies());
}

function editingInDetail() {
  const a = document.activeElement;
  return !!(a && a.closest && a.closest('#side, #sheet .card.detail'));
}

function setTerm(i) {
  ui.term = TERMS[i];
  saveUi();
  window.scrollTo(0, 0);
  renderAll(true);
}

function setPage(p) {
  ui.page = p;
  saveUi();
  window.scrollTo(0, 0);
  renderAll(true);
}

// ============================================================
// 読み込み
// ============================================================

async function refresh(quiet) {
  if (!quiet) staleShow();
  try {
    await store.refresh();
    lastFetch = Date.now();
    staleHide();
    return true;
  } catch (e) {
    if (/鍵/.test(e.message)) { renderSetup(e.message); return false; }
    staleShow('最新を取得できませんでした。');
    return false;
  }
}

function showLoadError(e) {
  hideSplash();
  setHtml(document.getElementById('app'), html`<div style="color:var(--dim);font-size:13px;line-height:1.9;padding:40px 0">読み込めませんでした。<br>${e && e.message ? e.message : ''}<br><br><button class="gh" data-act="reload">再読み込み</button><button class="gh" style="margin-left:8px" data-act="setup-open">接続設定</button></div>`);
}

async function boot() {
  if (!hasConfig()) { hideSplash(); renderSetup(); return; }
  /* 端末に残っている分を先に出し、裏で最新を取る */
  if (store.loadCache()) {
    hideSplash();
    renderAll(true);
    await refresh(false);
    return;
  }
  try {
    await store.refresh();
    lastFetch = Date.now();
    hideSplash();
    renderAll(true);
  } catch (e) {
    if (/鍵/.test(e.message)) { hideSplash(); renderSetup(e.message); return; }
    showLoadError(e);
  }
}

async function connect() {
  const err = readSetup();
  if (err) { renderSetup(err); return; }
  renderConnecting();
  try {
    await store.refresh();
    lastFetch = Date.now();
    setHtml(document.getElementById('app'), html``);
    renderAll(true);
  } catch (e) {
    renderSetup(e.message || '接続できませんでした。');
  }
}

// ============================================================
// 操作
// ============================================================

const actions = Object.assign({
  open: (el) => openDetail(el.dataset.id),
  term: (el) => setTerm(+el.dataset.v),
  page: (el) => setPage(el.dataset.v),
  search: () => openSearch(),
  add: () => { if (!isWide()) ui.openId = null; openAdd(); },
  filt: (el) => {
    const k = el.dataset.v;
    ui.filt = ui.filt === k && k !== 'all' ? 'all' : k;
    saveUi();
    if ((ui.filt === 'end' && !ui.endOpen) || (ui.filt === 'skip' && !ui.skipOpen)) { renderAll(); applyFilter(); return; }
    applyFilter();
  },
  'toggle-lane': (el) => {
    if (el.dataset.v === 'end') ui.endOpen = !ui.endOpen; else ui.skipOpen = !ui.skipOpen;
    renderAll();
    applyFilter();
  },
  pick: (el) => {
    const id = el.dataset.id;
    closeThen(() => {
      const c = store.company(id);
      if (!c) return;
      ui.term = c.term || Domain.DEFAULT_TERM;
      saveUi();
      ui.openId = id;
      ui.tab = 'info';
      renderAll(true);
      renderDetail();
    });
  },
  setup: () => connect(),
  'setup-open': () => renderSetup(),
  reload: () => window.location.reload(),
  'reset-cfg': () => {
    if (!window.confirm('接続設定を消して、やり直しますか。')) return;
    clearConfig();
    store.clearData();
    ui.openId = null;
    renderSetup();
  }
}, detailActions, addActions);

function onClick(e) {
  const el = e.target.closest ? e.target.closest('[data-act]') : null;
  if (!el) return;
  const name = el.dataset.act;
  if (!Object.prototype.hasOwnProperty.call(actions, name)) return;
  if (name !== 'open') e.stopPropagation();
  e.preventDefault();
  try {
    const r = actions[name](el, e);
    if (r && r.catch) r.catch((err) => { busy(false); toast(err.message || 'うまくいきませんでした。'); });
  } catch (err) {
    toast(err.message || 'うまくいきませんでした。');
  }
}

function onInput(e) {
  const k = e.target.dataset && e.target.dataset.input;
  if (k === 'suggest') suggest(e.target.value);
  if (k === 'search') searchRun(e.target.value);
}

function onChange(e) {
  const k = e.target.dataset && e.target.dataset.change;
  if (k && Object.prototype.hasOwnProperty.call(detailChanges, k)) detailChanges[k](e.target);
}

function onKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); return; }
  if (e.key === 'Escape') {
    if (isSheetOpen()) closeSheet();
    else if (isWide() && ui.openId) closeDetail();
    return;
  }
  const k = e.target.dataset && e.target.dataset.enter;
  if (e.key !== 'Enter' || !k || e.isComposing) return;
  e.preventDefault();
  if (k === 'search-first') {
    const f = document.querySelector('#qres button');
    if (f) f.click();
  } else if (Object.prototype.hasOwnProperty.call(actions, k)) {
    actions[k](e.target, e);
  }
}

/* 保存の失敗は、理由をそのまま出す。何が起きたか分からないと直しようがないので */
function onStoreError(e) {
  if (e.conflict || e.warning) toast(e.message);
  else toast('保存できませんでした：' + e.message);
}

// ============================================================
// 引っ張って更新・キーボード・画面の幅
// ============================================================

function pullToRefresh() {
  let y0 = 0, x0 = 0, pulling = false, dist = 0, locked = false, lastScroll = 0;
  const el = () => document.getElementById('ptr');
  const set = (d) => {
    const p = el(); if (!p) return;
    const t = Math.min(1, d / 90);
    p.style.opacity = t.toFixed(2);
    p.style.transform = 'translate3d(-50%,' + Math.min(56, d * 0.6) + 'px,0) scale(' + (0.7 + t * 0.3).toFixed(2) + ')';
    p.querySelector('.ptrRing').style.transform = 'rotate(' + d * 3 + 'deg)';
  };
  const reset = () => {
    const p = el(); if (!p) return;
    p.classList.remove('spin');
    p.style.transition = 'opacity .3s var(--ease),transform .5s var(--spring)';
    p.style.opacity = '0';
    p.style.transform = 'translate3d(-50%,-40px,0) scale(.7)';
    setTimeout(() => { p.style.transition = ''; }, 520);
  };
  listen(window, 'scroll', () => { lastScroll = Date.now(); }, { passive: true });
  listen(document, 'touchstart', (e) => {
    pulling = false; locked = false;
    if (isSheetOpen() || window.scrollY > 0 || Date.now() - lastScroll < 350 || e.touches.length !== 1) return;
    if (e.target.closest && e.target.closest('.chiprow,.tabbar,.seg,.tab-pane,#side')) return;
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX;
    pulling = true; dist = 0;
  }, { passive: true });
  listen(document, 'touchmove', (e) => {
    if (!pulling) return;
    if (e.touches.length !== 1) { pulling = false; reset(); return; }
    const dy = e.touches[0].clientY - y0, dx = e.touches[0].clientX - x0;
    if (!locked) {
      if (Math.abs(dx) > Math.abs(dy)) { pulling = false; reset(); return; }
      if (Math.abs(dy) < 8) return;
      locked = true;
    }
    dist = dy;
    if (dist <= 0 || window.scrollY > 0) { pulling = false; reset(); return; }
    set(dist);
  }, { passive: true });
  listen(document, 'touchend', async () => {
    if (!pulling) return;
    pulling = false;
    if (!(dist > 110 && locked && hasConfig())) { reset(); return; }
    const p = el();
    if (p) { p.classList.add('spin'); p.style.opacity = '1'; p.style.transform = 'translate3d(-50%,40px,0) scale(1)'; }
    if (await refresh(true)) toast('最新に更新しました。', true);
    reset();
  });
}

function keyboardWatch() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    const gap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', gap + 'px');
    document.body.classList.toggle('kb-open', gap > 120);
  };
  listen(vv, 'resize', apply);
  listen(vv, 'scroll', apply);
  apply();
}

// ============================================================
// 始める・止める
// ============================================================

export function start() {
  cleanups = [];
  booted = false;
  detailDirty = false;
  resetUi();
  store.resetStore();
  resetLogos();
  resetAdd();

  /* 最初の描画は boot が行う。それより後の変化だけをここで描き直す */
  store.onChange(() => { if (hasConfig() && document.getElementById('view')) renderAll(); });
  store.onError(onStoreError);
  onLogoChange(() => renderAll());
  /* 入場の動きを見せるのは、区分が切り替わるとき（本選考への引き継ぎ）だけ */
  onDetailRerender((changed) => renderAll(!!changed));
  cleanups.push(initSheet(() => { if (!isWide()) ui.openId = null; renderAll(); }));

  listen(document, 'click', onClick);
  listen(document, 'input', onInput);
  listen(document, 'change', onChange);
  listen(document, 'keydown', onKey);
  listen(document, 'toggle', onToggle, true);
  /* ロゴの読み込み。img の load と error は泡立たないので、捕まえる側で受ける */
  listen(document, 'load', (e) => { if (e.target.tagName === 'IMG' && e.target.closest('.logo')) logoLoaded(e.target); }, true);
  listen(document, 'error', (e) => { if (e.target.tagName === 'IMG' && e.target.closest('.logo')) logoFailed(e.target); }, true);
  /* 入力が終わったら、待たせていた詳細の描き直しをする */
  listen(document, 'focusout', () => setTimeout(() => {
    if (detailDirty && !isEditing()) { detailDirty = false; if (ui.openId) renderDetail(); }
  }, 0));
  /* PCで右パネルの外を押したら閉じる。押し始めと離した所の両方が外のときだけ */
  const OUTSIDE = '#side,.row,.hero,.stripitem,.tabbar,.chips,.seg';
  let outsideDown = false;
  listen(document, 'pointerdown', (e) => { outsideDown = !(e.target.closest && e.target.closest(OUTSIDE)); }, true);
  listen(document, 'click', (e) => {
    if (!isWide() || !ui.openId || isSheetOpen() || !outsideDown) return;
    if (e.target.closest && e.target.closest(OUTSIDE + ',#sheet')) return;
    closeDetail();
  });
  /* 画面を離れるときは、待たせている保存を送り切る */
  listen(document, 'visibilitychange', () => {
    if (document.hidden) { store.flush(true); return; }
    if (!isEditing() && hasConfig() && document.getElementById('view')) {
      renderAll();
      if (Date.now() - lastFetch > 60000) refresh(true);
    }
  });
  listen(window, 'pagehide', () => store.flush(true));
  let wasWide = isWide();
  listen(window, 'resize', () => {
    syncPills();
    if (isWide() === wasWide) return;
    wasWide = isWide();
    dropSheet();
    renderAll(true);
  });
  pullToRefresh();
  keyboardWatch();

  const timer = setInterval(() => { if (ui.page === 'list') tickHero(() => { if (!isEditing()) renderAll(); }); }, 1000);
  cleanups.push(() => clearInterval(timer));

  const ready = boot();
  return {
    ready,
    stop() {
      cleanups.forEach((fn) => { try { fn(); } catch (e) { /* 何もしない */ } });
      cleanups = [];
      store.resetStore();
      resetAdd();
      clearNoticeTimers();
    }
  };
}

/* 画面の幅によるつまみの位置合わせ（読み込み直後はボタンの幅が確定していないことがある） */
export function settlePills() {
  syncPills();
  setTimeout(syncPills, 80);
  setTimeout(syncPills, 300);
}
