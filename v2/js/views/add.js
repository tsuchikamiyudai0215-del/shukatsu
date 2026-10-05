/*
 * 選考の追加。会社名を2文字入れると Wikidata から候補を出し、選ぶと正式名称とロゴ用ドメインが入る。
 */
import { html, setHtml } from '../html.js';
import { ui, stagePalette } from '../state.js';
import * as store from '../store.js';
import { wdSuggest, wdClaims } from '../logo.js';
import { toast, busy } from '../ui/notice.js';
import { showSheet, closeSheet } from '../ui/sheet.js';
import { dtField, dtValue } from './fields.js';
import { section } from './ig.js';

let sugTimer = 0;
let sugSeq = 0;

/* 段階の選び肢。その区分の初期のルートを先に並べ、あとに「よくある段階」を続ける。
   初期のルートに無い段階を選ぶと、通過したときに次の段階が見つからないので、ふだんは最初の段階（ES）のままにする */
function stageChoices() {
  const list = Domain.defaultRoute(ui.term);
  stagePalette().forEach((s) => { if (!list.includes(s)) list.push(s); });
  return list;
}

export function openAdd() {
  const first = Domain.defaultRoute(ui.term)[0];
  /* 詳細と同じ「探す」の形のまとまりに分ける：会社／マイページ（任意）／選考 */
  const company = section('building', 'var(--blue)', '会社', html`<div class="ig-body"><input class="f" id="nC" placeholder="例：三菱商事" autocomplete="off" data-input="suggest" style="margin:0"><div class="sug" id="nCSug"></div></div>`);
  const mypage = section('key', '#8E8E93', 'マイページ（任意）', html`<div class="ig-body"><div class="ilab">マイページURL</div><input class="f" id="nU" style="margin:0"><div class="ilab" style="margin-top:14px">ログインID</div><input class="f" id="nI" style="margin:0"><div class="ilab" style="margin-top:14px">ロゴ用ドメイン</div><input class="f" id="nD" placeholder="例：mitsubishicorp.com" style="margin:0"></div>`);
  const sel = section('flag', 'var(--go)', '選考', html`<div class="ig-body"><div class="ilab">段階</div><select class="f" id="nS" style="margin:0">${stageChoices().map((p) => html`<option${p === first ? html` selected` : ''}>${p}</option>`)}</select><div class="ilab" style="margin-top:14px">締切（任意）</div>${dtField('nDue', '', '23:59')}</div>`);
  showSheet(html`<div class="sheet"><div class="card" id="addCard"><div class="grab"></div><div style="font-size:22px;font-weight:700">選考を追加</div>${company}${mypage}${sel}<button class="big" style="background:var(--blue);color:#fff" data-act="add-company">追加する</button></div></div>`);
  setTimeout(() => { const el = document.getElementById('nC'); if (el) el.focus(); }, 80);
}

/* 打っている途中で毎回問い合わせないよう、手が止まってから引く */
export function suggest(v) {
  const box = document.getElementById('nCSug');
  if (!box) return;
  const q = String(v || '').trim();
  clearTimeout(sugTimer);
  if (q.length < 2) { box.className = 'sug'; setHtml(box, html``); return; }
  const seq = ++sugSeq;
  sugTimer = setTimeout(async () => {
    const list = await wdSuggest(q);
    if (seq !== sugSeq) return;              // 古い問い合わせの結果は捨てる
    const el = document.getElementById('nCSug');
    if (!el) return;
    if (!list.length) { el.className = 'sug'; setHtml(el, html``); return; }
    setHtml(el, html`${list.map((x) => html`<button type="button" data-act="pick-suggest" data-label="${x.label}" data-v="${x.id}"><span class="sl">${x.label}</span>${x.desc && html`<span class="sd">${x.desc}</span>`}</button>`)}`);
    el.className = 'sug on';
  }, 320);
}

/* 候補を選んだら、名前を正式名称にし、空いていればドメインも補う */
async function pickSuggest(el) {
  const nc = document.getElementById('nC');
  if (nc) nc.value = el.dataset.label;
  const box = document.getElementById('nCSug');
  if (box) { box.className = 'sug'; setHtml(box, html``); }
  sugSeq++;
  const c = await wdClaims(el.dataset.v, true);
  const nd = document.getElementById('nD');
  if (c && c.domain && nd && !nd.value.trim()) nd.value = c.domain;
}

async function addCompany() {
  const v = (id) => (document.getElementById(id) || { value: '' }).value.trim();
  const name = v('nC');
  if (!name) { toast('会社名を入れてください。'); return; }
  if (Domain.duplicateOf(store.companies(), name, ui.term)) { toast('その会社はすでに登録されています。'); return; }
  const fields = { name, term: ui.term, url: v('nU'), loginId: v('nI'), domain: v('nD'), stage: v('nS'), dueAt: dtValue('nDue') };
  try { Domain.create('check', fields); } catch (e) { toast(e.message); return; }
  busy(true);
  try {
    await store.run('addCompany', fields);
    closeSheet();
    toast('追加しました。', true);
  } catch (e) {
    toast('保存できませんでした：' + e.message);
  } finally {
    busy(false);
  }
}

export function resetAdd() {
  clearTimeout(sugTimer);
  sugSeq = 0;
}

export const addActions = {
  'add-company': () => addCompany(),
  'pick-suggest': (el) => pickSuggest(el)
};
