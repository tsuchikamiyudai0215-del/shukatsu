/*
 * スマホで下から出るシート（詳細・追加・検索）の開閉。
 *
 * ・開くと背景が縮み、下へスワイプすると閉じる
 * ・端末の「戻る」で閉じられるよう、開くときに履歴を1つ積む
 * ・追加と検索は、背景を押して離したときだけ閉じる（入力欄から指を滑らせて外で離したときに閉じないように）。詳細は背景では閉じない
 */
import { setHtml } from '../html.js';
import { isWide } from '../state.js';

const st = { pushed: false, locked: false, lockY: 0, dismissing: false, closeTimer: 0, actTimer: 0, raf1: 0, raf2: 0, downOnBackdrop: false, onClosed: null };

function box() { return document.getElementById('sheet'); }

export function isSheetOpen() {
  const b = box();
  return !!(b && b.firstElementChild);
}

function lockScroll(on) {
  const de = document.documentElement;
  if (on) {
    /* 戻す位置（st.lockY）は showSheet が中身を入れる前に読んでおく。入れたあとに読むと、新しいシートの見た目の計算をその場でさせてしまう */
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

/* 出す動きの予約（2コマ先と時間の保険）を止める。閉じたあとや作り直したあとに、古いシートへ is-active を付けないように */
function stopOpen() {
  clearTimeout(st.actTimer);
  cancelAnimationFrame(st.raf1); cancelAnimationFrame(st.raf2);
  st.raf1 = st.raf2 = 0;
}

/* シートを出す。h は .sheet ごと組み立てた HTML */
export function showSheet(h, opts = {}) {
  clearTimeout(st.closeTimer);
  stopOpen();
  const lock = opts.lockOnWide || !isWide();
  if (lock && !st.locked) st.lockY = window.scrollY;
  const b = box();
  setHtml(b, h);
  if (lock) opened();
  /* 出す動きは2コマ目から始める。1コマ目は、新しいシートの見た目の計算と層づくりに使わせる。
     同じコマに重ねると、出始めの数コマが飛ぶ。画面が裏にあると描画が止まるので、時間でも出す */
  const activate = () => {
    st.raf1 = st.raf2 = 0;
    clearTimeout(st.actTimer);
    const sh = b.querySelector('.sheet');
    if (sh && !sh.classList.contains('out')) sh.classList.add('is-active');
  };
  st.raf1 = requestAnimationFrame(() => { st.raf2 = requestAnimationFrame(activate); });
  st.actTimer = setTimeout(activate, 80);
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
  stopOpen();
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
  stopOpen();
  box().innerHTML = '';
  unlock();
  fn();
}

/* 画面の幅が変わったときなどに、アニメーション無しで片付ける */
export function dropSheet() {
  clearTimeout(st.closeTimer);
  stopOpen();
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
  let y0 = 0, x0 = 0, t0 = 0, dy = 0, active = false, tracking = false, raf = 0;

  /* 指の下にある入れ物（会社名の候補など）のどれかが下へスクロールしてあれば、閉じずにスクロールを優先する */
  const scrolled = (from) => {
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

  /* 指の動きを止められる見張り（passive: false）は、閉じる動きになりうるときだけ付ける。
     付けっぱなしだと、中身を普通にスクロールするときも、ブラウザが毎回この処理を待つので、スクロールがなめらかにならない */
  const onMove = (e) => {
    if (!tracking || e.touches.length !== 1) return;
    const cy = e.touches[0].clientY, cx = e.touches[0].clientX;
    const vdy = cy - y0, vdx = cx - x0;
    if (!active) {
      /* 横に動かした・上へ動かした（中身のスクロール）なら、ブラウザに任せて見張りを外す */
      if (Math.abs(vdx) > Math.abs(vdy) || vdy < -6) { tracking = false; unwatch(); return; }
      /* いちばん上から下へ引くときは、中身の跳ね返り（ブラウザのスクロール）を最初から止める。
         始まってしまうと、あとから止められず、カードの動きと取り合ってカクつく */
      if (vdy > 0 && e.cancelable) e.preventDefault();
      if (vdy > 6) { active = true; card.classList.add('drag'); } else return;
    }
    dy = vdy;
    if (!raf) raf = requestAnimationFrame(apply);
    if (e.cancelable) e.preventDefault();
  };
  const unwatch = () => card.removeEventListener('touchmove', onMove);

  card.addEventListener('touchstart', (e) => {
    /* 引いている途中で2本目の指が触れたときは、見張りを外さない（外すと、指を離すまでシートが途中で止まる） */
    if (e.touches.length !== 1) return;
    unwatch();
    /* キーボードが出ている間は入力中なので、スワイプで閉じない（候補を見ようとして消えてしまう） */
    if (document.body.classList.contains('kb-open')) { tracking = false; return; }
    /* 選考ルートの ≡ は行の並べ替えに使うので、下へ動かしても詳細を閉じない */
    if (e.target.closest && e.target.closest('.rgrip')) { tracking = false; return; }
    /* 中をスクロールしてあるときは閉じない。上まで戻したら、指を離してもう一度引くと閉じる（iPhone の標準のシートと同じ） */
    if (scrolled(e.target)) { tracking = false; return; }
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX;
    t0 = Date.now(); dy = 0; active = false; tracking = true;
    card.classList.remove('spring', 'fly');
    card.addEventListener('touchmove', onMove, { passive: false });
  }, { passive: true });

  const end = () => {
    unwatch();
    if (!tracking) return;
    tracking = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!active) return;
    active = false;
    const v = dy / Math.max(1, Date.now() - t0);
    if (dy > 96 || v > 0.5) dismiss(); else bounce();
  };
  card.addEventListener('touchend', end, { passive: true });
  card.addEventListener('touchcancel', end, { passive: true });

  function bounce() {
    card.classList.remove('drag');
    card.classList.add('spring');
    card.style.transform = '';
  }
  function dismiss() {
    /* 高さはクラスを変える前に読む。変えたあとに読むと、その場で見た目の計算をさせてしまう */
    const h = window.innerHeight;
    card.classList.remove('drag');
    card.classList.add('fly');
    card.style.transform = 'translate3d(0,' + Math.max(h, dy + 400) + 'px,0) scale(.96)';
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
    /* 詳細は、何もないところを押しただけでは閉じない（入力の途中でうっかり消える）。× か下へのスワイプで閉じる */
    if (box().querySelector('.card.detail')) return;
    if (e.target.classList && e.target.classList.contains('sheet') && st.downOnBackdrop) closeSheet();
  };
  window.addEventListener('popstate', onPop);
  const b = box();
  b.addEventListener('pointerdown', onDown, true);
  b.addEventListener('click', onClick);
  return () => {
    clearTimeout(st.closeTimer);
    stopOpen();
    window.removeEventListener('popstate', onPop);
    b.removeEventListener('pointerdown', onDown, true);
    b.removeEventListener('click', onClick);
  };
}
