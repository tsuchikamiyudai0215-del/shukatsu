/*
 * 下に出る短いお知らせ（トースト）、上の「更新中…」、保存中の覆い。
 */

let toastTimer = 0;
let staleTimer = 0;
let staleReset = 0;

export function toast(msg, ok) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.borderColor = ok ? 'rgba(48,209,88,.6)' : 'rgba(255,69,58,.6)';
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), ok ? 2200 : 3600);
}

/* msg があれば赤枠で出して、しばらくしたら消す。無ければ「更新中…」を出したままにする */
export function staleShow(msg) {
  const el = document.getElementById('stale');
  if (!el) return;
  clearTimeout(staleTimer);
  clearTimeout(staleReset);
  el.textContent = msg || '更新中…';
  el.style.borderColor = msg ? 'rgba(255,69,58,.5)' : 'rgba(255,255,255,.18)';
  el.classList.add('on');
  if (msg) staleTimer = setTimeout(staleHide, 3200);
}

export function staleHide() {
  const el = document.getElementById('stale');
  if (!el) return;
  clearTimeout(staleTimer);
  el.classList.remove('on');
  clearTimeout(staleReset);
  staleReset = setTimeout(() => {
    el.textContent = '更新中…';
    el.style.borderColor = 'rgba(255,255,255,.18)';
  }, 320);
}

export function busy(on) {
  const el = document.getElementById('busy');
  if (el) el.style.display = on ? 'flex' : 'none';
}

export function clearNoticeTimers() {
  clearTimeout(toastTimer);
  clearTimeout(staleTimer);
  clearTimeout(staleReset);
}

/* 控え帳（クリップボード）へ。Safari は押した直後でないと書けないので、
   中身がまだ届いていないときは、届く約束（Promise）ごと渡す */
export async function copyText(textOrPromise, label) {
  const done = () => toast((label || '') + 'をコピーしました。', true);
  try {
    const nav = window.navigator;
    if (textOrPromise && typeof textOrPromise.then === 'function' && window.ClipboardItem && nav.clipboard && nav.clipboard.write) {
      const blob = textOrPromise.then((t) => new Blob([t], { type: 'text/plain' }));
      await nav.clipboard.write([new window.ClipboardItem({ 'text/plain': blob })]);
      return done();
    }
    const text = await textOrPromise;
    if (nav.clipboard && nav.clipboard.writeText) {
      await nav.clipboard.writeText(text);
      return done();
    }
    if (legacyCopy(text)) return done();
    toast('コピーできませんでした。');
  } catch (e) {
    toast(e && e.message && !/clipboard|denied|allowed/i.test(e.message) ? e.message : 'コピーできませんでした。');
  }
}

function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    ta.value = '';
    return ok;
  } catch (e) {
    return false;
  }
}
