/* シフト表の読み取りと給与の計算。
   ページに直接書かず、ファイルに出している。同じ github.io の場所に就活ボードの鍵が置いてあるので、
   このページでよそのスクリプトが動かないよう、読み込みの制限（CSP）でページの中のスクリプトを止めているため */
'use strict';
/* ===== 表の形（シフト表のテンプレートに合わせた値） ===== */
const GRID_START_HOUR = 6;    // 表の左端は6時
const CELLS = 36;             // 6時〜24時を30分ずつ
const BREAK_OVER_HOURS = 5;   // 店のルール：拘束5時間を超えたら
const BREAK_HOURS = 1;        //             休憩1時間
const OT_DAILY_HOURS = 8;

const $ = id => document.getElementById(id);
/* innerHTML に入れる値は必ずこれを通す。サーバーや端末の保存領域から来た値に < や " が入っていても、タグとして動かないように */
const ESC = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ESC[c]);
/* 送り先は Apps Script のウェブアプリだけにする。よその URL に合言葉を送らないように */
const validUrl = u => /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(u);
const pad = n => String(n).padStart(2,'0');
const minToHHMM = m => pad(Math.floor(m/60)) + ':' + pad(m%60);
const hhmmToMin = s => { const [h,m] = s.split(':').map(Number); return h*60+m; };
const cellToMin = i => GRID_START_HOUR*60 + i*30;
const addDays = (dstr, n) => { const d = new Date(dstr+'T00:00:00'); d.setDate(d.getDate()+n);
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); };
const yen = n => '¥' + Math.round(n).toLocaleString('ja-JP');
const WD = ['日','月','火','水','木','金','土'];
const dateLabel = dstr => { const d = new Date(dstr+'T00:00:00'); return (d.getMonth()+1)+'/'+d.getDate()+'('+WD[d.getDay()]+')'; };

function calcDay(start, end){
  const span = (hhmmToMin(end) - hhmmToMin(start)) / 60;
  const brk = span > BREAK_OVER_HOURS ? BREAK_HOURS : 0;
  const work = Math.max(0, span - brk);
  return { span, brk, work, ot: Math.max(0, work - OT_DAILY_HOURS) };
}

/* ===== タブ ===== */
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach(x => x.setAttribute('aria-selected', x===b));
  ['read','pay','settings'].forEach(t => $('tab-'+t).hidden = (t !== b.dataset.tab));
  if (b.dataset.tab === 'settings' && localStorage.getItem('shift.url')) loadSettings();
}));

/* ===== Apps Script との通信 ===== */
async function api(action, payload = {}){
  const url = localStorage.getItem('shift.url'), token = localStorage.getItem('shift.token');
  if (!url || !token) throw new Error('設定タブでURLと合言葉を入れてください。');
  if (!validUrl(url)) throw new Error('URL は https://script.google.com/macros/s/.../exec の形です。');
  const res = await fetch(url, { method:'POST', body: JSON.stringify({ action, token, ...payload }) });
  let j;
  try { j = await res.json(); } catch(e){ throw new Error('Apps Script から返事を読めませんでした。URLとデプロイの設定を確かめてください。'); }
  if (!j.ok) throw new Error(j.error || '登録できませんでした。');
  return j;
}

/* ===== 画像の読み込みと表示 ===== */
const cv = $('cv'), cctx = cv.getContext('2d');
let queue = [], qIdx = -1;
let work = null, original = null, workData = null;
let mode = null, taps = [];
let nextDate = null;

$('firstDate').value = (() => { const d = new Date(); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); })();

$('files').addEventListener('change', e => {
  queue = [...e.target.files].sort((a,b) => a.name.localeCompare(b.name, 'ja', {numeric:true}));
  qIdx = -1; nextDate = $('firstDate').value;
  nextImage();
});

