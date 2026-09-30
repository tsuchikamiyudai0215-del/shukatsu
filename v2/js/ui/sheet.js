/*
 * スマホで下から出るシート（詳細・追加・検索）の開閉。
 *
 * ・開くと背景が縮み、下へスワイプすると閉じる
 * ・端末の「戻る」で閉じられるよう、開くときに履歴を1つ積む
 * ・背景を押して離したときだけ閉じる（入力欄から指を滑らせて外で離したときに閉じないように）
 */
import { setHtml } from '../html.js';
import { isWide } from '../state.js';

const st = { pushed: false, locked: false, lockY: 0, dismissing: false, closeTimer: 0, downOnBackdrop: false, onClosed: null };

function box() { return document.getElementById('sheet'); }

export function isSheetOpen() {
  const b = box();
  return !!(b && b.firstElementChild);
}

function lockScroll(on) {
  const de = document.documentElement;
  if (on) {
    st.lockY = window.scrollY;
    de.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
  } else {
    de.style.overflow = '';
    document.body.style.overflow = '';
    window.scrollTo(0, st.lockY);
  }
}

function unlock() {
  if (st.locked) { st.locked = false; lockScroll(false); }
}

/* シートを出す。h は .sheet ごと組み立てた HTML */
export function showSheet(h, opts = {}) {
  clearTimeout(st.closeTimer);
  const b = box();
  setHtml(b, h);
  /* 次の描画で出す（出す動きを見せるため）。画面が裏にあると描画が止まるので、時間でも出す */
  const activate = () => {
    const sh = b.querySelector('.sheet');
    if (sh && !sh.classList.contains('out')) sh.classList.add('is-active');
  };
  requestAnimationFrame(activate);
  setTimeout(activate, 60);
  const card = b.querySelector('.card');
  if (card && card.classList.contains('noblur')) {
    setTimeout(() => { const c = b.querySelector('.card'); if (c) c.classList.remove('noblur'); }, 620);
  }
  if (opts.lockOnWide || !isWide()) opened();
}

function opened() {
  if (!st.locked) { st.locked = true; lockScroll(true); }
  document.body.classList.add('sheet-open');
  if (!st.pushed) { st.pushed = true; window.history.pushState({ sheet: 1 }, ''); }
  bindGesture();
}

/* 閉じる。履歴を積んでいれば戻る操作で閉じ、popstate で後片付けする */
export function closeSheet() {
  if (!isSheetOpen()) return;
  if (!isWide() && st.pushed) { window.history.back(); return; }
  closeOverlay();
}

function closeOverlay() {
  const b = box();
  const sh = b.querySelector('.sheet');
  document.body.classList.remove('sheet-open');

  if (st.dismissing || !sh) {
    st.dismissing = false;
    clearTimeout(st.closeTimer);
    b.innerHTML = '';
    unlock();
    if (st.onClosed) st.onClosed();
    return;
  }
  const c = sh.querySelector('.card');
  if (c) c.classList.add('noblur');
  sh.classList.remove('is-active');
  sh.classList.add('out');
  clearTimeout(st.closeTimer);
  st.closeTimer = setTimeout(() => {
    /* 閉じている間に別のシートが開いていたら、そちらは消さない */
    if (sh.parentNode !== b) return;
    b.innerHTML = '';
    unlock();
    if (st.onClosed) st.onClosed();
  }, 300);
}

/* 閉じたうえで、閉じ終わってから次の処理をする（検索から詳細へ移るときなど） */
export function closeThen(fn) {
  if (!isSheetOpen()) { fn(); return; }
  if (!isWide() && st.pushed) {
    let done = false;
    const after = () => {
      if (done) return;
      done = true;
      window.removeEventListener('popstate', after);
      setTimeout(fn, 260);
    };
    window.addEventListener('popstate', after);
    setTimeout(after, 700);
    window.history.back();
    return;
  }
  clearTimeout(st.closeTimer);
  box().innerHTML = '';
  unlock();
  fn();
}

/* 画面の幅が変わったときなどに、アニメーション無しで片付ける */
export function dropSheet() {
  clearTimeout(st.closeTimer);
  const b = box();
  if (b) b.innerHTML = '';
  unlock();
  document.body.classList.remove('sheet-open');
}

