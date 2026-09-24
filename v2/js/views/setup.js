/*
 * 接続設定。ウェブアプリの URL と鍵は、この端末にだけ保存する。
 */
import { html, setHtml } from '../html.js';
import { config, saveConfig, validEndpoint } from '../api.js';

export function renderSetup(msg) {
  const app = document.getElementById('app');
  const dock = document.getElementById('tabbar');
  if (dock) dock.style.display = 'none';
  const side = document.getElementById('side');
  if (side) setHtml(side, html``);
  const c = config();
  setHtml(app, html`<div class="setup"><div class="setupBox"><div class="setupMark">就活</div><div class="setupLead">Apps Script のウェブアプリの URL と鍵を入れてください。<br>この端末にだけ保存され、ページのソースには残りません。</div>${msg && html`<div class="setupErr">${msg}</div>`}<div class="lab">ウェブアプリの URL</div><input class="f" id="cfgEp" placeholder="https://script.google.com/macros/s/.../exec" value="${c.ep}"><div class="lab">鍵</div><input class="f" id="cfgKey" type="password" autocomplete="off" placeholder="スクリプトのプロパティの API_KEY" value="${c.key}" data-enter="setup"><button class="big" style="background:#fff;color:#000" data-act="setup">接続する</button></div></div>`);
}

export function renderConnecting() {
  setHtml(document.getElementById('app'), html`<div class="setup"><div class="setupBox"><div class="setupMark">就活</div><div class="setupLead">接続しています…</div></div></div>`);
}

/* 入力を確かめて保存する。だめなら理由を返す */
export function readSetup() {
  const ep = (document.getElementById('cfgEp') || { value: '' }).value.trim();
  const key = (document.getElementById('cfgKey') || { value: '' }).value.trim();
  if (!validEndpoint(ep)) return 'URL は https://script.google.com/macros/s/.../exec の形です。';
  if (!key) return '鍵を入れてください。';
  saveConfig(ep, key);
  return '';
}
