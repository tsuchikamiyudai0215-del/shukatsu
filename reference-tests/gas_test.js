const mk=require('./gas_mock');
let pass=0,fail=0;const ok=(c,m)=>{if(c){pass++}else{fail++;console.log('✗ '+m)}};
const H=['会社名','URL','ID','PW','日付','時','分','段階','状況','登録','eventId','結果日','落ちた段階','結果予定','結果eventId','フォルダ','区分','状態','提出日','ルート','ドメイン','業種'];
function setup(){
 const T=mk();const {Sheet,sheets}=T;
 const d=new Date(Date.now()+5*864e5);d.setHours(0,0,0,0);
 sheets['Sheet1']=new Sheet('Sheet1',[H.slice(),
  ['A社','https://a','ida','pwa',d,23,59,'最終面接','未','','','','','','','','夏インターン','対応中','','','',''],
  ['B社','','','',d,10,0,'ES','未','','','','','','','','夏インターン','対応中','','','',''],
  ['C社','','','','', '', '','面接','未','','','','','','','','本選考','対応中','','','',''],
 ]);
 sheets['Sheet1'].f['2,16']='=HYPERLINK("https://drive/a", "📁 フォルダを開く")';
 sheets['Sheet1'].put(2,16,'📁');
 return T;
}
const row=(T,name,term)=>{const s=T.sheets['Sheet1'];for(let i=1;i<s.d.length;i++)if(s.d[i][0]===name&&(s.d[i][16]||'夏インターン')===term)return s.d[i];return null};
const today=new Date();const td=today.getFullYear()+'/'+('0'+(today.getMonth()+1)).slice(-2)+'/'+('0'+today.getDate()).slice(-2);

// 1 読み取り
{const T=setup();const j=T.api('apiGetData');
 ok(j.items.length===3,'items 3');ok(j.items.find(i=>i.c==='A社').folder==='https://drive/a','folder 抽出');
 ok(/T23:59$/.test(j.items.find(i=>i.c==='A社').due),'due 時刻');
 ok(T.ctx.CacheService._m.wa_data,'読み取り結果をキャッシュ');
 ok(!T.heldRef(),'読み取り後ロック解放');}

// 2 内定・参加決定（最終段階）
{const T=setup();
 // 締切イベントを作る
 T.api('apiSetDue','A社','夏インターン','2030-01-10T12:00');
 const eid=row(T,'A社','夏インターン')[10];ok(eid&&T.cal[eid].alive,'締切イベント作成');
 const j=T.api('apiMarkPass','A社','夏インターン');const r=row(T,'A社','夏インターン');
 ok(r[7]==='内定','最終: 段階をルート末尾へ ('+r[7]+')');ok(r[17]==='参加決定','夏は参加決定');
 ok(r[11]===td,'結果日 今日');ok(r[4]===''&&r[10]==='','締切クリア');ok(!T.cal[eid].alive,'締切イベント削除');
 const it=j.items.find(i=>i.c==='A社');ok(it.on&&it.stage==='内定','応答に反映');ok(!T.heldRef(),'ロック解放');}

// 3 本選考は内定
{const T=setup();T.sheets.Sheet1.d[3][7]='最終面接';T.api('apiMarkPass','C社','本選考');ok(row(T,'C社','本選考')[17]==='内定','本選考は内定');}

// 4 途中段階
{const T=setup();T.api('apiMarkPass','B社','夏インターン');const r=row(T,'B社','夏インターン');ok(r[7]==='適性検査'&&r[17]==='対応中','次の段階へ');}

// 5 落選 → 対応中に戻す
{const T=setup();T.api('apiMarkFail','A社','夏インターン');let r=row(T,'A社','夏インターン');
 ok(r[17]==='落選'&&r[12]==='最終面接'&&r[9]==='選考落ち','落選の記録');
 T.api('apiSetStatus','A社','夏インターン','対応中');r=row(T,'A社','夏インターン');
 ok(r[11]===''&&r[12]==='','結果日・落ちた段階を消す');ok(r[9]==='','登録欄を戻す');ok(r[8]==='未','状況 未');}

// 6 見送り
{const T=setup();T.api('apiSetDue','B社','夏インターン','2030-02-01T10:00');const eid=row(T,'B社','夏インターン')[10];
 const j=T.api('apiSetStatus','B社','夏インターン','見送り');const r=row(T,'B社','夏インターン');
 ok(j.light,'軽い応答');ok(r[17]==='見送り'&&r[8]==='日程削除','状態');ok(r[4]===''&&r[9]==='日程削除済'&&r[10]==='','締切を片付け');ok(!T.cal[eid].alive,'カレンダー削除');}

// 7 キャッシュ
{const T=setup();T.api('apiGetData');const c=T.ctx.CacheService._m;const before=c.wa_data;
 T.api('apiSetInfo','A社','夏インターン','https://x','idx');ok(!c.wa_data,'軽い書き込み後はキャッシュ破棄');
 const j=T.api('apiGetData');ok(j.items.find(i=>i.c==='A社').url==='https://x','再読み込みで新しい値');
 T.api('apiMarkFail','B社','夏インターン');ok(c.wa_data&&c.wa_data.includes('落選'),'全データ応答は保存');}

