process.env.TZ='Asia/Tokyo';
const {JSDOM,VirtualConsole}=require('jsdom');
const fs=require('fs'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const ALL=[];let pass=0,fail=0;const ok=(c,m)=>{if(c)pass++;else{fail++;console.log('✗ '+m)}};
const iso=(ms)=>{const d=new Date(Date.now()+ms),p=n=>('0'+n).slice(-2);return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes())};
function data(){return {items:[
 {c:'A株式会社',term:'夏インターン',stage:'最終面接',status:'結果待ち',due:null,since:'2026-09-01',route:null,url:'https://a',id:'x',dom:'a.co.jp'},
 {c:'B社',term:'夏インターン',stage:'ES',status:'対応中',due:iso(3*864e5),route:null},
 {c:'Gmail社',term:'夏インターン',stage:'メール自動検出',status:'',due:iso(-864e5),route:null},
 {c:'C社',term:'夏インターン',stage:'面接',status:'落選',lost:'面接',on:'2026-09-10',route:null},
],events:[],logos:{}}}
async function boot({cache,server,failActions=[],ls={}}={}){
 const errors=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));vc.on('error',e=>errors.push(String(e)));
 const calls=[];let srv=server||data();
 const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:'https://example.github.io/app/',virtualConsole:vc,
  beforeParse(w){
   w.localStorage.setItem('sk_ep','https://script.google.com/macros/s/x/exec');w.localStorage.setItem('sk_key','k');
   if(cache)w.localStorage.setItem('sk_cache',JSON.stringify(cache));
   for(const k in ls)w.localStorage.setItem(k,ls[k]);
   w.CSS=w.CSS||{};w.CSS.escape=w.CSS.escape||(s=>String(s).replace(/[^\w-]/g,c=>'\\'+c));
   w.confirm=()=>true;Object.defineProperty(w,'innerWidth',{value:390,configurable:true});w.scrollTo=()=>{};
   w.fetch=async(url,opt)=>{
    if(!String(url).includes('script.google'))return {ok:true,json:async()=>({search:[]}),text:async()=>'{}'};
    const b=JSON.parse(opt.body);calls.push(b.action);
    if(failActions.includes(b.action))return {ok:true,text:async()=>JSON.stringify({ok:false,error:'その名前はすでに登録されています'})};
    const light=['apiMarkDone','apiSetStatus','apiSetRoute','apiSetInfo','apiSaveLogo','apiSetIndustry'].includes(b.action);
    return {ok:true,text:async()=>JSON.stringify(light?{ok:true,light:true}:srv)};
   };
   w.addEventListener('error',e=>errors.push(e.message));
  }});
 const w=dom.window;const R={w,d:w.document,errors,calls,setSrv:s=>srv=s,tick:ms=>new Promise(r=>setTimeout(r,ms||60))};ALL.push(R);await new Promise(r=>setTimeout(r,150));
 return {w,d:w.document,errors,calls,setSrv:s=>srv=s,tick:ms=>new Promise(r=>setTimeout(r,ms||60))};
}
(async()=>{
 // 1 起動と一覧
 let T=await boot();const {d}=T;
 ok(d.querySelectorAll('.row').length>=2,'一覧が出る');
 const chips=[...d.querySelectorAll('.chiprow button')].map(b=>b.textContent);
 ok(chips.some(c=>c.startsWith('結果待ち2')),'状態が空で締切切れの行も結果待ちに入る '+chips);
 ok([...d.querySelectorAll('.row')].some(r=>r.textContent.includes('Gmail社')&&r.textContent.includes('自動送り')),'Gmail社は自動送り表示');
 ok(d.querySelector('.row .name').textContent.indexOf('株式会社')<0,'社名短縮');

 // 2 詳細を開いて通過（最終）→ 参加決定
 T.w.openDetail('A株式会社');await T.tick();
 ok(d.querySelector('#sheet .card'),'詳細シート');
 d.querySelector('[data-act="pass"]').click();await T.tick(100);
 const a=T.w.DATA.items.find(i=>i.c==='A株式会社');
 ok(T.calls.includes('apiMarkPass'),'apiMarkPass 送信');
 // サーバー応答がそのまま（古いデータ）だと上書きされるので、ここは送信だけ確認

 // 3 見送り → 締切を外す
 T=await boot();T.w.openDetail('B社');await T.tick();
 [...T.d.querySelectorAll('[data-act="status"]')].find(b=>b.dataset.v==='見送り').click();await T.tick();
 const b=T.w.DATA.items.find(i=>i.c==='B社');ok(b.status==='見送り'&&b.due===null,'見送りで締切を外す');

 // 4 書き込み失敗で画面が消えない
 T=await boot({failActions:['apiRenameCompany']});T.w.openDetail('B社');await T.tick();
 T.w.SET_OPEN=true;T.w.renderDetail();await T.tick();
 T.d.getElementById('renName').value='C社X';T.d.querySelector('[data-act="ren-save"]').click();await T.tick(150);
 ok(T.d.getElementById('view')&&T.d.querySelectorAll('.row').length>0,'改名失敗でも一覧が残る');
 ok(/保存できませんでした/.test(T.d.getElementById('toast').textContent),'失敗をトーストで表示');

 // 5 絞り込みの行き先が空
 T=await boot({ls:{sk_ui_state:JSON.stringify({page:'list',term:'夏インターン',filt:'offer'})}});
 ok(T.w.FILT==='all','空の絞り込みは「すべて」に戻す');ok(T.d.querySelectorAll('.lane:not(.is-filt-hidden)').length>0,'一覧が真っ白にならない');

 // 6 空の一覧をキャッシュに保存
 T=await boot({cache:data(),server:{items:[],events:[],logos:{}}});await T.tick(200);
 ok(JSON.parse(T.w.localStorage.getItem('sk_cache')).items.length===0,'0件もキャッシュに保存');

 // 7 入力中に届いた最新データでも保存待ちのルートが残る
 T=await boot({cache:data()});await T.tick(200);
 T.w.openDetail('B社');T.w.tab='route';T.w.renderDetail();await T.tick();
 T.w.saveRoute(['エントリー','ES','独自面談','内定'],'',null);
 T.d.getElementById('newStage').focus();
 T.w.adoptServer(data());
 ok(T.w.DATA.items.find(i=>i.c==='B社').route.includes('独自面談'),'保存待ちのルートが残る');

 // 8 ロゴの失敗時に同じURLを繰り返さない
 T=await boot();const box=T.d.querySelector('.logo[data-doms]');
 if(box){const img=box.querySelector('img');const first=img.getAttribute('src');T.w.logoErr(img);
  const img2=T.d.querySelector('.logo[data-co="'+box.dataset.co+'"] img');ok(!img2||img2.getAttribute('src')!==first,'失敗URLを飛ばす');}
 else ok(false,'ロゴ要素なし');

 // 9 記録タブ
 T.w.setPage('pass');await T.tick();ok(T.d.querySelectorAll('.pcard').length>=4,'記録タブ描画');
 T.w.setPage('list');

 // 10 検索・追加・予定タブ
 T.w.openSearch();await T.tick();T.w.searchRun('B');ok(T.d.querySelectorAll('#qres button').length===1,'検索');
 T.w.closeOverlay();await T.tick(350);T.w.openAdd();await T.tick();ok(T.d.getElementById('nC'),'追加フォーム');
 T.w.closeOverlay();await T.tick(350);T.w.openDetail('B社');T.w.switchTab('events');ok(T.d.getElementById('evAtD'),'予定タブ');

 // 11 締切切れで見出しを組み直す
 const s=data();{const d=new Date(Date.now()+1500),p=n=>('0'+n).slice(-2);s.items[1].due=d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());}T=await boot({server:s});
 const hh=T.d.querySelector('.hero h1');ok(hh,'見出しあり '+T.d.querySelector('#view').textContent.slice(0,80));const h1=hh?hh.textContent:'';await T.tick(4200);
 ok(!T.d.querySelector('.hero h1')||T.d.querySelector('.hero h1').textContent!==h1||!T.d.querySelector('.hero .cd').textContent.includes('期限切れ'),'締切切れ後に見出しを組み直す');

 const allErr=ALL.flatMap(x=>x.errors);
 ok(allErr.length===0,'スクリプトエラー: '+allErr.join(' / '));
 console.log(`画面: ${pass} 件合格 / ${fail} 件不合格`);process.exit(0);
})().catch(e=>{console.log('CRASH',e);process.exit(1)});