function bindGesture() {
  const card = document.querySelector('#sheet .card');
  if (!card || card.dataset.bound) return;
  card.dataset.bound = '1';
  const sheet = card.parentNode;
  let y0 = 0, x0 = 0, t0 = 0, dy = 0, active = false, tracking = false, raf = 0, from = null;

  /* 指の下にある入れ物（会社名の候補など）のどれかが下へスクロールしてあれば、閉じずにスクロールを優先する */
  const scrolled = () => {
    const pane = card.querySelector('.tab-pane');
    if (pane && pane.scrollTop > 0) return true;
    for (let el = from; el && el !== sheet; el = el.parentNode) if (el.scrollTop > 0) return true;
    return false;
  };
  const apply = () => {
    raf = 0;
    if (!active) return;
    const d = Math.max(0, dy);
    card.style.transform = 'translate3d(0,' + d + 'px,0) scale(' + Math.max(0.9, 1 - d / 2400) + ')';
  };

  card.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    /* キーボードが出ている間は入力中なので、スワイプで閉じない（候補を見ようとして消えてしまう） */
    if (document.body.classList.contains('kb-open')) { tracking = false; return; }
    /* 選考ルートの ≡ は行の並べ替えに使うので、下へ動かしても詳細を閉じない */
    if (e.target.closest && e.target.closest('.rgrip')) { tracking = false; return; }
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX;
    t0 = Date.now(); dy = 0; active = false; tracking = true; from = e.target;
    card.classList.remove('spring', 'fly');
  }, { passive: true });

  card.addEventListener('touchmove', (e) => {
    if (!tracking || e.touches.length !== 1) return;
    if (active && !card.classList.contains('noblur')) card.classList.add('noblur');
    const cy = e.touches[0].clientY, cx = e.touches[0].clientX;
    const vdy = cy - y0, vdx = cx - x0;
    if (!active) {
      if (Math.abs(vdx) > Math.abs(vdy)) { tracking = false; return; }
      /* 中を上にスクロールしてある間は、スワイプで閉じない */
      if (scrolled()) { y0 = cy; t0 = Date.now(); return; }
      /* いちばん上から下へ引くときは、中身の跳ね返り（ブラウザのスクロール）を最初から止める。
         始まってしまうと、あとから止められず、カードの動きと取り合ってカクつく */
      if (vdy > 0 && e.cancelable) e.preventDefault();
      if (vdy > 6) { active = true; card.classList.add('drag'); } else return;
    }
    dy = vdy;
    if (!raf) raf = requestAnimationFrame(apply);
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  const end = () => {
    if (!tracking) return;
    tracking = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!active) return;
    active = false;
    const v = dy / Math.max(1, Date.now() - t0);
    if (dy > 96 || v > 0.5) dismiss(); else bounce();
  };
  card.addEventListener('touchend', end);
  card.addEventListener('touchcancel', end);

  function bounce() {
    card.classList.remove('drag');
    card.classList.add('spring');
    card.style.transform = '';
    setTimeout(() => card.classList.remove('noblur'), 600);
  }
  function dismiss() {
    card.classList.remove('drag');
    card.classList.add('fly', 'noblur');
    card.style.transform = 'translate3d(0,' + Math.max(window.innerHeight, dy + 400) + 'px,0) scale(.96)';
    card.style.opacity = '0';
    sheet.classList.remove('is-active');
    sheet.classList.add('out');
    document.body.classList.remove('sheet-open');
      st.dismissing = true;
    setTimeout(() => {
      if (!isWide() && st.pushed) window.history.back();
      else closeOverlay();
    }, 240);
  }
}

/* 始めるときに1回呼ぶ。止めるための関数を返す */
export function initSheet(onClosed) {
  st.pushed = false; st.locked = false; st.dismissing = false; st.onClosed = onClosed;
  const onPop = () => {
    st.pushed = false;
    if (isSheetOpen()) closeOverlay();
  };
  const onDown = (e) => { st.downOnBackdrop = e.target.classList && e.target.classList.contains('sheet'); };
  const onClick = (e) => {
    if (e.target.classList && e.target.classList.contains('sheet') && st.downOnBackdrop) closeSheet();
  };
  window.addEventListener('popstate', onPop);
  const b = box();
  b.addEventListener('pointerdown', onDown, true);
  b.addEventListener('click', onClick);
  return () => {
    clearTimeout(st.closeTimer);
    window.removeEventListener('popstate', onPop);
    b.removeEventListener('pointerdown', onDown, true);
    b.removeEventListener('click', onClick);
  };
}
