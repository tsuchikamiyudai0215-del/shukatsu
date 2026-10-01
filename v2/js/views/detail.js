/*
 * 会社の詳細。スマホは下から出るシート、幅 1000px 以上は右のパネル。
 * タブは 概要／予定／選考ルート。
 *
 * 状態を変える操作は store.mutate を通す（Domain.apply で先に画面を変え、裏で送る）。
 * 会社の追加・削除や予定の追加など、先に画面を変えないものは store.run で待つ。
 */
import { html, join, setHtml, safeUrl } from '../html.js';
import { ui, isWide, setSetOpen, setOpenInChrome, stagePalette, rememberStage } from '../state.js';
import * as store from '../store.js';
import { call } from '../api.js';
import { logo, keepLogos, manualValue, setManualUrl, refetch, fromFile, forgetLogo } from '../logo.js';
import { toast, toastUndo, busy, copyText } from '../ui/notice.js';
import { showSheet, closeSheet, isSheetOpen } from '../ui/sheet.js';
import { bindReorder } from '../ui/reorder.js';
import { dtField, dtValue, snapFields, restoreFields } from './fields.js';
import { rem, since, fdate, ftime, evActive, evOngoing, evWhen, evDays, spanText, byStart, gcalUrl } from '../format.js';

const LABEL = { todo: '対応中', waiting: '結果待ち', offer: '内定', joined: '参加決定', failed: '選考終了', skipped: '見送り' };
const INDUSTRY_HINTS = ['IT・SIer', 'メーカー', 'インフラ', '通信', '航空・運輸', '金融', '商社', '不動産・建設', 'コンサル',
  '人材・広告', '小売・サービス', '医薬・化学', '公共・その他'];

let rerenderAll = () => {};
export function onDetailRerender(fn) { rerenderAll = fn; }

function current() { return ui.openId ? store.company(ui.openId) : null; }
function eventsOf(id) { return store.eventsOf(id).sort(byStart); }

/* ホーム画面のアイコンから全画面で開いているか */
function standalone() {
  try {
    return window.navigator.standalone === true
      || !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  } catch (e) { return false; }
}

/* もう Chrome のタブの中にいるか。そのときは Chrome 行きの URL にしても、自分宛てなので何も起きない */
function inChromeTab(ua) {
  if (standalone()) return false;
  if (/CriOS/i.test(ua)) return true;
  return /Android/i.test(ua) && /Chrome\//i.test(ua) && !/; wv\)|SamsungBrowser|EdgA|OPR|YaBrowser/i.test(ua);
}

