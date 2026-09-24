const vm=require('vm'),fs=require('fs'),path=require('path');
process.env.TZ='Asia/Tokyo';
function mk(){
const log=[];
class Rng{constructor(sh,r,c,nr,nc){Object.assign(this,{sh,r,c,nr:nr||1,nc:nc||1})}
 cell(i,j){const row=this.sh.d[this.r-1+i]||[];const v=row[this.c-1+j];return v===undefined?'':v}
 getValues(){const o=[];for(let i=0;i<this.nr;i++){const a=[];for(let j=0;j<this.nc;j++)a.push(this.cell(i,j));o.push(a)}return o}
 getValue(){return this.cell(0,0)}
 setValues(v){if(v.length!==this.nr||v[0].length!==this.nc)throw Error(`setValues size ${v.length}x${v[0].length} vs ${this.nr}x${this.nc}`);for(let i=0;i<this.nr;i++)for(let j=0;j<this.nc;j++)this.sh.put(this.r+i,this.c+j,v[i][j]);return this}
 setValue(v){for(let i=0;i<this.nr;i++)for(let j=0;j<this.nc;j++)this.sh.put(this.r+i,this.c+j,v);return this}
 clearContent(){return this.setValue('')}
 getFormulas(){const o=[];for(let i=0;i<this.nr;i++){const a=[];for(let j=0;j<this.nc;j++)a.push(this.sh.f[(this.r+i)+','+(this.c+j)]||'');o.push(a)}return o}
 getFormula(){return this.getFormulas()[0][0]}
 setFormula(f){this.sh.f[this.r+','+this.c]=f;this.sh.put(this.r,this.c,'📁');return this}
 setNumberFormat(){return this} setHorizontalAlignment(){return this} setBorder(){return this}
 sort(specs){const rows=[];for(let i=0;i<this.nr;i++){const a=[];for(let j=0;j<this.nc;j++)a.push(this.cell(i,j));a._f={};rows.push({a,f:Object.fromEntries(Object.entries(this.sh.f).filter(([k])=>+k.split(',')[0]===this.r+i).map(([k,v])=>[k.split(',')[1],v]))})}
  const val=x=>x instanceof Date?x.getTime():x;
  rows.sort((p,q)=>{for(const s of specs){const a=val(p.a[s.column-this.c]),b=val(q.a[s.column-this.c]);if(a===b)continue;if(a===''||a===undefined)return 1;if(b===''||b===undefined)return -1;return (a<b?-1:1)*(s.ascending?1:-1)}return 0});
  for(let i=0;i<this.nr;i++){for(const k of Object.keys(this.sh.f))if(+k.split(',')[0]===this.r+i)delete this.sh.f[k]}
  rows.forEach((o,i)=>{o.a.forEach((v,j)=>this.sh.put(this.r+i,this.c+j,v));for(const [c,f] of Object.entries(o.f))this.sh.f[(this.r+i)+','+c]=f});return this}
}
class Sheet{constructor(n,d){this.n=n;this.d=d;this.f={};this.maxC=26}
 getName(){return this.n}
 put(r,c,v){while(this.d.length<r)this.d.push([]);const row=this.d[r-1];while(row.length<c)row.push('');row[c-1]=v}
 getRange(r,c,nr,nc){if(typeof r==='string')throw Error('A1 not mocked');if(c+ (nc||1)-1>this.maxC)throw Error('range beyond max columns');if(r<1||c<1||(nr!==undefined&&nr<1))throw Error('bad range '+[r,c,nr,nc]);return new Rng(this,r,c,nr,nc)}
 getLastRow(){for(let i=this.d.length;i>0;i--)if((this.d[i-1]||[]).some(v=>v!==''&&v!==undefined))return i;return 0}
 getLastColumn(){let m=0;this.d.forEach(r=>r.forEach((v,j)=>{if(v!==''&&v!==undefined)m=Math.max(m,j+1)}));return m}
 getMaxColumns(){return this.maxC} insertColumnAfter(){this.maxC++}
 deleteRow(r){this.d.splice(r-1,1);const nf={};for(const[k,v]of Object.entries(this.f)){const[a,b]=k.split(',').map(Number);if(a===r)continue;nf[(a>r?a-1:a)+','+b]=v}this.f=nf}
 appendRow(a){this.d.splice(this.getLastRow(),0,a.slice())}
 getRangeList(){return {setNumberFormat(){}}}}
const sheets={};
const ss={getSheetByName:n=>sheets[n]||null,insertSheet:n=>(sheets[n]=new Sheet(n,[]))};
let ev=0;const cal={};
function mkEv(t){const id='ev'+(++ev);const o={id,t,alive:true,getId:()=>id,removeAllReminders(){},addPopupReminder(){},setTitle(x){o.t=x},setDescription(){},setAllDayDate(){},setTime(){},deleteEvent(){o.alive=false}};cal[id]=o;return o}
let held=false;
const pad=n=>('0'+n).slice(-2);
const ctx={console:{warn:(...a)=>log.push(a.join(' ')),log(){} },JSON,Math,Date,String,Object,Array,parseInt,isNaN,Error,Set,
 SpreadsheetApp:{openById:()=>ss,getActiveSpreadsheet:()=>ss,flush(){},getUi:()=>({alert(){}}),BorderStyle:{SOLID_THICK:1}},
 CalendarApp:{getDefaultCalendar:()=>({createEvent:t=>mkEv(t),createAllDayEvent:t=>mkEv(t),getEventById:id=>cal[id]&&cal[id].alive?cal[id]:null,getEventSeriesById:()=>null})},
 DriveApp:{getFolderById:()=>({getFoldersByName:()=>({hasNext:()=>false}),createFolder:n=>({getUrl:()=>'https://drive.google.com/'+encodeURIComponent(n)})})},
 LockService:{getScriptLock:()=>({waitLock(){if(held)throw Error('NESTED LOCK');held=true},tryLock(){if(held)return false;held=true;return true},releaseLock(){held=false}})},
 CacheService:(()=>{const m={};return{getScriptCache:()=>({get:k=>m[k]||null,put:(k,v)=>{m[k]=v},remove:k=>{delete m[k]}}),_m:m}})(),
 PropertiesService:(()=>{const m={};return{getUserProperties:()=>({getProperty:k=>m[k]||null,setProperty:(k,v)=>{m[k]=v},deleteProperty:k=>{delete m[k]}}),_m:m}})(),
 Utilities:{getUuid:()=>Math.random().toString(16).slice(2)+'00000000',formatDate:(d,tz,f)=>f.replace(/'T'/,'T').replace('yyyy',d.getFullYear()).replace('MM',pad(d.getMonth()+1)).replace('dd',pad(d.getDate())).replace('HH',pad(d.getHours())).replace('mm',pad(d.getMinutes()))},
 ContentService:{createTextOutput:s=>({s,setMimeType(){return this}}),MimeType:{JSON:'json'}},
 GmailApp:{}};
vm.createContext(ctx);
const src=['Code.gs','WebApp.gs','WebAppApi.gs'].map(f=>fs.readFileSync(path.join(__dirname,'..','legacy-gas',f),'utf8')).join('\n');
vm.runInContext(src+'\n;this.__={waRoute_,gmPickDate_,autoSort,waCols_}',ctx);
return {ctx,sheets,Sheet,cal,log,api:(action,...args)=>JSON.parse(ctx.__.waRoute_({key:vm.runInContext('WA_KEY',ctx),action,args}).s),heldRef:()=>held};
}
module.exports=mk;
