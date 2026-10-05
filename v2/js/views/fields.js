/*
 * 日付欄と時刻のプルダウン。
 * datetime-local の時刻はホイールやタッチパッドで飛びやすいので使わない。
 * 分は 00 / 30 / 59 に絞る（締切でよく使う 59 だけ残す）。ホイールの1カチで次の候補に移れるように。
 * それ以外の分は、いちばん下の「自分で入力…」から数字で入れる。
 */
import { html } from '../html.js';

const MINUTES = ['00', '30', '59'];
const OWN = '__own';
const p2 = (n) => ('0' + n).slice(-2);

/* def は未入力のときに選んでおく時刻。締切は 23:59、予定は 10:00 が現実的 */
export function dtField(id, iso, def, noTime) {
  const s = String(iso || '');
  const has = s.length >= 16;
  const d = s.slice(0, 10);
  const hh = has ? s.slice(11, 13) : String(def || '00:00').slice(0, 2);
  const mm = has ? s.slice(14, 16) : String(def || '00:00').slice(3, 5);
  /* 候補に無い分（たとえば 15）でも、今の値は選べるようにしておく */
  const mins = MINUTES.slice();
  if (mm && !mins.includes(mm)) { mins.push(mm); mins.sort(); }
  const hours = Array.from({ length: 24 }, (_, i) => p2(i));
  /* 時と分は1つの箱にまとめて「23 : 59」と見せる。別々の箱だと、分の箱が選択肢の「自分で入力…」の幅まで広がって間延びする */
  return html`<div class="dtf${noTime ? ' no-time' : ''}" id="${id}Wrap"><input class="f dtf-d" type="date" id="${id}D" value="${d}"><div class="f dtf-tm"><select class="dtf-t" id="${id}H" aria-label="時">${hours.map((v) => html`<option value="${v}"${v === hh ? html` selected` : ''}>${v}</option>`)}</select><span class="dtf-c">:</span><select class="dtf-t" id="${id}M" data-change="minute-pick" aria-label="分">${mins.map((v) => html`<option value="${v}"${v === mm ? html` selected` : ''}>${v}</option>`)}<option value="${OWN}">自分で入力…</option></select><input class="dtf-t dtf-own" id="${id}O" type="number" inputmode="numeric" min="0" max="59" placeholder="分" aria-label="分" style="display:none"></div></div>`;
}

/* 分のプルダウンで「自分で入力…」を選んだら、プルダウンの場所を数字の欄に替える */
export function pickMinute(sel, focus = true) {
  if (sel.value !== OWN) return;
  const own = sel.parentNode && sel.parentNode.querySelector('.dtf-own');
  if (!own) return;
  sel.style.display = 'none';
  own.style.display = '';
  if (focus) own.focus();
}

/* 入力を 2026-09-23T23:59 の形で取り出す。日付が空なら空文字。自分で入れた分が 0〜59 でなければ、理由を投げる */
export function dtValue(id, root = document) {
  const d = root.querySelector('#' + id + 'D');
  if (!d || !d.value) return '';
  const h = root.querySelector('#' + id + 'H'), m = root.querySelector('#' + id + 'M');
  let mm = m ? m.value : '00';
  if (mm === OWN) {
    const v = String((root.querySelector('#' + id + 'O') || {}).value || '').trim();
    if (!/^\d{1,2}$/.test(v) || Number(v) > 59) throw new Error('分は 0〜59 の数字で入れてください。');
    mm = p2(Number(v));
  }
  return d.value + 'T' + (h ? h.value : '00') + ':' + mm;
}

/* 描き直しの前後で、入力中の値・カーソル位置を保つ。
   裏の再取得で描き直しても、書きかけが消えないようにする */
export function snapFields(root) {
  if (!root) return null;
  const m = { vals: {}, focus: null, sel: null };
  root.querySelectorAll('input,select,textarea').forEach((el) => {
    /* data-nokeep の欄は書きかけではなく今の値を表すので、描き直した値のままにする */
    if (!el.id || el.type === 'file' || el.hasAttribute('data-nokeep')) return;
    m.vals[el.id] = el.type === 'checkbox' ? el.checked : el.value;
    if (el === document.activeElement) {
      m.focus = el.id;
      try { m.sel = [el.selectionStart, el.selectionEnd]; } catch (e) { m.sel = null; }
    }
  });
  return m;
}

export function restoreFields(root, m) {
  if (!root || !m) return;
  const byId = (id) => root.querySelector('#' + window.CSS.escape(id));
  Object.keys(m.vals).forEach((id) => {
    const el = byId(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = m.vals[id]; else el.value = m.vals[id];
  });
  /* 「自分で入力…」を選んだままの分は、描き直しても数字の欄を出したままにする */
  root.querySelectorAll('select.dtf-t').forEach((s) => pickMinute(s, false));
  if (m.focus) {
    const f = byId(m.focus);
    if (f) {
      try {
        f.focus({ preventScroll: true });
        if (m.sel && f.setSelectionRange) f.setSelectionRange(m.sel[0], m.sel[1]);
      } catch (e) { /* 選択範囲を持てない欄もある */ }
    }
  }
}

/* 入力中か。裏の再取得で描き直すのを、ここで待たせる。選考ルートの行をつかんで動かしている間も同じ扱い */
export function isEditing() {
  if (document.body && document.body.classList.contains('route-dragging')) return true;
  const a = document.activeElement;
  return !!(a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
}
