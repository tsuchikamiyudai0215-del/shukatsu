/*
 * 接続設定。ウェブアプリの URL と鍵は、この端末にだけ保存する。
 */
import { html, setHtml } from '../html.js';
import { config, saveConfig, validEndpoint, hasConfig } from '../api.js';
import * as storage from '../storage.js';

/* msg があれば赤枠で出す。つながっている状態から開いたときは「やめる」も出す */
export function renderSetup(msg, canCancel) {
  const app = document.getElementById('app');
  const dock = document.getElementById('tabbar');
  if (dock) dock.style.display = 'none';
  const side = document.getElementById('side');
  if (side) setHtml(side, html``);
  const c = config();
  setHtml(app, html`<div class="setup"><div class="setupBox"><div class="setupMark">就活</div><div class="setupLead">Apps Script のウェブアプリの URL と鍵を入れてください。<br>この端末にだけ保存され、ページのソースには残りません。</div>${msg && html`<div class="setupErr">${msg}</div>`}<div class="lab">ウェブアプリの URL</div><input class="f" id="cfgEp" placeholder="https://script.google.com/macros/s/.../exec" value="${c.ep}"><div class="lab">鍵</div><input class="f" id="cfgKey" type="password" autocomplete="off" placeholder="スクリプトのプロパティの API_KEY" value="${c.key}" data-enter="setup"><button class="big" style="background:#fff;color:#000" data-act="setup">接続する</button>${canCancel && hasConfig() && html`<button class="big" style="background:rgba(255,255,255,.1);color:var(--text);font-weight:500" data-act="setup-cancel">やめる</button>`}</div></div>`);
}

export function renderConnecting() {
  setHtml(document.getElementById('app'), html`<div class="setup"><div class="setupBox"><div class="setupMark">就活</div><div class="setupLead">接続しています…</div></div></div>`);
}

/**
 * 入力を確かめて保存する。戻り値は { err: だめな理由, changed: 接続先が変わったか }。
 * 接続先（シート）が変わると会社の id も変わるので、id で覚えている端末の保存を捨てる。
 * 一覧の控え・画像ファイルのロゴ・旧版の手動ロゴを写した印。印を消すので、旧版の手動ロゴは新しい接続先の id で写し直される。
 */
export function readSetup() {
  const ep = (document.getElementById('cfgEp') || { value: '' }).value.trim();
  const key = (document.getElementById('cfgKey') || { value: '' }).value.trim();
  if (!validEndpoint(ep)) return { err: 'URL は https://script.google.com/macros/s/.../exec の形です。' };
  if (!key) return { err: '鍵を入れてください。' };
  const prev = config().ep;
  const changed = !!prev && prev !== ep;
  if (changed) ['cache', 'file_logos', 'legacy_logos_done'].forEach(storage.remove);
  saveConfig(ep, key);
  return { err: '', changed };
}
