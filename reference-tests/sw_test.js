const vm=require('vm'),fs=require('fs'),path=require('path');
let pass=0,fail=0;const ok=(c,m)=>{if(c)pass++;else{fail++;console.log('✗ '+m)}};
const ORIGIN='https://example.github.io',BASE=ORIGIN+'/app/';
function env(net){
 const stores={};
 const keyOf=k=>typeof k==='string'?new URL(k,BASE).href:k.url;
 class Cache{constructor(){this.m=new Map()}
  async put(k,r){this.m.delete(keyOf(k));this.m.set(keyOf(k),r)}
  async match(k){return this.m.get(keyOf(k))}
  async add(k){const r=await net(keyOf(k),{});if(!r.ok)throw Error('add failed '+keyOf(k));await this.put(k,r)}
  async addAll(a){for(const k of a)await this.add(k)}
  async keys(){return [...this.m.keys()].map(url=>({url}))}
  async delete(k){return this.m.delete(keyOf(k))}}
 const caches={open:async n=>stores[n]||(stores[n]=new Cache()),keys:async()=>Object.keys(stores),delete:async n=>delete stores[n],
  match:async k=>{for(const c of Object.values(stores)){const r=await c.match(k);if(r)return r}}};
 const L={};const self={location:new URL(BASE+'sw.js'),addEventListener:(t,f)=>L[t]=f,skipWaiting:async()=>{},clients:{claim:async()=>{}}};
 const Req=function(u,o){return {url:new URL(u,BASE).href,...o}};
 const ctx={self,caches,fetch:(u,o)=>net(typeof u==='string'?u:u.url,o||{}),Request:Req,URL,Set,Promise,
  Response:{error:()=>({type:'error'}),redirect:(u,s)=>({type:'redirect',u,s})},console};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'..','sw.js'),'utf8'),ctx);
 async function fire(type,ev){const w=[];let rw;const e={...ev,waitUntil:p=>w.push(p),respondWith:p=>rw=p};L[type](e);const r=rw?await rw:undefined;await Promise.all(w.map(p=>Promise.resolve(p).catch(()=>{})));for(let i=0;i<3;i++)await Promise.all(w.map(p=>Promise.resolve(p).catch(()=>{})));return {r,handled:!!rw}}
 const req=(u,o={})=>({url:new URL(u,BASE).href,method:'GET',mode:o.mode||'no-cors',destination:o.destination||'',...o});
 return {stores,fire,req,ctx};
}
const R=(o)=>({ok:o.status>=200&&o.status<300,status:o.status||200,type:o.type||'basic',redirected:!!o.redirected,url:o.url||'',clone(){return this},tag:o.tag});
(async()=>{
 // install：部品が1つ欠けても入れ替わる
 let E=env(async u=>u.endsWith('favicon-32.png')?R({status:404}):R({status:200,tag:u}));
 await E.fire('install',{});
 ok(await (await E.ctx.caches.open('shukatsu-shell-v4')).match('./index.html'),'骨組みを保存');
 ok(await (await E.ctx.caches.open('shukatsu-asset-v4')).match('./icon-192.png'),'部品を保存（1つ欠けても続行）');

 // 骨組み：no-cache、404は保存しない、圏外は保存版
 let calls=[];E=env(async(u,o)=>{calls.push(o);return R({status:200,tag:'new'})});
 await E.fire('install',{});
 let {r}=await E.fire('fetch',{request:E.req(BASE+'index.html?x=1',{mode:'navigate'})});
 ok(r.tag==='new','骨組みはネット優先');ok(calls.some(o=>o.cache==='no-cache'),'no-cache で確認');
 let shellNet=async()=>R({status:500,tag:'err'});E.ctx.fetch=(u,o)=>shellNet(u,o);
 await E.fire('fetch',{request:E.req(BASE,{mode:'navigate'})});
 const saved=await (await E.ctx.caches.open('shukatsu-shell-v4')).match(BASE);ok(saved&&saved.tag!=='err','500で保存版を上書きしない');
 shellNet=async()=>{throw TypeError('offline')};
 ({r}=await E.fire('fetch',{request:E.req(BASE+'?q=2',{mode:'navigate'})}));ok(r&&r.tag==='new','圏外は保存版');
 ({r}=await E.fire('fetch',{request:E.req(ORIGIN+'/other/',{mode:'navigate'})}));ok(r&&(r.tag==='new'),'未保存のページは index.html で代用');
 shellNet=async()=>R({status:200,redirected:true,url:BASE});
 ({r}=await E.fire('fetch',{request:E.req(ORIGIN+'/app',{mode:'navigate'})}));ok(r.type==='redirect'&&r.u===BASE,'転送は転送として返す');

 // ロゴ：CORS成功は保存、404は保存しない、CORS不可は no-cors に切り替え
 const logo='https://icons.duckduckgo.com/ip3/a.co.jp.ico';
 let modes=[];E=env(async(u,o)=>{modes.push(o.mode||'req');return R({status:200,type:'cors',tag:'L1'})});
 ({r}=await E.fire('fetch',{request:E.req(logo,{destination:'image'})}));
 ok(r.tag==='L1'&&modes[0]==='cors','ロゴは CORS で取得');
 ok(await (await E.ctx.caches.open('shukatsu-logo-v4')).match(logo),'ロゴを保存');
 E.ctx.fetch=async()=>{throw TypeError('offline')};
 ({r}=await E.fire('fetch',{request:E.req(logo,{destination:'image'})}));ok(r.tag==='L1','圏外でも保存版');
 const miss='https://icons.duckduckgo.com/ip3/none.ico';
 E.ctx.fetch=async()=>R({status:404,type:'cors'});
 await E.fire('fetch',{request:E.req(miss,{destination:'image'})});
 ok(!(await (await E.ctx.caches.open('shukatsu-logo-v4')).match(miss)),'404は保存しない');
 let seen=[];E.ctx.fetch=async(u,o)=>{seen.push(o?o.mode:'req');if(o&&o.mode==='cors')throw TypeError('cors');return R({status:0,type:'opaque',tag:'op'})};
 const g='https://www.google.com/s2/favicons?domain=b.jp&sz=256';
 ({r}=await E.fire('fetch',{request:E.req(g,{destination:'image'})}));ok(r.tag==='op','CORS不可なら従来の形式で取得');
 seen=[];await E.fire('fetch',{request:E.req('https://www.google.com/s2/favicons?domain=c.jp',{destination:'image'})});
 ok(seen.length===1&&seen[0]!=='cors','CORS不可のホストは次から直接');
 E.ctx.fetch=async()=>{throw TypeError('offline')};
 ({r}=await E.fire('fetch',{request:E.req('https://icons.duckduckgo.com/ip3/zz.ico',{destination:'image'})}));ok(r&&r.type==='error','保存版なし＋圏外はエラー応答');

 // 素通し
 let h=await E.fire('fetch',{request:E.req('https://script.google.com/macros/s/x/exec')});ok(!h.handled,'Apps Script は素通し');
 h=await E.fire('fetch',{request:{...E.req('https://www.wikidata.org/w/api.php?x'),destination:''}});ok(!h.handled,'Wikidata は素通し');
 h=await E.fire('fetch',{request:{...E.req(BASE),method:'POST'}});ok(!h.handled,'POST は素通し');

 // 件数の上限
 E=env(async()=>R({status:200,type:'cors'}));
 for(let i=0;i<340;i++)await E.fire('fetch',{request:E.req('https://icons.duckduckgo.com/ip3/d'+i+'.ico',{destination:'image'})});
 const n=(await (await E.ctx.caches.open('shukatsu-logo-v4')).keys()).length;ok(n<=300+20,'ロゴ件数の上限 '+n);

 // activate：古い版を消す
 await E.ctx.caches.open('shukatsu-logo-v3');await E.fire('activate',{});ok(!(await E.ctx.caches.keys()).includes('shukatsu-logo-v3'),'古い版を削除');

 console.log(`sw.js: ${pass} 件合格 / ${fail} 件不合格`);
})().catch(e=>console.log('CRASH',e));