function nextImage(){
  qIdx++;
  $('result').hidden = true;
  if (qIdx >= queue.length){
    $('editor').hidden = true;
    $('queueInfo').textContent = queue.length ? '選んだ画像はすべて見終わりました。' : '';
    return;
  }
  $('queueInfo').textContent = (qIdx+1) + ' / ' + queue.length + ' 枚目：' + queue[qIdx].name;
  const img = new Image();
  img.onload = () => {
    const MAX = 2400, s = Math.min(1, MAX / Math.max(img.width, img.height));
    original = document.createElement('canvas');
    original.width = Math.round(img.width*s); original.height = Math.round(img.height*s);
    original.getContext('2d').drawImage(img, 0, 0, original.width, original.height);
    URL.revokeObjectURL(img.src);
    setWork(cloneCanvas(original));
    $('editor').hidden = false;
    setMode(null);
    $('hint').textContent = '向きが横なら回してください。紙の写真など斜めに写っているときは「斜めを直す」を使います。';
  };
  img.src = URL.createObjectURL(queue[qIdx]);
}

function cloneCanvas(c){ const n = document.createElement('canvas'); n.width=c.width; n.height=c.height; n.getContext('2d').drawImage(c,0,0); return n; }
function setWork(c){ work = c; workData = null; redraw(); }
function getData(){ if (!workData) workData = work.getContext('2d', {willReadFrequently:true}).getImageData(0,0,work.width,work.height); return workData; }

function redraw(){
  cv.width = work.width; cv.height = work.height;
  cctx.drawImage(work, 0, 0);
  const r = Math.max(6, work.width/180);
  cctx.lineWidth = Math.max(2, work.width/500);
  taps.forEach((p,i) => {
    cctx.strokeStyle = '#6A57E0'; cctx.fillStyle = 'rgba(106,87,224,.35)';
    cctx.beginPath(); cctx.arc(p.x, p.y, r, 0, Math.PI*2); cctx.fill(); cctx.stroke();
    if (i>0 && mode==='straighten'){ cctx.beginPath(); cctx.moveTo(taps[i-1].x,taps[i-1].y); cctx.lineTo(p.x,p.y); cctx.stroke(); }
  });
  if (mode==='pickRow' && taps.length===2){ cctx.beginPath(); cctx.moveTo(taps[0].x,taps[0].y); cctx.lineTo(taps[1].x,taps[1].y); cctx.stroke(); }
}

function rotate(dir){
  const n = document.createElement('canvas'); n.width = work.height; n.height = work.width;
  const x = n.getContext('2d');
  x.translate(n.width/2, n.height/2); x.rotate(dir*Math.PI/2); x.drawImage(work, -work.width/2, -work.height/2);
  setWork(n);
}

const HINTS = {
  straighten: ['表の左上の角をタップ','右上の角をタップ','右下の角をタップ','左下の角をタップ'],
  pickRow: ['自分の行で、6時のマスの左端をタップ（行の高さの真ん中）','同じ行で、23時のマスの右端をタップ'],
};
function setMode(m){ mode = m; taps = []; redraw(); $('hint').textContent = m ? HINTS[m][0] : ''; }

document.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
  const a = b.dataset.act;
  if (!work) return;
  if (a==='rotL') { setMode(null); rotate(-1); }
  if (a==='rotR') { setMode(null); rotate(1); }
  if (a==='resetImg') { setMode(null); setWork(cloneCanvas(original)); }
  if (a==='straighten') setMode('straighten');
  if (a==='pickRow') setMode('pickRow');
}));