/* マイページを Chrome で開く URL に置き換える。iOS は googlechrome(s)://、Android は intent:// */
function extHref(url) {
  if (!ui.openInChrome || !url) return url;
  const ua = window.navigator.userAgent || '';
  if (inChromeTab(ua)) return url;
  if (/iPhone|iPad|iPod/i.test(ua)) {
    if (/^https:\/\//i.test(url)) return 'googlechromes://' + url.slice(8);
    if (/^http:\/\//i.test(url)) return 'googlechrome://' + url.slice(7);
    return url;
  }
  if (/Android/i.test(ua)) {
    const m = url.match(/^https?:\/\/(.+)$/i);
    if (!m) return url;
    return 'intent://' + m[1] + '#Intent;scheme=' + (/^https/i.test(url) ? 'https' : 'http') + ';package=com.android.chrome;end';
  }
  return url;
}

/* 別のアプリ（Chrome）へ渡す URL は、同じ画面のまま開く。新しいタブにすると、ホーム画面のアイコンからは何も起きないことがある */
function myPageLink(url) {
  const href = extHref(url);
  const toApp = !/^https?:/i.test(href);
  return html`<a class="big" style="flex:1;margin:0;background:#fff;color:#000"${toApp ? '' : html` target="_blank"`} rel="noopener noreferrer" href="${safeUrl(href)}">マイページ</a>`;
}

// ============================================================
// 描く
// ============================================================

function railHtml(c) {
  const rt = Domain.routeOf(c), cur = Domain.position(c), idx = rt.indexOf(cur), dead = c.status === 'failed';
  return html`<div class="rail">${rt.map((s, i) => {
    const passed = idx >= 0 && i < idx, here = idx === i;
    const col = dead ? 'var(--dim)' : here ? 'var(--text)' : passed ? 'var(--muted)' : 'var(--line)';
    const sz = here ? 8 : 5;
    /* つながった段階は、太い帯と点のまわりの輪で1つのまとまりに見せる */
    const lk = Domain.isLinked(c, s), inGroup = lk || (i > 0 && Domain.isLinked(c, rt[i - 1]));
    const ring = [here && !dead ? '0 0 0 4px rgba(255,255,255,.15)' : '', inGroup ? '0 0 0 ' + (here ? 5 : 3) + 'px rgba(10,132,255,.3)' : ''].filter(Boolean).join(',');
    return html`<div style="display:flex;align-items:center;${i === rt.length - 1 ? 'flex:0 0 auto' : 'flex:1'}"><i style="width:${sz}px;height:${sz}px;background:${col}${ring ? ';box-shadow:' + ring : ''}"></i>${i < rt.length - 1 && html`<u class="${lk ? 'lk' : ''}" style="background:${lk ? 'rgba(10,132,255,.3)' : passed && !dead ? 'var(--muted)' : 'var(--line)'}"></u>`}</div>`;
  })}</div><div class="railtxt">${rt.map((s) => html`<span style="${s === cur ? 'color:var(--text)' : ''}">${s}</span>`)}</div>`;
}

const btn = (style, act, text, extra) => html`<button class="big" style="${style}" data-act="${act}"${extra || ''}>${text}</button>`;
const note = (text) => html`<div style="font-size:11px;color:var(--dim);margin-top:8px;line-height:1.7">${text}</div>`;

/* まとまりの頭に置く、色の丸のアイコン（iPhone の「設定」や「探す」と同じ並べ方） */
const ICONS = {
  due: html`<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/></svg>`,
  wait: html`<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10M7 20h10M8 4c0 5 8 5 8 8s-8 3-8 8M16 4c0 5-8 5-8 8"/></svg>`,
  day: html`<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><rect x="4.5" y="6" width="15" height="13.5" rx="2.5"/><path d="M4.5 10.5h15M9 4v3.5M15 4v3.5"/></svg>`,
  key: html`<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.5" cy="12" r="3.5"/><path d="M12 12h8M17 12v3M20 12v2"/></svg>`,
  more: html`<svg viewBox="0 0 24 24" fill="#fff"><circle cx="6.5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="17.5" cy="12" r="1.9"/></svg>`
};
/* 見出しつきのまとまり。中身は行（.irow）を並べ、行どうしは細い線で区切る */
const section = (icon, color, title, body) => html`<section class="ig"><div class="ig-head"><span class="ig-ic" style="background:${color}">${ICONS[icon]}</span><span class="ig-title">${title}</span></div>${body}</section>`;
/* まとまりの中の、押せる行。文字だけで、色で意味を分ける（青：ふつう、赤：やめる方向） */
const rowBtn = (act, text, tone) => html`<button class="irow ${tone || ''}" data-act="${act}">${text}</button>`;

function infoTab(c, now) {
  const st = Domain.viewStatus(c, new Date(now));
  const parts = [];

  if (st === 'todo') {
    const r = c.dueAt ? rem(c.dueAt, now) : null;
    parts.push(section('due', 'var(--blue)', '締切まで', html`<div class="ig-body">${r
      ? html`<div class="cd" style="margin-top:0;color:${r.ms < 172800000 ? 'var(--hot)' : 'var(--text)'}"><b style="font-size:50px">${r.d}</b><s>d</s><b style="font-size:50px">${('0' + r.h).slice(-2)}</b><s>h</s><b style="font-size:50px">${('0' + r.m).slice(-2)}</b><s>m</s></div><div class="sub">${fdate(c.dueAt)}${c.dueHasTime ? ' ' + ftime(c.dueAt) : ' 時刻未設定'}</div>`
      : html`<div style="font-size:15px;color:var(--muted)">締切が未設定です。</div>`}</div><div class="ig-body">${dtField('coDue', c.dueAt, '23:59')}</div>${rowBtn('set-due', '締切を保存', 'blue')}${c.dueAt && rowBtn('clear-due', '未定にする', 'blue')}`));
  }
  if (st === 'waiting') {
    const d = since(Domain.waitingSince(c), now);
    const goal = Domain.goalOf(c.term) === 'joined' ? '参加決定' : '内定';
    parts.push(section('wait', 'var(--wait)', '結果待ち', html`<div class="ig-body"><div class="cd" style="margin-top:0;color:var(--wait)"><b style="font-size:50px">${d == null ? '—' : d}</b><s>日経過</s></div>${Domain.isAutoSent(c, new Date(now)) && html`<div class="sub" style="color:var(--wait)">締切経過で自動送り</div>`}<div style="display:flex;gap:10px;margin-top:16px"><button class="big" style="flex:1;margin:0;background:var(--go);color:#00220E" data-act="pass">${Domain.isFinalStep(c) ? goal : '通過'}</button><button class="big" style="flex:1;margin:0;background:rgba(255,255,255,.1);color:var(--text);font-weight:500" data-act="fail">落選</button></div></div>`));
  }
  if (st === 'joined') {
    const ev = eventsOf(c.id).filter((e) => evActive(e, now))[0];
    const rr = ev ? rem(ev.startAt, now) : null;
    parts.push(section('day', 'var(--go)', '実施日まで', html`<div class="ig-body">${rr
      ? html`<div class="cd" style="margin-top:0;color:var(--go)"><b style="font-size:50px">${rr.d}</b><s>日</s></div><div class="sub">${evWhen(ev)}${evDays(ev) > 1 ? '（' + evDays(ev) + '日間）' : ''}</div>`
      : ev ? html`<div class="cd" style="margin-top:0;color:var(--go)"><b style="font-size:34px">開催中</b></div><div class="sub">${evWhen(ev)}</div>`
        : html`<div style="font-size:14px;color:var(--muted);line-height:1.7">実施日が未登録です。「予定」タブで、種別「インターン」として日時を入れてください。</div>`}</div>`));
  }

  /* 開いてすぐ使うものを上に。スクロールせずに届く位置に置く */
  if (c.url || c.folderUrl) {
    parts.push(html`<div style="display:flex;gap:10px;margin-top:14px">${c.url && html`${myPageLink(c.url)}`}${c.folderUrl && html`<a class="big" style="flex:1;margin:0;background:var(--ios-fill);color:var(--text);font-weight:500" target="_blank" rel="noopener noreferrer" href="${safeUrl(c.folderUrl)}">書類フォルダ</a>`}</div>`);
  }
  /* ログインID・パスワード・結果日は、1つのまとまりに入れる */
  const kvs = [];
  if (c.loginId) kvs.push(html`<button class="kv idrow" data-act="copy-id"><span>ログインID</span><span class="idval">${c.loginId}<i>コピー</i></span></button>`);
  /* パスワードは押したときだけ取りに行く。画面には伏せ字しか出さない */
  kvs.push(html`<button class="kv idrow" data-act="copy-pw"><span>パスワード</span><span class="idval">••••••<i>コピー</i></span></button>`);
  if (c.resultAt && ['offer', 'joined', 'failed'].includes(st)) kvs.push(html`<div class="kv"><span>結果日</span><span>${fdate(c.resultAt)}</span></div>`);
  parts.push(section('key', '#8E8E93', 'ログイン', kvs));

  /* よく押すものは、まとまりの外に大きなボタンで置く */
  /* 「次とまとめて結果が出る」段階は、結果待ちを通らずに次の段階へ進む */
  if (st === 'todo') {
    parts.push(Domain.isLinked(c, c.stage)
      ? btn('background:var(--blue);color:#fff', 'advance', '提出して' + Domain.nextStage(c) + 'へ')
      : btn('background:var(--blue);color:#fff', 'done', '完了にして結果待ちへ'));
  }

  /* たまにしか使わない操作は、文字だけの行にまとめる。段階を1つ戻すのは、押した直後の「取り消す」か、選考ルートのタブで */
  const more = [];
  /* 締切経過で自動送りになっている行は、保存上はまだ対応中なので出さない */
  if (c.status !== 'todo') more.push(rowBtn('reopen', '対応中に戻す', 'blue'));
  if (st === 'waiting') more.push(rowBtn('join', '参加決定にする', 'blue'));
  if (c.dueAt && st === 'todo') {
    more.push(html`<a class="irow blue" target="_blank" rel="noopener noreferrer" href="${safeUrl(gcalUrl(c.name + ' ' + c.stage + ' 締切', c.dueAt, c.url, !c.dueHasTime))}">Googleカレンダーに追加</a>`);
  }
  if (st === 'todo' || st === 'waiting') more.push(rowBtn('skip', '見送りにする', 'red'));
  if (more.length) parts.push(section('more', '#636366', 'そのほか', more));
  parts.push(settingsHtml(c));
  return join(parts);
}

/* 業種はプルダウンから選ぶ。スマホでは文字の欄に付けた候補がプルダウンにならず、キーボードの上にしか出ないため。
   候補に無い名前は「自分で入力」で入れられるようにしておく */
const IND_OWN = '__own';
function industryField(c, names, row) {
  const cur = c.industry || '';
  const custom = !!cur && !names.includes(cur);
  return html`<select class="f" id="indSel" data-change="industry-pick" data-nokeep style="margin:0"><option value=""${cur ? '' : html` selected`}>未設定</option>${names.map((x) => html`<option value="${x}"${x === cur ? html` selected` : ''}>${x}</option>`)}${custom && html`<option value="${cur}" selected>${cur}</option>`}<option value="${IND_OWN}">自分で入力…</option></select><div id="indOwn" style="display:none;margin-top:8px">${row('indVal', custom ? cur : '', 'set-industry', '保存', '例：NTT系')}</div>`;
}

/* 登録し直すときだけ触る欄。普段は畳んでおく（開閉は端末に覚える） */
function settingsHtml(c) {
  const isCo = c.kind !== 'mgmt';
  const names = Domain.INDUSTRY_NAMES.concat(INDUSTRY_HINTS).filter((x, i, a) => a.indexOf(x) === i);
  const row = (id, value, act, label, placeholder) => html`<div style="display:flex;gap:8px"><input class="f" style="flex:1 1 0;min-width:0;margin:0" id="${id}" value="${value}" placeholder="${placeholder || ''}"><button class="gh" style="padding:0 14px;color:var(--text)" data-act="${act}">${label}</button></div>`;
  return html`<details class="setwrap" id="setwrap"${ui.setOpen ? html` open` : ''}><summary>この会社の設定</summary>
<div class="setsec"><div class="lab" style="margin:0 0 8px">マイページの登録</div><input class="f" id="coUrl" placeholder="https://…（マイページのURL）" value="${c.url}"><input class="f" id="coId" placeholder="ログインID" value="${c.loginId}" style="margin-top:8px"><button class="gh" style="margin-top:8px" data-act="set-info">保存</button>
<div style="display:flex;gap:8px;margin-top:14px"><input class="f" style="flex:1 1 0;min-width:0;margin:0" id="coPw" type="password" autocomplete="new-password" placeholder="パスワード（変えるときだけ入力）"><button class="gh" style="padding:0 14px;color:var(--text)" data-act="set-pw">保存</button></div>
${note('パスワードはシートにだけ保存します。この端末と画面には残しません。')}
<label style="display:flex;align-items:center;gap:10px;margin-top:12px;cursor:pointer;font-size:13px"><input type="checkbox" id="chromeSw" data-change="chrome"${ui.openInChrome ? html` checked` : ''} style="width:20px;height:20px;accent-color:var(--blue)">マイページを Chrome で開く</label>${note('この端末だけの設定です。Chrome が入っていないと何も起きないので、その場合は外してください。')}</div>
${isCo && html`<div class="setsec"><div class="lab" style="margin:0 0 8px">業種</div>${industryField(c, names, row)}${note('記録タブの集計に使います。未設定なら社名から推定します。「NTT系」のようなグループ名にしたいときは「自分で入力」から入れます。')}</div>
<div class="setsec"><div class="lab" style="margin:0 0 8px">会社名</div>${row('renName', c.name, 'rename', '変更')}${note('予定とカレンダーの見出しも付け替えます。タイルでは「株式会社」を省いて出すので、正式名称で入れておけます。')}</div>
<div class="setsec"><div class="lab" style="margin:0 0 8px">同じマイページで別の選考を追加</div>${row('splitName', '', 'split', '追加', '例：' + Domain.shortName(c.name) + '（業務企画職）')}${note('マイページURL・ログインID・パスワード・ロゴ・業種を引き継いだ行を作ります。コース別に選考が分かれる会社を、別々に追えます。')}</div>`}
<div class="setsec"><div class="lab" style="margin:0 0 8px">ロゴ（URL を入れると自動では変わりません）</div>${row('logoUrl', manualValue(c), 'logo-set', '適用', '画像URLを貼って上書き')}<button class="gh" style="margin-top:8px" data-act="logo-get">自動で取り直す</button><div style="margin-top:10px"><label class="gh" style="display:inline-block;cursor:pointer;color:var(--text)">画像ファイルから選ぶ<input type="file" accept="image/*" style="display:none" data-change="logo-file"></label></div>${note('Wikidata の公式ロゴ、公式サイトのファビコン、Wikipedia の画像の順に探します。画像ファイルはこの端末にだけ保存します。')}</div>
<div style="margin-top:34px;padding-top:18px;border-top:1px solid var(--line-soft)"><div class="lab" style="margin:0 0 8px;color:var(--hot)">この会社を削除</div><div style="font-size:11px;color:var(--dim);line-height:1.7">${c.term}の行と、この会社の予定・カレンダー登録をまとめて消します。元に戻せません。書類フォルダは残します。</div><button class="big" style="background:transparent;border:1px solid rgba(255,69,58,.5);color:var(--hot);font-weight:500" data-act="delete-company">削除する</button></div>
</details>`;
}

function eventsTab(c, now) {
  const evs = eventsOf(c.id);
  return html`<div style="margin-top:18px">${!evs.length && html`<div style="font-size:12px;color:var(--dim);line-height:1.9">面接や説明会、インターンの日時を入れると、予定レーンに並びます。カレンダーにも登録されます。</div>`}${evs.map((ev) => {
    const r = rem(ev.startAt, now), live = evOngoing(ev, now);
    const span = spanText(ev);
    return html`<div style="border-bottom:1px solid var(--line-soft);padding:12px 0;display:flex;align-items:center;gap:10px"><span style="font-family:var(--disp);font-size:${r ? '26px' : '13px'};font-weight:600;min-width:34px;color:${r ? (r.d <= 2 ? 'var(--hot)' : 'var(--text)') : (live ? 'var(--go)' : 'var(--dim)')}">${r ? r.d : (live ? '開催中' : '—')}</span><div style="flex:1"><div style="font-size:14px">${ev.kind}${span && html`<span style="font-family:var(--mono);font-size:10px;color:var(--muted);margin-left:8px">${span}</span>`}</div><div class="sub" style="margin-top:3px">${evWhen(ev)}${ev.place ? ' ' + ev.place : ''}</div></div><button class="gh" style="color:var(--hot);padding:6px 10px" data-act="delete-event" data-v="${ev.id}" aria-label="予定を削除">×</button></div>`;
  })}<div style="margin-top:20px;padding:14px;border:1px solid var(--line);border-radius:var(--r-field);background:rgba(255,255,255,.05);overflow:hidden"><div class="lab" style="margin:0 0 8px">予定を追加</div><select class="f" id="evKind">${Domain.EVENT_KINDS.map((k) => html`<option>${k}</option>`)}</select><label style="display:flex;align-items:center;gap:10px;margin-top:14px;cursor:pointer;font-size:13px"><input type="checkbox" id="evAll" data-change="allday" style="width:20px;height:20px;accent-color:var(--blue)">終日（時刻を使わない）</label><div class="lab" style="margin:14px 0 6px" id="evAtLab">開始日時</div>${dtField('evAt', '', '10:00')}<div class="lab" style="margin:12px 0 6px" id="evEndLab">終了日時（任意）</div>${dtField('evEnd', '', '17:00')}<label style="display:flex;align-items:center;gap:10px;margin-top:12px;cursor:pointer;font-size:13px" id="evDailyWrap"><input type="checkbox" id="evDaily" style="width:20px;height:20px;accent-color:var(--blue)">毎日この時間帯（連日）</label><div style="font-size:11px;color:var(--dim);margin-top:6px;line-height:1.7" id="evHint">同じ日の中で終了時刻を入れると、その時間帯の予定になります。<br>別の日まで指定したときは、「連日」に印を付けると毎日その時間帯で登録します。付けないと、夜通し続く1件の予定になります。</div><input class="f" id="evPlace" placeholder="場所・オンラインURL" style="margin-top:12px"><button class="big" style="background:#fff;color:#000" data-act="add-event">追加</button></div></div>`;
}

function routeTab(c) {
  const rt = Domain.routeOf(c), cur = Domain.position(c);
  /* ⊖ で削除、段階名を押すと現在地、≡ をつかんで並べ替え（左右のスワイプでも削除）。ボタンは行ごとに2つだけにする */
  const row = (s, i) => html`<div class="rrow${cur === s ? ' cur' : ''}" data-i="${i}"><button class="rminus" data-act="route-rm" data-v="${i}" aria-label="${s}を削除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9.2"/><path d="M7.5 12h9" stroke-linecap="round"/></svg></button><button class="rname" data-act="route-cur" data-v="${i}">${s}${cur === s && html`<span class="rcur">現在</span>`}</button><span class="rgrip" aria-label="${s}を並べ替え"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 8h14M5 12h14M5 16h14"/></svg></span></div>`;
  /* 段階 i と i+1 の境目。つなぐと、2つの結果が1回で出る扱いになる */
  const joint = (i) => {
    const on = Domain.isLinked(c, rt[i]), verb = on ? '切る' : 'つなぐ';
    return html`<div class="rjoint${on ? ' on' : ''}"><button class="gh" data-act="route-link" data-v="${i}" aria-pressed="${on ? 'true' : 'false'}" aria-label="${rt[i]}と${rt[i + 1]}を${verb}">${verb}</button></div>`;
  };
  /* つながった段階は1つの枠に入れ、枠の上に「ES＋テスト（結果は1回）」と出す */
  let start = 0;
  const gates = Domain.gatesOf(c).map((g, gi, all) => {
    const s0 = start;
    start += g.length;
    const body = g.map((s, k) => html`${k > 0 && joint(s0 + k - 1)}${row(s, s0 + k)}`);
    const box = g.length > 1
      ? html`<div class="rlab">${g.join('＋')}（結果は1回）</div><div class="rgate linked">${body}</div>`
      : html`<div class="rgate">${body}</div>`;
    return html`${box}${gi < all.length - 1 && joint(start - 1)}`;
  });
  return html`<div style="margin-top:18px">${railHtml(c)}<div class="rlist">${gates}</div><div class="lab" style="margin:16px 0 8px">よくある段階から選ぶ</div><div style="display:flex;gap:8px"><select class="f" style="flex:1 1 0;min-width:0;margin:0" id="addStage">${stagePalette().map((p) => html`<option>${p}</option>`)}</select><button class="gh" style="padding:0 18px;color:var(--text)" data-act="route-add">追加</button></div><div class="lab" style="margin:16px 0 8px">自分で名前を付けて追加</div><div style="display:flex;gap:8px"><input class="f" style="flex:1 1 0;min-width:0;margin:0" id="newStage" placeholder="例：リクルーター面談" data-enter="route-custom"><button class="gh" style="padding:0 18px;color:var(--text)" data-act="route-custom">追加</button></div><div style="font-size:11px;color:var(--dim);margin-top:12px;line-height:1.8">段階名を押すと現在地になります。最後の段階（インターンは「インターン」も）を現在地にすると、参加決定（本選考は内定）になります。<br>≡をつかんで上下に動かすと並べ替え、⊖か左右のスワイプで削除します。今の段階を消すと、次の段階が現在地になります。<br>段階の間の「つなぐ」を押すと、枠に入った段階は結果が1回で出る扱いになります。出したら「提出して次へ」で、結果待ちを通らずに次の段階へ進めます。「切る」で元に戻ります。<br>自分で足した名前は、次から上の一覧にも出ます。</div></div>`;
}

function tabContent(c) {
  const now = Date.now();
  if (ui.tab === 'events') return eventsTab(c, now);
  if (ui.tab === 'route') return routeTab(c);
  return infoTab(c, now);
}

/* 本選考への引き継ぎは、区分ごとに1回押すだけなので、概要のボタンの列には並べず、上のタブの右端に小さく置く */
function carryHtml(c) {
  if (Domain.termOf(c.term) === '本選考' || c.kind === 'mgmt') return '';
  return Domain.duplicateOf(store.companies(), c.name, '本選考')
    ? html`<span class="carry done">本選考あり</span>`
    : html`<button class="carry" data-act="carry" aria-label="本選考に引き継ぐ">本選考へ ›</button>`;
}

function fullHtml(c) {
  const st = Domain.viewStatus(c, new Date());
  const col = st === 'waiting' ? 'var(--wait)' : (st === 'offer' || st === 'joined') ? 'var(--go)' : 'var(--muted)';
  const tabs = [['info', '概要'], ['events', '予定 ' + store.eventsOf(c.id).length], ['route', '選考ルート']];
  return html`<div class="card-head"><div class="grab"></div><button class="sideclose" data-act="close-detail" aria-label="閉じる"><svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 2l8 8M10 2l-8 8"/></svg></button><div style="display:flex;align-items:center;gap:12px">${logo(c, 56)}<div><div style="font-size:19px;font-weight:700;letter-spacing:-.01em">${c.name}</div><div style="font-family:var(--mono);font-size:11px;color:${col};margin-top:3px">${Domain.position(c)} ${LABEL[st]}</div></div></div><div class="tabs">${tabs.map(([k, lab]) => html`<button data-act="tab" data-v="${k}" class="${ui.tab === k ? 'on' : ''}">${lab}</button>`)}${carryHtml(c)}</div></div><div class="tab-pane">${tabContent(c)}</div>`;
}

export function sideEmpty() {
  const el = document.getElementById('side');
  if (!el) return;
  el.dataset.id = '';
  setHtml(el, html`<div id="sideEmpty"><div style="font-size:22px;font-weight:700;letter-spacing:.2em;color:rgba(255,255,255,.14)">就活</div><div>左の一覧から会社を選ぶと<br>ここに詳細が出ます。</div></div>`);
}

/* 同じ会社を描き直すときは、スクロール位置と書きかけの値を残す。
   見出しとタブの中身の動きも止める。保存のたびに流れ直すと、画面が跳ねて見えるので */
function paintInto(card, c) {
  const same = card.dataset.id === c.id;
  const pane = card.querySelector('.tab-pane');
  const y = pane ? pane.scrollTop : 0;
  const snap = same ? snapFields(card) : null;
  keepLogos(card, () => setHtml(card, fullHtml(c)));
  bindReorder(card.querySelector('.rlist'), { onMove: moveStage, onRemove: removeStageAt });
  card.dataset.id = c.id;
  if (same) {
    const head = card.querySelector('.card-head');
    const np = card.querySelector('.tab-pane');
    if (head) head.style.animation = 'none';
    if (np) { np.style.animation = 'none'; np.scrollTop = y; }
  }
  restoreFields(card, snap);
}

export function renderDetail() {
  const c = current();
  if (!c) {
    ui.openId = null;
    if (isWide()) sideEmpty(); else closeSheet();
    return;
  }
  if (isWide()) {
    const side = document.getElementById('side');
    let card = side.querySelector('.card');
    if (!card) {
      setHtml(side, html`<div class="card"></div>`);
      card = side.querySelector('.card');
    }
    side.dataset.id = c.id;
    paintInto(card, c);
    return;
  }
  const card = document.querySelector('#sheet .sheet .card');
  if (card && card.classList.contains('detail')) { paintInto(card, c); return; }
  showSheet(html`<div class="sheet"><div class="card noblur detail" data-id="${c.id}">${fullHtml(c)}</div></div>`);
}

/* 詳細を開く。同じ会社を開き直したときも、開いたときの動きは見せる */
export function openDetail(id) {
  ui.openId = id;
  ui.tab = 'info';
  const card = isWide() ? document.querySelector('#side .card') : null;
  if (card) card.dataset.id = '';
  renderDetail();
}

export function closeDetail() {
  if (isWide()) { ui.openId = null; sideEmpty(); rerenderAll(false); } else closeSheet();
}

/* 詳細が今、画面に出ているか（スマホでは、ほかのシートが出ていることもある） */
export function detailShown() {
  if (!ui.openId) return false;
  if (isWide()) return true;
  return !!document.querySelector('#sheet .card.detail');
}

// ============================================================
// 操作
// ============================================================

function root() { return isWide() ? document.getElementById('side') : document.querySelector('#sheet .card.detail'); }
function field(id) { const r = root(); return r ? r.querySelector('#' + id) : null; }
function val(id) { const el = field(id); return el ? el.value.trim() : ''; }

/* 状態を変える操作。できない操作ならここで理由を出す */
function act(op, args, label) {
  try {
    store.mutate(ui.openId, op, args || {});
    if (label) toast(label, true);
  } catch (e) {
    toast(e.message);
  }
}

/* 「取り消す」を出す間。この間は送らずに待たせ、取り消されたら送らずに捨てる */
let UNDO_MS = 5000;
/* テストで待ち時間を縮めるため */
export function setUndoWait(ms) { UNDO_MS = ms; }

/* 完了・通過・落選・見送りなど、状態が大きく変わる操作。押し間違いは直後の「取り消す」で直す */
function actUndo(op, label) {
  const id = ui.openId;
  let item;
  try {
    item = store.mutate(id, op, {}, { delay: UNDO_MS, alone: true, durable: true });
  } catch (e) {
    toast(e.message);
    return;
  }
  toastUndo(label, () => {
    if (store.cancel(id, item)) toast('取り消しました。', true);
    else toast('もう保存していたので、取り消せませんでした。選考ルートのタブで段階を直せます。');
  }, Math.max(UNDO_MS, 2500));
}

async function runBusy(action, args, okMsg) {
  busy(true);
  try {
    const r = await store.run(action, args);
    if (okMsg) toast(okMsg, true);
    return r;
  } catch (e) {
    toast('保存できませんでした：' + e.message);
    return null;
  } finally {
    busy(false);
  }
}

function saveRoute(route, stage, label) {
  try {
    /* 続けて並べ替えることが多いので、400ms 待ってまとめて送る */
    store.mutate(ui.openId, 'setRoute', { route, stage: stage || '' }, { delay: 400 });
    if (label) toast(label, true);
  } catch (e) {
    toast(e.message);
  }
}

function toggleAllDay(on) {
  const r = root();
  if (!r) return;
  ['evAt', 'evEnd'].forEach((id) => { const w = r.querySelector('#' + id + 'Wrap'); if (w) w.className = on ? 'dtf no-time' : 'dtf'; });
  const dw = r.querySelector('#evDailyWrap');
  if (dw) dw.style.display = on ? 'none' : 'flex';
  if (on) { const d = r.querySelector('#evDaily'); if (d) d.checked = false; }
  const a = r.querySelector('#evAtLab'), b = r.querySelector('#evEndLab'), h = r.querySelector('#evHint');
  if (a) a.textContent = on ? '開始日' : '開始日時';
  if (b) b.textContent = on ? '終了日（任意）' : '終了日時（任意）';
  if (h) setHtml(h, on ? html`1日だけなら、終了日は空のままで大丈夫です。`
    : html`同じ日の中で終了時刻を入れると、その時間帯の予定になります。<br>別の日まで指定したときは、「連日」に印を付けると毎日その時間帯で登録します。付けないと、夜通し続く1件の予定になります。`);
}

async function addEvent() {
  const r = root();
  const all = !!(r.querySelector('#evAll') || {}).checked;
  let at = dtValue('evAt', r);
  let end = dtValue('evEnd', r);
  if (all) { at = at && at.slice(0, 10) + 'T00:00'; end = end && end.slice(0, 10) + 'T00:00'; }
  if (!at) { toast(all ? '開始日を入れてください。' : '開始日時を入れてください。'); return; }
  const endMs = end ? Domain.parseWall(end) : null, startMs = Domain.parseWall(at);
  if (end && endMs != null && (all ? endMs < startMs : endMs <= startMs)) {
    toast(all ? '終了日は開始日より後にしてください。' : '終了は開始より後にしてください。');
    return;
  }
  const fields = {
    companyId: ui.openId, kind: val('evKind'), startAt: at, endAt: all && end === at ? '' : end,
    allDay: all, daily: !all && !!(r.querySelector('#evDaily') || {}).checked, place: val('evPlace')
  };
  try { Domain.createEvent('check', ui.openId, fields); } catch (e) { toast(e.message); return; }
  const res = await runBusy('addEvent', fields, fields.daily && fields.endAt ? '連日の予定を追加しました。' : '予定を追加しました。');
  if (!res) return;
  /* 描き直しは書きかけを残すので、追加できた分は先に空にしておく */
  ['evAtD', 'evEndD', 'evPlace'].forEach((id) => { const el = r.querySelector('#' + id); if (el) el.value = ''; });
  ['evAll', 'evDaily'].forEach((id) => { const el = r.querySelector('#' + id); if (el) el.checked = false; });
  renderDetail();
}

export const detailActions = {
  'close-detail': () => closeDetail(),
  tab: (el) => {
    ui.tab = el.dataset.v;
    const r = root();
    if (!r) return;
    r.querySelectorAll('.tabs button').forEach((b) => { b.className = b.dataset.v === ui.tab ? 'on' : ''; });
    const pane = r.querySelector('.tab-pane');
    const c = current();
    if (pane && c) {
      setHtml(pane, tabContent(c));
      bindReorder(pane.querySelector('.rlist'), { onMove: moveStage, onRemove: removeStageAt });
      pane.scrollTop = 0;
      pane.classList.remove('swap');
      pane.style.animation = 'none'; void pane.offsetWidth; pane.style.animation = '';
      pane.classList.add('swap');
    }
  },

  done: () => actUndo('done', '結果待ちに移しました。'),
  advance: () => {
    const c = current();
    const next = c && Domain.nextStage(c);
    actUndo('advance', next ? next + ' に進みました。' : '次へ進みました。');
  },
  pass: () => {
    const c = current();
    const final = c && Domain.isFinalStep(c);
    const goal = c && Domain.goalOf(c.term) === 'joined' ? '参加決定' : '内定';
    actUndo('pass', final ? goal + 'として記録しました。' : '通過を記録しました。');
  },
  /* 落選と見送りは、取り消せるようになったので確かめない（押してすぐ「取り消す」で戻せる） */
  fail: () => actUndo('fail', '選考終了として記録しました。'),
  reopen: () => {
    /* 戻すと落ちた段階と結果日が消え、記録タブの落選も減る。受け直しは別の行で記録を残すのが決まり */
    if (current().status === 'failed'
      && !window.confirm('落選の記録が消えます。受け直すなら、設定の『同じマイページで別の選考を追加』を使うと記録が残ります。')) return;
    actUndo('reopen', '対応中に戻しました。');
  },
  join: () => actUndo('join', '参加決定にしました。'),
  skip: () => actUndo('skip', '見送りにしました。'),
  'set-due': () => {
    const v = dtValue('coDue', root());
    if (!v) { toast('日付を入れてください。'); return; }
    act('setDue', { dueAt: v, hasTime: true }, '締切を保存しました。');
  },
  'clear-due': () => act('setDue', { dueAt: '' }, '締切を未定にしました。'),
  'set-info': () => act('setInfo', { url: val('coUrl'), loginId: val('coId') }, 'マイページを保存しました。'),
  'set-industry': () => {
    const v = val('indVal');
    /* 入力中は描き直しを待つ作りなので、先に入力を終えて、プルダウンに今の業種が出るようにする */
    const input = field('indVal');
    if (input) input.blur();
    act('setIndustry', { industry: v }, v ? '業種を「' + v + '」にしました。' : '業種を空にしました。');
  },
  rename: () => {
    const c = current();
    const v = val('renName');
    if (!v) { toast('新しい会社名を入れてください。'); return; }
    if (v === c.name) { toast('今と同じ名前です。'); return; }
    if (Domain.duplicateOf(store.companies(), v, c.term, c.id)) { toast('その名前はすでに登録されています。'); return; }
    if (!window.confirm(c.name + ' を「' + v + '」に変えます。')) return;
    act('rename', { name: v }, '会社名を変えました。');
  },

  'copy-id': () => {
    const c = current();
    if (c) copyText(c.loginId, 'ログインID');
  },
  /* 押したときに1社分だけ取りに行き、そのまま控え帳へ。変数にも画面にも残さない */
  'copy-pw': () => {
    const id = ui.openId;
    copyText(call('getPassword', { id }, { retry: 1 }).then((r) => {
      if (!r.pw) throw new Error('パスワードが登録されていません。');
      return r.pw;
    }), 'パスワード');
  },
  'set-pw': async () => {
    const el = field('coPw');
    if (!el || !el.value) { toast('パスワードを入れてください。'); return; }
    const r = await runBusy('setPassword', { id: ui.openId, pw: el.value }, 'パスワードを保存しました。');
    /* 保存の間に描き直していることがあるので、欄は探し直してから空にする */
    const now = field('coPw');
    if (r && now) now.value = '';
    el.value = '';
  },

  carry: async () => {
    const c = current();
    if (!window.confirm(c.name + ' を本選考に引き継ぎます。会社名・マイページ・パスワード・ロゴ・書類フォルダを写した行を作ります。')) return;
    const r = await runBusy('carryOver', { id: c.id }, '本選考に引き継ぎました。');
    if (!r) return;
    ui.term = '本選考';
    ui.openId = r.company.id;
    ui.tab = 'info';
    rerenderAll(true);     // 区分が切り替わるので、切り替えの動きを見せる
  },
  split: async () => {
    const c = current();
    const v = val('splitName');
    if (!v) { toast('新しい選考の名前を入れてください。'); return; }
    if (Domain.duplicateOf(store.companies(), v, c.term)) { toast('その名前はすでに登録されています。'); return; }
    if (!window.confirm('「' + v + '」を追加します。' + c.name + ' のマイページURL・ID・パスワード・ロゴ・業種を引き継ぎます。')) return;
    const r = await runBusy('splitCompany', { id: c.id, name: v }, v + ' を追加しました。');
    if (!r) return;
    ui.openId = r.company.id;
    ui.tab = 'info';
    rerenderAll(false);
  },
  'delete-company': async () => {
    const c = current();
    const n = store.eventsOf(c.id).length;
    if (!window.confirm(c.name + '（' + Domain.termOf(c.term) + '）を削除します。\n選考の記録' + (n ? 'と予定' + n + '件' : '') + 'が消え、元には戻せません。')) return;
    if (!window.confirm('本当に削除しますか。\n' + c.name + ' の行を削除します。')) return;
    const r = await runBusy('deleteCompany', { id: c.id }, c.name + ' を削除しました。');
    if (!r) return;
    forgetLogo(c.id);
    closeDetail();
    rerenderAll(false);
  },

  'add-event': () => addEvent(),
  'delete-event': async (el) => {
    if (!window.confirm('この予定を削除します。カレンダーからも消えます。')) return;
    const r = await runBusy('deleteEvent', { id: el.dataset.v }, '予定を削除しました。');
    if (r) renderDetail();
  },

  'route-cur': (el) => {
    /* 行を左右にスワイプしたあとに来る click では、現在地を変えない */
    const r = el.closest && el.closest('.rrow');
    if (r && r.dataset.swiped) return;
    const c = current();
    const rt = Domain.routeOf(c), s = rt[+el.dataset.v];
    if (Domain.position(c) === s) return;
    const goal = Domain.goalOf(c.term) === 'joined' ? '参加決定' : '内定';
    const toGoal = Domain.isGoalStage(c.term, rt, s) && (c.status === 'todo' || c.status === 'waiting');
    const back = !Domain.isGoalStage(c.term, rt, s) && (c.status === 'offer' || c.status === 'joined');
    saveRoute(rt, s, s + ' を現在地にしました。' + (toGoal ? goal + 'にしました。' : back ? '対応中に戻しました。' : ''));
  },
  'route-rm': (el) => removeStageAt(+el.dataset.v),
  'route-link': (el) => {
    const c = current();
    const rt = Domain.routeOf(c), name = rt[+el.dataset.v], next = rt[+el.dataset.v + 1];
    const on = !Domain.isLinked(c, name);
    act('setLink', { stage: name, on }, on ? name + ' と ' + next + ' をつなぎました。' : name + ' と ' + next + ' を切りました。');
  },
  'route-add': () => {
    const c = current();
    const v = val('addStage');
    const rt = Domain.routeOf(c);
    if (rt.includes(v)) { toast('すでにその段階があります。'); return; }
    saveRoute(rt.concat(v), '', v + ' を追加しました。');
  },
  'route-custom': () => {
    const c = current();
    const v = val('newStage');
    if (!v) { toast('段階の名前を入れてください。'); return; }
    const rt = Domain.routeOf(c);
    if (rt.includes(v)) { toast('すでにその段階があります。'); return; }
    rememberStage(v);
    const el = field('newStage');
    if (el) el.value = '';
    saveRoute(rt.concat(v), '', v + ' を追加しました。');
  },

  'logo-set': async () => {
    const v = val('logoUrl');
    if (!v) { toast('画像のURLを入れてください。'); return; }
    if (!/^https?:\/\//i.test(v)) { toast('画像のURLは https:// から始めてください。'); return; }
    try {
      await setManualUrl(ui.openId, v);
      toast('ロゴを設定しました。', true);
    } catch (e) {
      toast('ロゴを保存できませんでした：' + e.message);
    }
  },
  'logo-get': async () => {
    toast('ロゴを探しています…', true);
    const url = await refetch(ui.openId);
    if (url == null) toast('今は混んでいて探せませんでした。1分ほど待ってから試してください。');
    else toast(url === 'none' ? 'ロゴが見つかりませんでした。' : 'ロゴを取り直しました。', url !== 'none');
  }
};

/* 段階を i 番目から to 番目へ動かす。≡をつかんで並べ替えたとき */
export function moveStage(from, to) {
  const rt = Domain.routeOf(current());
  if (from < 0 || from >= rt.length || to < 0 || to >= rt.length || from === to) return;
  const [s] = rt.splice(from, 1);
  rt.splice(to, 0, s);
  saveRoute(rt, '', s + ' を動かしました。');
}

/* 今の段階も消せる。そのときは、どこが現在地になるかを先に見せて確かめる。⊖ と左右のスワイプから */
function removeStageAt(i) {
  const c = current();
  const name = Domain.routeOf(c)[i];
  if (!name) return;
  const to = Domain.removalTarget(c, name);
  if (to && !window.confirm(name + 'を消して、現在地を' + to + 'にします。')) return;
  act('removeStage', { stage: name }, to ? name + ' を消して、' + to + ' を現在地にしました。' : name + ' を外しました。');
}

/* change で動くもの（チェックボックスとファイル選択） */
export const detailChanges = {
  chrome: (el) => {
    setOpenInChrome(el.checked);
    toast(el.checked ? 'マイページを Chrome で開きます。' : '標準のブラウザで開きます。', true);
    renderDetail();
  },
  allday: (el) => toggleAllDay(el.checked),
  'industry-pick': (el) => {
    if (el.value === IND_OWN) {
      const box = document.getElementById('indOwn');
      if (box) box.style.display = 'block';
      const input = field('indVal');
      if (input) input.focus();
      return;
    }
    act('setIndustry', { industry: el.value }, el.value ? '業種を「' + el.value + '」にしました。' : '業種を空にしました。');
  },
  'logo-file': (el) => {
    const f = el.files && el.files[0];
    el.value = '';
    fromFile(f, ui.openId).then(() => toast('ロゴを設定しました（この端末にだけ保存します）。', true), (e) => toast(e.message));
  }
};

/* 設定欄の開閉を覚える */
export function onToggle(e) {
  if (e.target && e.target.id === 'setwrap') setSetOpen(e.target.open);
}