// 8 ロゴ
{const T=setup();const j=T.api('apiSaveLogo','A社','https://logo');ok(j.ok&&j.light,'ロゴ保存 JSON 応答');
 T.api('apiSaveLogo','B社','https://logo2');const m=JSON.parse(T.ctx.PropertiesService._m.wa_logos);ok(m['A社']&&m['B社'],'ロゴ両方残る');}

// 9 エラー・不正
{const T=setup();let j=T.api('apiRenameCompany','A社','夏インターン','B社');ok(j.ok===false&&/すでに/.test(j.error),'重複改名はエラー');ok(!T.heldRef(),'エラー後もロック解放');
 j=T.api('toString');ok(j.ok===false,'継承プロパティは拒否');
 j=JSON.parse(T.ctx.__.waRoute_({key:'x',action:'apiGetData'}).s);ok(j.error==='unauthorized','鍵違い');}

// 10 改名・分割・削除
{const T=setup();T.api('apiSaveLogo','A社','L');T.api('apiAddEvent','A社','夏インターン','面接','2030-03-01T10:00','','','','');
 T.api('apiRenameCompany','A社','夏インターン','A社（新）');ok(row(T,'A社（新）','夏インターン'),'改名');ok(T.sheets['予定'].d[1][0]==='A社（新）','予定も改名');
 ok(JSON.parse(T.ctx.PropertiesService._m.wa_logos)['A社（新）']==='L','ロゴ移動');
 T.api('apiSplitCompany','A社（新）','夏インターン','A社（別）');const s=row(T,'A社（別）','夏インターン');ok(s&&s[1]==='https://a'&&s[3]==='pwa'&&s[7]==='エントリー','分割でURL/PW引継ぎ');
 ok(Object.values(T.sheets.Sheet1.f).filter(f=>f.includes('drive/a')).length===2,'フォルダリンク引継ぎ');
 const evId=T.sheets['予定'].d[1][4];
 const j=T.api('apiDeleteCompany','A社（新）','夏インターン');ok(!row(T,'A社（新）','夏インターン'),'削除');ok(T.sheets['予定'].getLastRow()===1,'予定行削除');ok(!T.cal[evId].alive,'予定カレンダー削除');
 ok(j.items.length===3,'残り件数');}

// 11 追加の重複防止・連日予定
{const T=setup();T.api('apiAddCompany',{c:'D社',term:'本選考',due:'2030-01-01T09:30'});const r=row(T,'D社','本選考');ok(r&&r[5]===9&&r[6]===30,'追加＋締切');
 const n=T.sheets.Sheet1.getLastRow();T.api('apiAddCompany',{c:'D社',term:'本選考'});ok(T.sheets.Sheet1.getLastRow()===n,'重複追加を防ぐ');
 T.api('apiAddEvent','D社','本選考','インターン','2030-08-01T10:00','','2030-08-03T17:00',false,true);
 const ids=T.sheets['予定'].d[1][4];ok(ids.split(',').length===3,'連日 3件');
 T.api('apiDeleteEvent',T.sheets['予定'].d[1][5]);ok(ids.split(',').every(i=>!T.cal[i].alive),'連日を全部消す');}

// 12 1段階戻す・引継ぎ
{const T=setup();T.api('apiMarkFail','A社','夏インターン');T.api('apiPrevStage','A社','夏インターン','面接');const r=row(T,'A社','夏インターン');
 ok(r[7]==='面接'&&r[8]==='未'&&r[11]===''&&r[12]===''&&r[17]==='対応中','1段階戻す');
 T.api('apiCarryOver','A社','夏インターン');const c=row(T,'A社','本選考');ok(c&&c[2]==='ida'&&c[7]==='エントリー','本選考へ引継ぎ');}

// 13 並べ替え
{const T=setup();T.api('apiMarkDone','B社','夏インターン');const names=T.sheets.Sheet1.d.slice(1).map(r=>r[0]);ok(names.indexOf('B社')>names.indexOf('A社'),'済は後ろのレーン');
 ok(T.sheets.Sheet1.f[(names.indexOf('A社')+2)+',16'],'並べ替えでフォルダの数式も移動');}

// 14 Gmail 日付
{const T=setup();const g=T.ctx.__.gmPickDate_;const y=new Date().getFullYear();
 ok(g('締切は2026/09/30 23:59です')==='2026/9/30','年付き');
 ok(g('締切：2027年1月5日')==='2027/1/5','年月日');
 const m=g('提出期限 12/25（木）');ok(m&&/\/12\/25$/.test(m),'月日のみ '+m);
 ok(g('電話 03-1234-5678 まで')===null,'電話番号は拾わない');
 ok(g('第13/40号')===null,'ありえない月は捨てる');}

console.log(`GAS: ${pass} 件合格 / ${fail} 件不合格`);if(T=0)0;