/* タップ位置を拡大鏡で見せ、指を離した位置で決める */
const loupe = $('loupe'), lctx = loupe.getContext('2d');
function toCanvas(ev){ const r = cv.getBoundingClientRect(); return { x:(ev.clientX-r.left)*cv.width/r.width, y:(ev.clientY-r.top)*cv.height/r.height }; }
function showLoupe(ev){
  const p = toCanvas(ev), r = cv.getBoundingClientRect();
  const src = 50 * cv.width / r.width; // 画面上の3倍に拡大
  lctx.fillStyle='#fff'; lctx.fillRect(0,0,150,150);
  lctx.drawImage(work, p.x - src/2, p.y - src/2, src, src, 0, 0, 150, 150);
  lctx.strokeStyle='#6A57E0'; lctx.lineWidth=1.5;
  lctx.beginPath(); lctx.moveTo(75,0); lctx.lineTo(75,150); lctx.moveTo(0,75); lctx.lineTo(150,75); lctx.stroke();
  loupe.hidden = false;
  const left = ev.clientX < window.innerWidth/2;
  loupe.style.left = left ? (window.innerWidth - 165)+'px' : '15px';
  loupe.style.top = (Math.max(70, ev.clientY - 190))+'px';
}
cv.addEventListener('pointerdown', ev => { if (!mode) return; cv.setPointerCapture(ev.pointerId); showLoupe(ev); });
cv.addEventListener('pointermove', ev => { if (!mode || loupe.hidden) return; showLoupe(ev); });
cv.addEventListener('pointerup', ev => {
  if (!mode || loupe.hidden) return;
  loupe.hidden = true;
  taps.push(toCanvas(ev)); redraw();
  const steps = HINTS[mode];
  if (taps.length < steps.length){ $('hint').textContent = steps[taps.length]; return; }
  if (mode==='straighten'){ const t = taps.slice(); setMode(null); straighten(t);
    $('hint').textContent = '直しました。続けて「自分の行を指定する」を押してください。'; }
  else if (mode==='pickRow'){ const t = taps.slice(); mode = null; $('hint').textContent = ''; readRow(t[0], t[1]); }
});
cv.addEventListener('pointercancel', () => { loupe.hidden = true; });

/* ===== 斜めの補正（4点からの射影変換） ===== */
function solve(A, b){
  const n = b.length;
  for (let i=0;i<n;i++){
    let m = i; for (let k=i+1;k<n;k++) if (Math.abs(A[k][i])>Math.abs(A[m][i])) m=k;
    [A[i],A[m]]=[A[m],A[i]]; [b[i],b[m]]=[b[m],b[i]];
    for (let k=i+1;k<n;k++){ const f=A[k][i]/A[i][i]; for (let j=i;j<n;j++) A[k][j]-=f*A[i][j]; b[k]-=f*b[i]; }
  }
  const x = new Array(n);
  for (let i=n-1;i>=0;i--){ let s=b[i]; for (let j=i+1;j<n;j++) s-=A[i][j]*x[j]; x[i]=s/A[i][i]; }
  return x;
}
function homography(from, to){ // from[i] -> to[i]
  const A=[], b=[];
  for (let i=0;i<4;i++){
    const {x,y}=from[i], {x:u,y:v}=to[i];
    A.push([x,y,1,0,0,0,-u*x,-u*y]); b.push(u);
    A.push([0,0,0,x,y,1,-v*x,-v*y]); b.push(v);
  }
  const h = solve(A,b); h.push(1); return h;
}
function straighten(pts){
  const d = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);
  let W = Math.max(d(pts[0],pts[1]), d(pts[3],pts[2])), H = Math.max(d(pts[0],pts[3]), d(pts[1],pts[2]));
  const s = Math.min(1, 2400/Math.max(W,H)); W = Math.round(W*s); H = Math.round(H*s);
  const dst = [{x:0,y:0},{x:W,y:0},{x:W,y:H},{x:0,y:H}];
  const h = homography(dst, pts); // 出力の各画素が元画像のどこに当たるか
  const src = getData(), sw = src.width, sh = src.height, sd = src.data;
  const out = document.createElement('canvas'); out.width=W; out.height=H;
  const octx = out.getContext('2d'), od = octx.createImageData(W,H);
  for (let y=0;y<H;y++) for (let x=0;x<W;x++){
    const z = h[6]*x + h[7]*y + 1;
    const sx = Math.round((h[0]*x + h[1]*y + h[2]) / z), sy = Math.round((h[3]*x + h[4]*y + h[5]) / z);
    const o = (y*W + x)*4;
    if (sx>=0 && sy>=0 && sx<sw && sy<sh){ const i=(sy*sw+sx)*4; od.data[o]=sd[i]; od.data[o+1]=sd[i+1]; od.data[o+2]=sd[i+2]; }
    else { od.data[o]=od.data[o+1]=od.data[o+2]=255; }
    od.data[o+3]=255;
  }
  octx.putImageData(od,0,0);
  setWork(out);
}

