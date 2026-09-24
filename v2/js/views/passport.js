/*
 * 記録タブ。数字はすべて Domain.tally で出し、ここでは並べるだけにする。
 */
import { html, setHtml } from '../html.js';
import { ui } from '../state.js';
import { termCompanies } from './list.js';

const rateColor = (pc) => (pc === null ? 'var(--dim)' : pc >= 50 ? 'var(--go)' : 'var(--hot)');

export function renderPassport() {
  const view = document.getElementById('view');
  if (!view) return;
  const t = Domain.tally(termCompanies(), new Date());
  const intern = Domain.goalOf(ui.term) === 'joined';
  const max = Math.max(1, ...t.stages.map((s) => s.pass + s.fail + s.wait));
  const A = [], B = [];

  A.push(html`<div class="pcard po1" style="background:linear-gradient(155deg,rgba(88,74,220,.5) 0%,rgba(48,102,214,.5) 55%,rgba(46,142,224,.5) 100%);color:#EEF3FF"><div class="ttl">${ui.term} パスポート</div><div class="pgrid"><div><b>${t.entered}</b><span>エントリー社数</span></div><div><b>${t.passes}</b><span>通過した選考</span></div></div><div class="pmini"><span>進行中 <b>${t.live}</b></span><span>終了 <b>${t.failed}</b></span><span>見送り <b>${t.skipped}</b></span></div><div class="pfoot">最も進んだ段階 ${t.deepest ? t.deepest.stage + '（進み具合 ' + t.deepest.rate + '％）' : '—'}</div></div>`);

  if (t.worst) {
    A.push(html`<div class="pcard po2" style="background:linear-gradient(155deg,rgba(226,66,86,.46) 0%,rgba(150,32,48,.5) 100%);color:#FFEEF0"><div style="display:flex;align-items:baseline;gap:12px"><div class="num">${t.worst.count}</div><div style="font-size:15px;font-weight:600">社が${t.worst.stage}で終了</div></div><div class="pfoot">終了${t.failed}社のうち${t.worst.share}％がこの段階です。</div></div>`);
  }

  B.push(html`<div class="pcard po3 flat"><div class="ttl">段階別の通過率</div><div style="margin-top:14px">${t.stages.map((s) => html`<div class="rateRow"><div class="rateHead"><span>${s.stage}</span><span class="rateNum" style="color:${rateColor(s.rate)}">${s.rate === null ? '—' : s.rate + '%'}<i>${s.pass}/${s.pass + s.fail}</i></span></div><div class="bar" style="width:${Math.max(18, (s.pass + s.fail + s.wait) / max * 100)}%">${s.pass > 0 && html`<div style="flex:${s.pass};background:var(--go)"></div>`}${s.fail > 0 && html`<div style="flex:${s.fail};background:var(--fail)"></div>`}${s.wait > 0 && html`<div style="flex:${s.wait};background:var(--line)"></div>`}</div></div>`)}</div><div class="legend"><span><i style="background:var(--go)"></i>通過</span><span><i style="background:var(--fail)"></i>終了</span><span><i style="background:var(--line)"></i>進行中</span></div></div>`);

  if (t.waiting.count) {
    B.push(html`<div class="pcard po4" style="background:linear-gradient(155deg,rgba(52,116,190,.44) 0%,rgba(28,62,108,.5) 100%);color:#E4EFFF"><div class="ttl">結果待ち</div><div class="pgrid"><div><b>${t.waiting.count}</b><span>社</span></div><div><b>${t.waiting.avg}</b><span>平均経過日数</span></div><div><b>${t.waiting.longest.days}</b><span>最長</span></div></div><div class="pfoot">最も長いのは${t.waiting.longest.name}です。</div></div>`);
  }

  if (t.industries.length) {
    const indMax = Math.max(1, ...t.industries.map((x) => x.count));
    B.push(html`<div class="pcard po6 flat"><div class="ttl">業界別の進み方</div><div style="margin-top:14px">${t.industries.map((x) => html`<div class="rateRow"><div class="rateHead"><span>${x.name}<span class="cnt" style="margin-left:6px">${x.count}社</span></span><span class="rateNum" style="color:${rateColor(x.rate)}">${x.rate === null ? '—' : x.rate + '%'}<i>${x.got}/${x.got + x.fail} 決着</i></span></div><div class="bar" style="width:${Math.max(18, x.count / indMax * 100)}%">${x.got > 0 && html`<div style="flex:${x.got};background:var(--go)"></div>`}${x.live > 0 && html`<div style="flex:${x.live};background:var(--line)"></div>`}${x.fail > 0 && html`<div style="flex:${x.fail};background:var(--fail)"></div>`}</div><div style="font-family:var(--mono);font-size:10px;color:var(--dim);margin-top:5px">平均到達 ${x.reach}％</div></div>`)}</div><div class="legend"><span><i style="background:var(--go)"></i>決定</span><span><i style="background:var(--line)"></i>進行中</span><span><i style="background:var(--fail)"></i>終了</span></div><div style="font-size:10.5px;color:var(--dim);margin-top:8px;line-height:1.6">％は、決着した社のうち内定・参加決定まで行った割合です。平均到達は、選考ルートのどこまで進めたかの平均です。業種は詳細で入れた値を使い、空欄なら社名から推定します。</div></div>`);
  }

  if (t.industryStages.length) {
    /* 右の列だけが伸びて左が空くので、大きいこのカードは左へ回す */
    A.push(html`<div class="pcard po7 flat"><div class="ttl">業界 × 段階の通過率</div><div style="margin-top:12px">${t.industryStages.map((x) => html`<div class="xBlk"><div class="xHd">${x.name}<span class="cnt">${x.count}社</span></div><div class="xGrid">${x.stages.map((s) => html`<div class="xCell"><span>${s.stage}</span><b style="color:${s.rate >= 67 ? 'var(--go)' : s.rate >= 34 ? 'var(--wait)' : 'var(--hot)'}">${s.rate}%</b><i>${s.pass}/${s.pass + s.fail}</i></div>`)}</div></div>`)}</div><div style="font-size:10.5px;color:var(--dim);margin-top:10px;line-height:1.6">通った回数 ÷ 結果が出た回数です。結果待ちは分母に入りません。詳細の業種欄を「NTT系」のようなグループ名で埋めると、その単位でも見られます。</div></div>`);
  }

  const keys = intern ? ['todo', 'waiting', 'joined'] : ['todo', 'waiting', 'joined', 'offer'];
  const LAB = { todo: '対応中', waiting: '結果待ち', joined: '参加決定', offer: '内定' };
  const COL = { todo: 'var(--blue)', waiting: 'var(--wait)', joined: 'var(--go)', offer: 'var(--go)' };
  A.push(html`<div class="pcard po5 flat"><div class="ttl">進行中の内訳</div><div style="margin-top:10px">${keys.map((k) => html`<div class="brkRow"><span>${LAB[k]}</span><span style="font-family:var(--disp);font-size:21px;font-weight:600;color:${t.breakdown[k] ? COL[k] : 'var(--dim)'}">${t.breakdown[k]}</span></div>`)}</div></div>`);

  setHtml(view, html`<div class="ptitle">${ui.term} 記録</div><div class="pwrap"><div class="pcol">${A}</div><div class="pcol">${B}</div></div>`);
  view.querySelectorAll('.pcard').forEach((el, i) => el.style.setProperty('--ei', i));
}
