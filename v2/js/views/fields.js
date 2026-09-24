/*
 * 日付欄と時刻のプルダウン。
 * datetime-local の時刻はホイールやタッチパッドで飛びやすいので使わない。
 * 分は 00 / 30 / 59 に絞る（締切でよく使う 59 だけ残す）。ホイールの1カチで次の候補に移れるように。
 */
import { html } from '../html.js';

const MINUTES = ['00', '30', '59'];
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
  return html`<div class="dtf${noTime ? ' no-time' : ''}" id="${id}Wrap"><input class="f dtf-d" type="date" id="${id}D" value="${d}"><select class="f dtf-t" id="${id}H">${hours.map((v) => html`<option value="${v}"${v === hh ? html` selected` : ''}>${v}</option>`)}</select><span class="dtf-c">:</span><select class="f dtf-t" id="${id}M">${mins.map((v) => html`<option value="${v}"${v === mm ? html` selected` : ''}>${v}</option>`)}</select></div>`;
}

/* 入力を 2026-09-23T23:59 の形で取り出す。日付が空なら空文字 */
export function dtValue(id, root = document) {
  const d = root.querySelector('#' + id + 'D');
  if (!d || !d.value) return '';
  const h = root.querySelector('#' + id + 'H'), m = root.querySelector('#' + id + 'M');
  return d.value + 'T' + (h ? h.value : '00') + ':' + (m ? m.value : '00');
}

/* 描き直しの前後で、入力中の値・カーソル位置を保つ。
   裏の再取得で描き直しても、書きかけが消えないようにする */
export function snapFields(root) {
  if (!root) return null;
  const m = { vals: {}, focus: null, sel: null };
  root.querySelectorAll('input,select,textarea').forEach((el) => {
    if (!el.id || el.type === 'file') return;
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

/* 入力中か。裏の再取得で描き直すのを、ここで待たせる */
export function isEditing() {
  const a = document.activeElement;
  return !!(a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
}