/* ===== 自分の行のマスの色を読む ===== */
let cellsOn = new Array(CELLS).fill(false);

function px(d, x, y){
  x = Math.round(x); y = Math.round(y);
  if (x<0||y<0||x>=d.width||y>=d.height) return [1, 0];
  const i = (y*d.width + x)*4, r=d.data[i]/255, g=d.data[i+1]/255, b=d.data[i+2]/255;
  const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
  return [0.299*r + 0.587*g + 0.114*b, mx ? (mx-mn)/mx : 0];
}
function median(a){ a.sort((p,q)=>p-q); return a[Math.floor(a.length/2)]; }
function pct(a, q){ a.sort((p,q2)=>p-q2); return a[Math.min(a.length-1, Math.floor(a.length*q))]; }

function readRow(p0, p1){
  const d = getData();
  const ux = (p1.x-p0.x)/CELLS, uy = (p1.y-p0.y)/CELLS, len = Math.hypot(ux,uy);
  const nx = -uy/len, ny = ux/len;
  const at = (t, b) => px(d, p0.x + ux*t + nx*len*b, p0.y + uy*t + ny*len*b);
  const scores = [];
  for (let i=0;i<CELLS;i++){
    // マスの中央の明るさと色の濃さ（中央値なので「休み」などの文字や罫線に引っぱられにくい）
    const L = [], S = [];
    for (let a=-3;a<=3;a++) for (const b of [-0.3,-0.15,0,0.15,0.3]){ const v = at(i+0.5+a/10, b); L.push(v[0]); S.push(v[1]); }
    // まわりで一番白いところの明るさ（紙の写真の影や照明のむらを打ち消す）
    const W = [];
    for (let a=-8;a<=8;a++) for (let b=-10;b<=10;b++) W.push(at(i+0.5+a/4, b/4)[0]);
    const white = pct(W, 0.95), lum = median(L), sat = median(S);
    scores.push(Math.max(0, (white-lum)/Math.max(white,0.05)) + sat*0.5);
  }
  // 濃いマスと薄いマスの2組に分ける境目を探す
  const sorted = scores.slice().sort((a,b)=>a-b);
  let best = -1, thr = Infinity;
  for (let k=1;k<sorted.length;k++){
    const lo = sorted.slice(0,k), hi = sorted.slice(k);
    const m1 = lo.reduce((s,v)=>s+v,0)/lo.length, m2 = hi.reduce((s,v)=>s+v,0)/hi.length;
    const v = lo.length*hi.length*(m2-m1)*(m2-m1);
    if (v>best && m2-m1 > 0.12){ best=v; thr=(sorted[k-1]+sorted[k])/2; }
  }
  cellsOn = scores.map(s => s >= thr);
  drawStrip(p0, p1, ux, uy, len);
  $('rDate').value = nextDate || $('firstDate').value;
  $('rHoliday').checked = false;
  syncFromCells();
  $('result').hidden = false;
  $('result').scrollIntoView({behavior:'smooth', block:'start'});
}

function drawStrip(p0, p1, ux, uy, len){
  const s = $('strip'), ang = Math.atan2(uy, ux);
  const total = len*CELLS, W = Math.round(total*1.45), H = Math.round(len*3.2);
  s.width = W; s.height = H;
  const x = s.getContext('2d');
  x.fillStyle='#fff'; x.fillRect(0,0,W,H);
  const sx = p0.x - ux*CELLS*0.3, sy = p0.y - uy*CELLS*0.3; // 名前の欄から右端の数字まで
  x.setTransform(1,0,0,1,0,H/2); x.rotate(-ang); x.translate(-sx,-sy);
  x.drawImage(work,0,0);
  x.setTransform(1,0,0,1,0,0);
}

