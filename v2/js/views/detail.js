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
import { logo, manualValue, setManualUrl, refetch, fromFile, forgetLogo } from '../logo.js';
import { toast, busy, copyText } from '../ui/notice.js';
import { showSheet, closeSheet, isSheetOpen } from '../ui/sheet.js';
import { dtField, dtValue, snapFields, restoreFields } from './fields.js';
import { rem, since, fdate, ftime, evActive, evOngoing, evWhen, evDays, spanText, byStart, gcalUrl } from '../format.js';

const LABEL = { todo: '対応中', waiting: '結果待ち', offer: '内定', joined: '参加決定', failed: '選考終了', skipped: '見送り' };
const INDUSTRY_HINTS = ['IT・SIer', 'メーカー', 'インフラ', '通信', '航空・運輸', '金融', '商社', '不動産・建設', 'コンサル',
  '人材・広告', '小売・サービス', '医薬・化学', '公共・その他'];

let rerenderAll = () => {};
export function onDetailRerender(fn) { rerenderAll = fn; }

function current() { return ui.openId ? store.company(ui.openId) : null; }
function eventsOf(id) { return store.eventsOf(id).sort(byStart); }

/* マイページを Chrome で開く URL に置き換える。iOS は googlechrome(s)://、Android は intent:// */
function extHref(url) {
  if (!ui.openInChrome || !url) return url;
  const ua = window.navigator.userAgent || '';
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

// ============================================================
// 描く
// ============================================================

function railHtml(c) {
  const rt = Domain.routeOf(c), cur = Domain.position(c), idx = rt.indexOf(cur), dead = c.status === 'failed';
  return html`<div class="rail">${rt.map((s, i) => {
    const passed = idx >= 0 && i < idx, here = idx === i;
    const col = dead ? 'var(--dim)' : here ? 'var(--text)' : passed ? 'var(--muted)' : 'var(--line)';
    const sz = here ? 8 : 5;
    return html`<div style="display:flex;align-items:center;${i === rt.length - 1 ? 'flex:0 0 auto' : 'flex:1'}"><i style="width:${sz}px;height:${sz}px;background:${col}${here && !dead ? ';box-shadow:0 0 0 4px rgba(255,255,255,.15)' : ''}"></i>${i < rt.length - 1 && html`<u style="background:${passed && !dead ? 'var(--muted)' : 'var(--line)'}"></u>`}</div>`;
  })}</div><div class="railtxt">${rt.map((s) => html`<span style="${s === cur ? 'color:var(--text)' : ''}">${s}</span>`)}</div>`;
}

const btn = (style, act, text, extra) => html`<button class="big" style="${style}" data-act="${act}"${extra || ''}>${text}</button>`;
const note = (text) => html`<div style="font-size:11px;color:var(--dim);margin-top:8px;line-height:1.7">${text}</div>`;

function infoTab(c, now) {
  const st = Domain.viewStatus(c, new Date(now));
  const rt = Domain.routeOf(c), idx = rt.indexOf(Domain.position(c));
  const parts = [];

  if (st === 'todo') {
    const r = c.dueAt ? rem(c.dueAt, now) : null;
    parts.push(html`<div style="margin-top:18px;padding-bottom:16px;border-bottom:1px solid var(--line-soft)"><div class="lab" style="margin:0 0 8px">締切まで</div>${r
      ? html`<div class="cd" style="margin-top:0;color:${r.ms < 172800000 ? 'var(--hot)' : 'var(--text)'}"><b style="font-size:50px">${r.d}</b><s>d</s><b style="font-size:50px">${('0' + r.h).slice(-2)}</b><s>h</s><b style="font-size:50px">${('0' + r.m).slice(-2)}</b><s>m</s></div><div class="sub">${fdate(c.dueAt)}${c.dueHasTime ? ' ' + ftime(c.dueAt) : ' 時刻未設定'}</div>`
      : html`<div style="font-size:13px;color:var(--dim);margin:8px 0 12px">締切が未設定です。</div>`}${dtField('coDue', c.dueAt, '23:59')}<button class="gh" style="margin-top:8px;color:var(--text)" data-act="set-due">締切を保存</button>${c.dueAt && html`<button class="gh" style="margin:8px 0 0 8px" data-act="clear-due">未定にする</button>`}</div>`);
  }
  if (st === 'waiting') {
    const d = since(Domain.waitingSince(c), now);
    const goal = Domain.goalOf(c.term) === 'joined' ? '参加決定' : '内定';
    parts.push(html`<div style="margin-top:18px;padding-bottom:18px;border-bottom:1px solid var(--line-soft)"><div class="lab" style="margin:0 0 8px">結果待ち</div><div class="cd" style="margin-top:0;color:var(--wait)"><b style="font-size:50px">${d == null ? '—' : d}</b><s>日経過</s></div>${Domain.isAutoSent(c, new Date(now)) && html`<div class="sub" style="color:var(--wait)">締切経過で自動送り</div>`}<div style="display:flex;gap:10px;margin-top:16px"><button class="big" style="flex:1;margin:0;background:var(--go);color:#00220E" data-act="pass">${Domain.isFinalStep(c) ? goal : '通過'}</button><button class="big" style="flex:1;margin:0;background:rgba(255,255,255,.1);color:var(--text);font-weight:500" data-act="fail">落選</button></div></div>`);
  }
  if (st === 'joined') {
    const ev = eventsOf(c.id).filter((e) => evActive(e, now))[0];
    const rr = ev ? rem(ev.startAt, now) : null;
    parts.push(html`<div style="margin-top:18px;padding-bottom:16px;border-bottom:1px solid var(--line-soft)"><div class="lab" style="margin:0 0 8px">実施日まで</div>${rr
      ? html`<div class="cd" style="margin-top:0;color:var(--go)"><b style="font-size:50px">${rr.d}</b><s>日</s></div><div class="sub">${evWhen(ev)}${evDays(ev) > 1 ? '（' + evDays(ev) + '日間）' : ''}</div>`
      : ev ? html`<div class="cd" style="margin-top:0;color:var(--go)"><b style="font-size:34px">開催中</b></div><div class="sub">${evWhen(ev)}</div>`
        : html`<div style="font-size:12px;color:var(--dim);line-height:1.8">実施日が未登録です。「予定」タブで、種別「インターン」として日時を入れてください。</div>`}</div>`);
  }

  /* 開いてすぐ使うものを上に。スクロールせずに届く位置に置く */
  if (c.url || c.folderUrl) {
    parts.push(html`<div style="display:flex;gap:8px;margin-top:14px">${c.url && html`<a class="big" style="flex:1;margin:0;background:#fff;color:#000" target="_blank" rel="noopener noreferrer" href="${safeUrl(extHref(c.url))}">マイページ</a>`}${c.folderUrl && html`<a class="big" style="flex:1;margin:0;background:rgba(255,255,255,.12);color:var(--text);font-weight:500" target="_blank" rel="noopener noreferrer" href="${safeUrl(c.folderUrl)}">書類フォルダ</a>`}</div>`);
  }
  if (c.loginId) parts.push(html`<button class="kv idrow" style="margin-top:12px" data-act="copy-id"><span>ログインID</span><span class="idval">${c.loginId}<i>コピー</i></span></button>`);
  /* パスワードは押したときだけ取りに行く。画面には伏せ字しか出さない */
  parts.push(html`<button class="kv idrow" data-act="copy-pw"><span>パスワード</span><span class="idval">••••••<i>コピー</i></span></button>`);
  if (c.resultAt && ['offer', 'joined', 'failed'].includes(st)) parts.push(html`<div class="kv"><span>結果日</span><span>${fdate(c.resultAt)}</span></div>`);

  /* よく押すものを先に */
  if (st === 'todo') parts.push(btn('background:var(--blue);color:#fff', 'done', '完了にして結果待ちへ'));
  /* 締切経過で自動送りになっている行は、保存上はまだ対応中なので出さない */
  if (c.status !== 'todo') parts.push(btn('background:rgba(255,255,255,.1);color:var(--text);font-weight:500', 'reopen', '対応中に戻す'));
  if (st === 'waiting') parts.push(btn('background:rgba(255,255,255,.1);color:var(--muted);font-weight:500', 'join', '参加決定にする'));

  /* ここから下は、たまにしか使わない操作 */
  if (idx > 0) parts.push(btn('background:transparent;border:1px solid var(--line);color:var(--muted);font-weight:500', 'prev', '1段階戻す（' + rt[idx] + ' → ' + rt[idx - 1] + '）'));
  if (st === 'todo' || st === 'waiting') parts.push(btn('background:transparent;border:1px solid var(--line);color:var(--dim);font-weight:500', 'skip', '見送りにする'));
  if (c.term !== '本選考' && c.kind !== 'mgmt') {
    const already = !!Domain.duplicateOf(store.companies(), c.name, '本選考');
    parts.push(already
      ? html`<button class="big" style="background:transparent;border:1px solid rgba(48,209,88,.4);color:var(--go);font-weight:500" disabled>本選考に登録済み</button>`
      : btn('background:transparent;border:1px solid rgba(48,209,88,.4);color:var(--go);font-weight:500', 'carry', '本選考に引き継ぐ'));
  }
  if (c.dueAt && st === 'todo') {
    parts.push(html`<a class="big" style="background:rgba(255,255,255,.1);color:var(--text);font-weight:500" target="_blank" rel="noopener noreferrer" href="${safeUrl(gcalUrl(c.name + ' ' + c.stage + ' 締切', c.dueAt, c.url, !c.dueHasTime))}">Googleカレンダーに追加</a>`);
  }
  parts.push(settingsHtml(c));
  return join(parts);
}

/* 登録し直すときだけ触る欄。普段は畳んでおく（開閉は端末に覚える） */
function settingsHtml(c) {
  const isCo = c.kind !== 'mgmt';
  const names = Domain.INDUSTRY_NAMES.concat(INDUSTRY_HINTS).filter((x, i, a) => a.indexOf(x) === i);
  const row = (id, value, act, label, placeholder) => html`<div style="display:flex;gap:8px"><input class="f" style="flex:1 1 0;min-width:0;margin:0" id="${id}" value="${value}" placeholder="${placeholder || ''}"${id === 'indVal' ? html` list="indList"` : ''}><button class="gh" style="padding:0 14px;color:var(--text)" data-act="${act}">${label}</button></div>`;
  return html`<details class="setwrap" id="setwrap"${ui.setOpen ? html` open` : ''}><summary>この会社の設定</summary>
<div style="margin-top:4px"><div class="lab" style="margin:0 0 8px">マイページの登録</div><input class="f" id="coUrl" placeholder="https://…（マイページのURL）" value="${c.url}"><input class="f" id="coId" placeholder="ログインID" value="${c.loginId}" style="margin-top:8px"><button class="gh" style="margin-top:8px" data-act="set-info">保存</button>
<div style="display:flex;gap:8px;margin-top:14px"><input class="f" style="flex:1 1 0;min-width:0;margin:0" id="coPw" type="password" autocomplete="new-password" placeholder="パスワード（変えるときだけ入力）"><button class="gh" style="padding:0 14px;color:var(--text)" data-act="set-pw">保存</button></div>
${note('パスワードはシートにだけ保存します。この端末と画面には残しません。')}
<label style="display:flex;align-items:center;gap:10px;margin-top:12px;cursor:pointer;font-size:13px"><input type="checkbox" id="chromeSw" data-change="chrome"${ui.openInChrome ? html` checked` : ''} style="width:20px;height:20px;accent-color:var(--blue)">マイページを Chrome で開く</label>${note('この端末だけの設定です。Chrome が入っていないと何も起きないので、その場合は外してください。')}</div>
${isCo && html`<div style="margin-top:22px"><div class="lab" style="margin:0 0 8px">業種</div>${row('indVal', c.industry, 'set-industry', '保存', '例：IT・SIer')}<datalist id="indList">${names.map((x) => html`<option value="${x}">`)}</datalist>${note('記録タブの集計に使います。空欄なら社名から推定します。')}</div>
<div style="margin-top:22px"><div class="lab" style="margin:0 0 8px">会社名</div>${row('renName', c.name, 'rename', '変更')}${note('予定とカレンダーの見出しも付け替えます。タイルでは「株式会社」を省いて出すので、正式名称で入れておけます。')}</div>
<div style="margin-top:22px"><div class="lab" style="margin:0 0 8px">同じマイページで別の選考を追加</div>${row('splitName', '', 'split', '追加', '例：' + Domain.shortName(c.name) + '（業務企画職）')}${note('マイページURL・ログインID・パスワード・ロゴ・業種を引き継いだ行を作ります。コース別に選考が分かれる会社を、別々に追えます。')}</div>`}
<div style="margin-top:22px"><div class="lab" style="margin:0 0 8px">ロゴ（URL を入れると自動では変わりません）</div>${row('logoUrl', manualValue(c), 'logo-set', '適用', '画像URLを貼って上書き')}<button class="gh" style="margin-top:8px" data-act="logo-get">自動で取り直す</button><div style="margin-top:10px"><label class="gh" style="display:inline-block;cursor:pointer;color:var(--text)">画像ファイルから選ぶ<input type="file" accept="image/*" style="display:none" data-change="logo-file"></label></div>${note('Wikidata の公式ロゴ、公式サイトのファビコン、Wikipedia の画像の順に探します。画像ファイルはこの端末にだけ保存します。')}</div>
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
  return html`<div style="margin-top:18px">${railHtml(c)}<div style="margin-top:14px">${rt.map((s, i) => html`<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--line-soft)"><span style="font-family:var(--mono);font-size:10px;color:var(--dim);width:16px">${i + 1}</span><button style="flex:1;text-align:left;background:none;border:none;font-size:14px;cursor:pointer;color:${cur === s ? 'var(--text)' : 'var(--muted)'};font-weight:${cur === s ? 600 : 400}" data-act="route-cur" data-v="${i}">${s}${cur === s && html` <span style="font-family:var(--mono);font-size:9px;color:var(--blue)">現在</span>`}</button><button class="gh" style="padding:4px 9px" data-act="route-up" data-v="${i}" aria-label="上へ">↑</button><button class="gh" style="padding:4px 9px" data-act="route-down" data-v="${i}" aria-label="下へ">↓</button><button class="gh" style="padding:4px 9px;color:var(--hot)" data-act="route-rm" data-v="${i}" aria-label="削除">×</button></div>`)}</div><div class="lab" style="margin:16px 0 8px">よくある段階から選ぶ</div><div style="display:flex;gap:8px"><select class="f" style="flex:1 1 0;min-width:0;margin:0" id="addStage">${stagePalette().map((p) => html`<option>${p}</option>`)}</select><button class="gh" style="padding:0 18px;color:var(--text)" data-act="route-add">追加</button></div><div class="lab" style="margin:16px 0 8px">自分で名前を付けて追加</div><div style="display:flex;gap:8px"><input class="f" style="flex:1 1 0;min-width:0;margin:0" id="newStage" placeholder="例：リクルーター面談" data-enter="route-custom"><button class="gh" style="padding:0 18px;color:var(--text)" data-act="route-custom">追加</button></div><div style="font-size:11px;color:var(--dim);margin-top:12px;line-height:1.8">段階名を押すと現在地になります。↑↓で並べ替え、×で削除。<br>自分で足した名前は、次から上の一覧にも出ます。</div></div>`;
}

function tabContent(c) {
  const now = Date.now();
  if (ui.tab === 'events') return eventsTab(c, now);
  if (ui.tab === 'route') return routeTab(c);
  return infoTab(c, now);
}

function fullHtml(c) {
  const st = Domain.viewStatus(c, new Date());
  const col = st === 'waiting' ? 'var(--wait)' : (st === 'offer' || st === 'joined') ? 'var(--go)' : 'var(--muted)';
  const tabs = [['info', '概要'], ['events', '予定 ' + store.eventsOf(c.id).length], ['route', '選考ルート']];
  return html`<div class="card-head"><div class="grab"></div><button class="sideclose" data-act="close-detail" aria-label="閉じる">✕</button><div style="display:flex;align-items:center;gap:12px">${logo(c, 56)}<div><div style="font-size:19px;font-weight:700;letter-spacing:-.01em">${c.name}</div><div style="font-family:var(--mono);font-size:11px;color:${col};margin-top:3px">${Domain.position(c)} ${LABEL[st]}</div></div></div><div class="tabs">${tabs.map(([k, lab]) => html`<button data-act="tab" data-v="${k}" class="${ui.tab === k ? 'on' : ''}">${lab}</button>`)}</div></div><div class="tab-pane">${tabContent(c)}</div>`;
}

export function sideEmpty() {
  const el = document.getElementById('side');
  if (!el) return;
  el.dataset.id = '';
  setHtml(el, html`<div id="sideEmpty"><div style="font-size:22px;font-weight:700;letter-spacing:.2em;color:rgba(255,255,255,.14)">就活</div><div>左の一覧から会社を選ぶと<br>ここに詳細が出ます。</div></div>`);
}

/* 同じ会社を描き直すときは、スクロール位置と書きかけの値を残す */
function paintInto(card, c) {
  const same = card.dataset.id === c.id;
  const pane = card.querySelector('.tab-pane');
  const y = pane ? pane.scrollTop : 0;
  const snap = same ? snapFields(card) : null;
  setHtml(card, fullHtml(c));
  card.dataset.id = c.id;
  const np = card.querySelector('.tab-pane');
  if (np && same) { np.style.animation = 'none'; np.scrollTop = y; }
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

export function openDetail(id) {
  ui.openId = id;
  ui.tab = 'info';
  renderDetail();
}

export function closeDetail() {
  if (isWide()) { ui.openId = null; sideEmpty(); rerenderAll(); } else closeSheet();
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
      pane.scrollTop = 0;
      pane.style.animation = 'none'; void pane.offsetWidth; pane.style.animation = '';
    }
  },

  done: () => act('done', {}, '結果待ちに移しました。'),
  pass: () => {
    const c = current();
    const final = c && Domain.isFinalStep(c);
    const goal = c && Domain.goalOf(c.term) === 'joined' ? '参加決定' : '内定';
    act('pass', {}, final ? goal + 'として記録しました。' : '通過を記録しました。');
  },
  fail: () => {
    const c = current();
    if (c && window.confirm(c.name + ' を選考終了にします。締切と、これから先の予定がカレンダーから消えます。')) act('fail', {}, '選考終了として記録しました。');
  },
  reopen: () => act('reopen', {}, '対応中に戻しました。'),
  join: () => act('join', {}, '参加決定にしました。'),
  skip: () => {
    const c = current();
    if (c && window.confirm(c.name + ' を見送りにします。締切と、これから先の予定がカレンダーから消えます。')) act('skip', {}, '見送りにしました。');
  },
  prev: () => {
    const c = current();
    const rt = Domain.routeOf(c), i = rt.indexOf(Domain.position(c));
    act('prev', {}, i > 0 ? rt[i - 1] + ' に戻しました。' : '');
  },
  'set-due': () => {
    const v = dtValue('coDue', root());
    if (!v) { toast('日付を入れてください。'); return; }
    act('setDue', { dueAt: v, hasTime: true }, '締切を保存しました。');
  },
  'clear-due': () => act('setDue', { dueAt: '' }, '締切を未定にしました。'),
  'set-info': () => act('setInfo', { url: val('coUrl'), loginId: val('coId') }, 'マイページを保存しました。'),
  'set-industry': () => {
    const v = val('indVal');
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
    copyText(call('getPassword', { id }).then((r) => {
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
    rerenderAll();
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
    rerenderAll();
  },
  'delete-company': async () => {
    const c = current();
    const n = store.eventsOf(c.id).length;
    if (!window.confirm(c.name + '（' + c.term + '）を削除します。\n選考の記録' + (n ? 'と予定' + n + '件' : '') + 'が消え、元には戻せません。')) return;
    if (!window.confirm('本当に削除しますか。\n' + c.name + ' の行を削除します。')) return;
    const r = await runBusy('deleteCompany', { id: c.id }, c.name + ' を削除しました。');
    if (!r) return;
    forgetLogo(c.id);
    closeDetail();
    rerenderAll();
  },

  'add-event': () => addEvent(),
  'delete-event': async (el) => {
    if (!window.confirm('この予定を削除します。カレンダーからも消えます。')) return;
    const r = await runBusy('deleteEvent', { id: el.dataset.v }, '予定を削除しました。');
    if (r) renderDetail();
  },

  'route-cur': (el) => {
    const c = current();
    const rt = Domain.routeOf(c), s = rt[+el.dataset.v];
    if (Domain.position(c) === s) return;
    saveRoute(rt, s, s + ' を現在地にしました。');
  },
  'route-up': (el) => move(+el.dataset.v, -1),
  'route-down': (el) => move(+el.dataset.v, 1),
  'route-rm': (el) => {
    const c = current();
    const rt = Domain.routeOf(c), i = +el.dataset.v;
    if (rt.length <= 2) { toast('段階は2つ以上必要です。'); return; }
    if (rt[i] === Domain.position(c)) { toast('今の段階は外せません。'); return; }
    const name = rt[i];
    rt.splice(i, 1);
    saveRoute(rt, '', name + ' を外しました。');
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
    toast(url === 'none' ? 'ロゴが見つかりませんでした。' : 'ロゴを取り直しました。', url !== 'none');
  }
};

function move(i, d) {
  const rt = Domain.routeOf(current());
  const j = i + d;
  if (j < 0 || j >= rt.length) return;
  [rt[i], rt[j]] = [rt[j], rt[i]];
  saveRoute(rt, '');
}

/* change で動くもの（チェックボックスとファイル選択） */
export const detailChanges = {
  chrome: (el) => {
    setOpenInChrome(el.checked);
    toast(el.checked ? 'マイページを Chrome で開きます。' : '標準のブラウザで開きます。', true);
    renderDetail();
  },
  allday: (el) => toggleAllDay(el.checked),
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