/* マスと時間の選択を連動させる */
const timeOpts = [];
for (let i=0;i<=CELLS;i++) timeOpts.push(minToHHMM(cellToMin(i)));
for (const id of ['rStart','rEnd']) $(id).innerHTML = timeOpts.map(t=>`<option>${t}</option>`).join('');

function renderCells(){
  const box = $('cells');
  let html = '';
  for (let h=0;h<CELLS/2;h++) html += `<span class="hr">${GRID_START_HOUR+h}</span>`;
  for (let i=0;i<CELLS;i++) html += `<button type="button" data-i="${i}" class="${cellsOn[i]?'on':''}" aria-label="${minToHHMM(cellToMin(i))}"></button>`;
  box.innerHTML = html;
}
$('cells').addEventListener('click', e => {
  const i = e.target.dataset && e.target.dataset.i; if (i===undefined) return;
  cellsOn[+i] = !cellsOn[+i]; syncFromCells();
});
function syncFromCells(){
  const first = cellsOn.indexOf(true), last = cellsOn.lastIndexOf(true);
  if (first >= 0){ $('rStart').value = timeOpts[first]; $('rEnd').value = timeOpts[last+1]; }
  renderCells(); showCalc();
}
function syncFromTimes(){
  const s = timeOpts.indexOf($('rStart').value), e = timeOpts.indexOf($('rEnd').value);
  cellsOn = cellsOn.map((_,i) => i>=s && i<e);
  renderCells(); showCalc();
}
$('rStart').addEventListener('change', syncFromTimes);
$('rEnd').addEventListener('change', syncFromTimes);

function currentDay(){
  if (cellsOn.indexOf(true) < 0) return null;
  const s = $('rStart').value, e = $('rEnd').value;
  if (hhmmToMin(e) <= hhmmToMin(s)) return null;
  return { date: $('rDate').value, start: s, end: e, holiday: $('rHoliday').checked };
}
function showCalc(){
  const d = currentDay();
  if (!d){ $('rCalc').innerHTML = '<span class="err">勤務のマスが見つかりませんでした。マスをタップするか、時間を選んでください。</span>'; return; }
  const c = calcDay(d.start, d.end);
  const gaps = cellsOn.slice(cellsOn.indexOf(true), cellsOn.lastIndexOf(true)+1).filter(v=>!v).length/2;
  let note = '';
  if (gaps !== c.brk) note = `<br><span class="muted">表の中の空き（休み）は${gaps}時間でした。計算は店のルールの休憩${c.brk}時間を使います。</span>`;
  $('rCalc').innerHTML = `${d.start}〜${d.end}　拘束${c.span}時間・休憩${c.brk}時間　実働 <b>${c.work}</b> 時間` + (c.ot ? `（うち残業${c.ot}時間）` : '') + note;
}

/* ===== 登録待ち ===== */
let pending = JSON.parse(localStorage.getItem('shift.pending') || '[]');
function savePending(){ localStorage.setItem('shift.pending', JSON.stringify(pending)); renderPending(); }
function renderPending(){
  pending.sort((a,b)=>a.date.localeCompare(b.date));
  $('pending').innerHTML = pending.map((p,i) => {
    const c = calcDay(p.start, p.end);
    return `<li><span>${esc(dateLabel(p.date))}　${esc(p.start)}〜${esc(p.end)}　実働${esc(c.work)}h${p.holiday?'　休日出勤':''}</span><button class="x" data-del="${i}" aria-label="削除">×</button></li>`;
  }).join('');
  $('pendingEmpty').hidden = pending.length > 0;
  $('submit').disabled = pending.length === 0;
}
$('pending').addEventListener('click', e => { const i = e.target.dataset.del; if (i===undefined) return; pending.splice(+i,1); savePending(); });

$('addDay').addEventListener('click', () => {
  const d = currentDay(); if (!d || !d.date) { showCalc(); return; }
  pending = pending.filter(p => p.date !== d.date); pending.push(d); savePending();
  nextDate = addDays(d.date, 1);
  if (qIdx >= 0 && qIdx < queue.length) nextImage(); else $('result').hidden = true;
});
$('skipDay').addEventListener('click', () => {
  nextDate = addDays($('rDate').value || $('firstDate').value, 1);
  if (qIdx >= 0 && qIdx < queue.length) nextImage(); else $('result').hidden = true;
});
$('manualAdd').addEventListener('click', () => {
  $('editor').hidden = true;
  cellsOn = new Array(CELLS).fill(false);
  $('strip').width = 0; $('strip').height = 0;
  $('rDate').value = nextDate || $('firstDate').value; $('rHoliday').checked = false;
  syncFromCells(); $('result').hidden = false; $('result').scrollIntoView({behavior:'smooth'});
});

$('submit').addEventListener('click', async () => {
  $('submit').disabled = true; $('submitMsg').className = ''; $('submitMsg').textContent = '登録しています…';
  try {
    const r = await api('saveShifts', { shifts: pending });
    $('submitMsg').className = 'okmsg'; $('submitMsg').textContent = `${r.saved}日分をカレンダーとシートに登録しました。`;
    pending = []; savePending();
  } catch(e){ $('submitMsg').className = 'err'; $('submitMsg').textContent = e.message; $('submit').disabled = false; }
});
renderPending();

/* ===== 給与 ===== */
$('payMonth').value = (() => { const d = new Date(); return d.getFullYear()+'-'+pad(d.getMonth()+1); })();
$('loadMonth').addEventListener('click', loadMonth);
async function loadMonth(){
  const out = $('payOut'); out.innerHTML = '<p class="muted">読み込んでいます…</p>';
  try {
    const r = await api('getMonth', { month: $('payMonth').value });
    const t = r.total;
    let html = `<div class="total"><span class="yen">${esc(yen(t.total))}</span><span class="when">${esc(String(r.payday).replace(/-/g,'/'))} 支払い見込み</span></div>`;
    html += `<p class="muted">${esc(t.days)}日・実働${esc(t.work)}時間${t.ot?`（残業${esc(t.ot)}時間）`:''}　給与${esc(yen(t.wagePay))}＋交通費${esc(yen(t.transport))}</p>`;
    if (r.warnings.length) html += '<ul class="warns">' + r.warnings.map(w=>`<li>${esc(w)}</li>`).join('') + '</ul>';
    if (r.rows.length){
      html += '<div class="tbl"><table><thead><tr><th>日付</th><th>時間</th><th>実働</th><th>時給</th><th>給与</th><th></th></tr></thead><tbody>';
      html += r.rows.map(x => `<tr><td>${esc(dateLabel(x.date))}${x.holiday?' 休':''}</td><td>${esc(x.start)}〜${esc(x.end)}</td><td>${esc(x.work)}h${x.ot?`<br><span class="muted">残業${esc(x.ot)}h</span>`:''}</td><td>${esc(Number(x.wage).toLocaleString('ja-JP'))}</td><td>${esc(yen(x.pay))}</td><td><button class="x" data-deldate="${esc(x.date)}" aria-label="削除">×</button></td></tr>`).join('');
      html += '</tbody></table></div>';
      html += `<div class="bar"><button id="paydayBtn">給料日をカレンダーに入れる</button></div><p id="paydayMsg"></p>`;
    } else html += '<p class="muted">この月のシフトはまだ登録されていません。</p>';
    out.innerHTML = html;
    const pb = $('paydayBtn');
    if (pb) pb.addEventListener('click', async () => {
      try { await api('setPaydayEvent', { month: $('payMonth').value }); $('paydayMsg').className='okmsg'; $('paydayMsg').textContent='給料日の予定を入れました。'; }
      catch(e){ $('paydayMsg').className='err'; $('paydayMsg').textContent=e.message; }
    });
  } catch(e){ out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
$('payOut').addEventListener('click', async e => {
  const d = e.target.dataset && e.target.dataset.deldate; if (!d) return;
  if (!confirm(dateLabel(d)+' のシフトを削除します。カレンダーの予定も消えます。')) return;
  try { await api('deleteShift', { date: d }); loadMonth(); } catch(err){ alert(err.message); }
});

/* ===== 設定 ===== */
$('sUrl').value = localStorage.getItem('shift.url') || '';
$('sToken').value = localStorage.getItem('shift.token') || '';
$('saveConn').addEventListener('click', () => {
  if (!validUrl($('sUrl').value.trim())) { $('connMsg').className='err'; $('connMsg').textContent='URL は https://script.google.com/macros/s/.../exec の形です。'; return; }
  localStorage.setItem('shift.url', $('sUrl').value.trim());
  localStorage.setItem('shift.token', $('sToken').value.trim());
  loadSettings();
});

let settings = null;
async function loadSettings(){
  $('connMsg').className=''; $('connMsg').textContent = '読み込んでいます…';
  try {
    settings = (await api('getSettings')).settings;
    $('connMsg').className='okmsg'; $('connMsg').textContent = 'つながりました。';
    $('sTransport').value = settings.transport; $('sOt').value = settings.otRate; $('sHol').value = settings.holidayRate;
    $('sPayday').value = settings.payday; $('sCal').value = settings.calendarName;
    renderRates(); $('payrollPanel').hidden = false;
  } catch(e){ $('connMsg').className='err'; $('connMsg').textContent = e.message; $('payrollPanel').hidden = true; }
}
function renderRates(){
  const row = (r,i,kind) => `<li><span>${esc(String(r.from).replace(/-/g,'/'))} から　${esc(Number(r.wage).toLocaleString('ja-JP'))}円</span><button class="x" data-kind="${esc(kind)}" data-i="${esc(i)}" aria-label="削除">×</button></li>`;
  settings.wages.sort((a,b)=>a.from.localeCompare(b.from)); settings.minWages.sort((a,b)=>a.from.localeCompare(b.from));
  $('wageList').innerHTML = settings.wages.map((r,i)=>row(r,i,'wages')).join('');
  $('minList').innerHTML = settings.minWages.map((r,i)=>row(r,i,'minWages')).join('');
}
for (const id of ['wageList','minList']) $(id).addEventListener('click', e => {
  const k = e.target.dataset.kind; if (!k) return; settings[k].splice(+e.target.dataset.i,1); renderRates();
});
$('wAdd').addEventListener('click', () => { if (!$('wFrom').value || !$('wVal').value) return;
  settings.wages = settings.wages.filter(r=>r.from!==$('wFrom').value); settings.wages.push({from:$('wFrom').value, wage:+$('wVal').value}); renderRates(); });
$('mAdd').addEventListener('click', () => { if (!$('mFrom').value || !$('mVal').value) return;
  settings.minWages = settings.minWages.filter(r=>r.from!==$('mFrom').value); settings.minWages.push({from:$('mFrom').value, wage:+$('mVal').value}); renderRates(); });
$('saveSettings').addEventListener('click', async () => {
  settings.transport = +$('sTransport').value; settings.otRate = +$('sOt').value; settings.holidayRate = +$('sHol').value;
  settings.payday = +$('sPayday').value; settings.calendarName = $('sCal').value.trim() || 'バイト';
  try { await api('saveSettings', { settings }); $('setMsg').className='okmsg'; $('setMsg').textContent='保存しました。'; }
  catch(e){ $('setMsg').className='err'; $('setMsg').textContent=e.message; }
});
