/*
 * 一覧画面。上から、管理用の帯、次の締切か予定の見出し、絞り込み、レーン。
 * 状態の判断は Domain.viewStatus に任せる（締切を過ぎた対応中は結果待ちに入る）。
 */
import { html, join, setHtml } from '../html.js';
import { ui, saveUi } from '../state.js';
import * as store from '../store.js';
import { logo } from '../logo.js';
import { rem, since, fdate, ftime, instant, evActive, evOngoing, evEndAt, evTile, evShort, byStart } from '../format.js';

/* レーンの並び。k は絞り込みのキー（端末に保存するので、旧版と同じ名前のまま） */
const LANES = [
  { k: 'event', lab: '予定', col: 'var(--text)' },
  { k: 'todo', lab: '対応中', col: 'var(--blue)' },
  { k: 'offer', lab: '内定', col: 'var(--go)' },
  { k: 'fixed', lab: '参加決定', col: 'var(--go)' },
  { k: 'wait', lab: '結果待ち', col: 'var(--wait)' },
  { k: 'end', lab: '終了', col: 'var(--dim)' },
  { k: 'skip', lab: '見送り', col: 'var(--dim)' }
];
const LANE_OF = { todo: 'todo', waiting: 'wait', offer: 'offer', joined: 'fixed', failed: 'end', skipped: 'skip' };

export function termCompanies() {
  return store.companies().filter((c) => (c.term || Domain.DEFAULT_TERM) === ui.term);
}

export function termEvents(list) {
  const ids = new Set((list || termCompanies()).map((c) => c.id));
  return store.events().filter((e) => ids.has(e.companyId)).sort(byStart);
}

function dayCell(n, color, unit) {
  if (n === 'TODAY') return html`<span class="today" style="color:${color}">TODAY</span>`;
  return html`<b style="color:${color}">${n}</b><s>${unit || 'DAYS'}</s>`;
}

function tag(text, color) {
  return html`<span class="tag" style="color:${color}">${text}</span>`;
}

function nextEvent(id, evs, now) {
  return evs.filter((e) => e.companyId === id && evActive(e, now))[0] || null;
}

export function rowHtml(c, evs, now) {
  const st = Domain.viewStatus(c, new Date(now));
  const r = c.dueAt ? rem(c.dueAt, now) : null;
  let left = '', right = '', sub = '';

  if (st === 'waiting') {
    const d = since(Domain.waitingSince(c), now);
    left = html`<b style="font-size:32px;color:${d >= 14 ? 'var(--hot)' : 'var(--wait)'}">${d == null ? '—' : d}</b><s>DAYS 経過</s>`;
    right = c.submittedAt ? fdate(c.submittedAt) + ' 提出' : '';
    if (Domain.isAutoSent(c, new Date(now))) sub = html`<div class="sub" style="color:var(--wait)">締切経過で自動送り</div>`;
  } else if (st === 'joined') {
    const ev = nextEvent(c.id, evs, now);
    const rr = ev ? rem(ev.startAt, now) : null;
    /* 日数の欄は狭いので、2行に折れない短い語にする */
    left = rr ? dayCell(rr.d === 0 ? 'TODAY' : rr.d, 'var(--go)') : tag(ev ? '開催中' : '参加', 'var(--go)');
    right = ev ? evShort(ev) : c.resultAt ? fdate(c.resultAt) + ' 確定' : '';
  } else if (st === 'offer') {
    left = tag('内定', 'var(--go)');
    right = c.resultAt ? fdate(c.resultAt) : '';
  } else if (st === 'failed') {
    left = tag('終了', 'var(--dim)');
    right = c.resultAt ? fdate(c.resultAt) : '';
  } else if (st === 'skipped') {
    left = tag('見送り', 'var(--dim)');
  } else if (r) {
    left = dayCell(r.d === 0 ? 'TODAY' : r.d, r.d <= 2 ? 'var(--hot)' : 'var(--text)');
    right = fdate(c.dueAt);
    if (c.dueHasTime) sub = html`<div class="sub">締切 ${ftime(c.dueAt)}</div>`;
  } else {
    left = tag('未定', 'var(--dim)');
  }

  const cls = ['row'];
  if (st === 'joined') cls.push('is-fixed');
  if (st === 'offer') cls.push('is-offer');
  if (st === 'todo' && r && r.d <= 2) cls.push('is-hot');
  if (st === 'failed' || st === 'skipped') cls.push('is-muted');
  /* タイルの中にはボタンを置かない。指には小さく、高さもそろわなくなる。操作は詳細にまとめる */
  return html`<div class="${cls.join(' ')}" data-act="open" data-id="${c.id}"><div class="main">${logo(c, 44)}<div class="body1"><div class="name" title="${c.name}">${Domain.shortName(c.name)}</div><div class="meta"><span class="stage">${Domain.position(c)}</span>${c.kind === 'mgmt' && html`<span class="stage mgmt">管理用</span>`}<i>${right}</i></div>${sub}</div><div class="day">${left}</div></div></div>`;
}

function eventRowHtml(ev, c, now) {
  const r = rem(ev.startAt, now);
  const left = r ? dayCell(r.d === 0 ? 'TODAY' : r.d, r.d <= 2 ? 'var(--hot)' : 'var(--text)')
    : evActive(ev, now) ? tag('開催中', 'var(--go)') : tag('終了', 'var(--dim)');
  return html`<div class="row" data-act="open" data-id="${c.id}"><div class="main">${logo(c, 44)}<div class="body1"><div class="name" title="${c.name}">${Domain.shortName(c.name)}</div><div class="meta"><span class="stage" style="color:var(--text)">${ev.kind}</span><i>${evTile(ev)}</i></div>${ev.place && html`<div class="sub" style="font-family:var(--body)">${ev.place}</div>`}</div><div class="day">${left}</div></div></div>`;
}

function stripHtml(mgmt, now) {
  if (!mgmt.length) return '';
  return html`<div class="strip">${mgmt.map((c) => {
    const r = c.dueAt ? rem(c.dueAt, now) : null;
    const lab = r ? (r.d === 0 ? '今日' : r.d + '日後') : c.dueAt ? '期限切れ' : '日程未定';
    return html`<button class="stripitem" data-act="open" data-id="${c.id}"><span class="k">受験予定</span><span class="n">${c.name}</span><span class="d" style="color:${r && r.d <= 2 ? 'var(--hot)' : 'var(--text)'}">${lab}</span>${c.dueAt && html`<span class="w">${fdate(c.dueAt)}${c.dueHasTime ? ' ' + ftime(c.dueAt) : ''}</span>`}</button>`;
  })}</div>`;
}

function heroHtml(hero, now) {
  const c = hero.c;
  const live = hero.kind === 'event' && evOngoing(hero.ev, now);
  const head = hero.kind === 'due' ? '次の締切' : (live ? '開催中の' : '次の') + hero.ev.kind;
  const stage = hero.kind === 'due' ? c.stage : hero.ev.kind;
  const showTime = !(hero.kind === 'due' && !c.dueHasTime) && !(hero.kind === 'event' && hero.ev.allDay);
  /* 開催中の予定は、終わるまで「開催中」と出す */
  const until = hero.kind === 'event' ? evEndAt(hero.ev) : '';
  return html`<div class="hero" data-act="open" data-id="${c.id}"><div class="lab" style="margin:0">${head}</div><div style="display:flex;align-items:center;gap:10px;margin-top:10px">${logo(c, 46)}<h1>${c.name}</h1></div><div style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:6px;letter-spacing:.06em">${stage} ${fdate(hero.at)}${showTime ? ' ' + ftime(hero.at) : ''}</div><div class="cd" id="heroCd" data-at="${hero.at}" data-until="${until}"></div></div>`;
}

export function renderList(onEmptyReset) {
  const view = document.getElementById('view');
  if (!view) return;
  const now = Date.now();
  const all = termCompanies();
  const mgmt = all.filter((c) => c.kind === 'mgmt');
  const list = all.filter((c) => c.kind !== 'mgmt');
  const evs = termEvents(all);
  const byId = new Map(all.map((c) => [c.id, c]));

  const groups = { event: [], todo: [], offer: [], fixed: [], wait: [], end: [], skip: [] };
  list.forEach((c) => groups[LANE_OF[Domain.viewStatus(c, new Date(now))]].push(c));
  const agenda = [];
  groups.todo.forEach((c) => { if (c.dueAt && rem(c.dueAt, now)) agenda.push({ kind: 'due', at: c.dueAt, c }); });
  evs.forEach((ev) => {
    const c = byId.get(ev.companyId);
    if (c && evActive(ev, now)) { agenda.push({ kind: 'event', at: ev.startAt, ev, c }); groups.event.push({ ev, c }); }
  });
  agenda.sort((a, b) => instant(a.at) - instant(b.at));
  groups.event.sort((a, b) => byStart(a.ev, b.ev));
  const far = 9e15;
  groups.todo.sort((a, b) => (instant(a.dueAt) || far) - (instant(b.dueAt) || far));
  groups.wait.sort((a, b) => Domain.waitingSince(a).localeCompare(Domain.waitingSince(b)));
  groups.offer.sort((a, b) => String(b.resultAt).localeCompare(String(a.resultAt)));
  groups.end.sort((a, b) => String(b.resultAt).localeCompare(String(a.resultAt)));

  const G = LANES.map((g) => Object.assign({ n: groups[g.k].length }, g)).filter((g) => g.n > 0);
  /* 保存していた絞り込みの行き先が空なら「すべて」に戻す（真っ白な一覧を出さない） */
  if (ui.filt !== 'all' && !G.some((g) => g.k === ui.filt)) { ui.filt = 'all'; saveUi(); }
  if (ui.filt === 'end') ui.endOpen = true;
  if (ui.filt === 'skip') ui.skipOpen = true;

  const rows = (k) => join(k === 'event' ? groups.event.map((a) => eventRowHtml(a.ev, a.c, now)) : groups[k].map((c) => rowHtml(c, evs, now)));
  const total = groups.event.length + groups.todo.length + groups.offer.length + groups.fixed.length + groups.wait.length;
  const hidden = (k) => ui.filt !== 'all' && ui.filt !== k;

  let top;
  if (agenda[0]) top = heroHtml(agenda[0], now);
  else if (!store.companies().length) {
    top = html`<div class="emptyNote">まだ会社が登録されていません。<br>下の＋から追加できます。<button class="gh" style="display:block;margin:14px auto 0" data-act="reset-cfg">接続設定をやり直す</button></div>`;
  } else top = html`<div style="color:var(--dim);font-size:14px;padding:20px 0">予定も締切もありません。</div>`;

  const lanes = G.map((g) => {
    if (g.k === 'end' || g.k === 'skip') {
      const open = g.k === 'end' ? ui.endOpen : ui.skipOpen;
      return html`<section class="lane${hidden(g.k) ? ' is-filt-hidden' : ''}" data-lane="${g.k}"><button class="lab accord-btn" data-act="toggle-lane" data-v="${g.k}">${g.lab} ${g.n}件 ${open ? '▾' : '▸'}</button>${open && html`<div class="rows">${rows(g.k)}</div>`}</section>`;
    }
    return html`<section class="lane${hidden(g.k) ? ' is-filt-hidden' : ''}" data-lane="${g.k}"><div class="lab" style="color:${g.col}">${g.lab}<span class="cnt">${g.n}</span></div><div class="rows">${rows(g.k)}</div></section>`;
  });

  setHtml(view, html`${stripHtml(mgmt, now)}${top}<div class="chips"><div class="chiprow"><button data-act="filt" data-v="all" class="${ui.filt === 'all' ? 'on' : ''}">すべて<b>${total}</b></button>${G.map((g) => html`<button data-act="filt" data-v="${g.k}" class="${ui.filt === g.k ? 'on' : ''}">${g.lab}<b style="color:${ui.filt === g.k ? '' : g.col}">${g.n}</b></button>`)}</div></div><div class="lanes${ui.filt === 'all' ? '' : ' single'}">${lanes}</div>`);
  view.querySelectorAll('.row, .pcard').forEach((el, i) => el.style.setProperty('--ei', Math.min(i, 12)));
  tickHero(onEmptyReset);
}

/**
 * 見出しのカウントダウンを1秒ごとに進める。
 * 締切を過ぎたら「期限切れ」と出して、少し置いてから一覧ごと組み直す（その会社は結果待ちへ移る）。
 * 開催中の予定は、終わる時刻を過ぎたら組み直す。
 */
export function tickHero(rerender) {
  const el = document.getElementById('heroCd');
  if (!el) return;
  const now = Date.now();
  const r = rem(el.dataset.at, now);
  if (!r) {
    const until = parseInt(el.dataset.until || '0', 10);
    if (until) {
      if (until > now) {
        if (el.dataset.rendered !== 'live') {
          el.dataset.rendered = 'live';
          setHtml(el, html`<b style="font-size:42px;color:var(--go)">開催中</b>`);
        }
        return;
      }
      el.dataset.until = '';
      if (rerender) rerender();
      return;
    }
    if (el.dataset.rendered !== 'expired') {
      el.dataset.rendered = 'expired';
      setHtml(el, html`<b style="font-size:42px;color:var(--dim)">期限切れ</b>`);
      if (rerender) setTimeout(rerender, 1200);
    }
    return;
  }
  const p = (v) => ('0' + v).slice(-2);
  el.style.color = r.ms < 172800000 ? 'var(--hot)' : 'var(--text)';
  const key = [r.d, r.h, r.m, r.s].join(':');
  if (el.dataset.rendered === key) return;
  el.dataset.rendered = key;
  setHtml(el, html`${r.d > 0 && html`<b>${r.d}</b><s>d</s>`}<b>${p(r.h)}</b><s>h</s><b>${p(r.m)}</b><s>m</s><b>${p(r.s)}</b><s>s</s>`);
}

/* 絞り込みを切り替える。描き直さずに、レーンの表示だけを変える */
export function applyFilter() {
  document.querySelectorAll('.chiprow button').forEach((b) => { b.className = b.dataset.v === ui.filt ? 'on' : ''; });
  const box = document.querySelector('.lanes');
  if (!box) return;
  box.classList.toggle('single', ui.filt !== 'all');
  box.querySelectorAll('.lane').forEach((l) => {
    l.classList.toggle('is-filt-hidden', ui.filt !== 'all' && l.dataset.lane !== ui.filt);
  });
  const vis = box.querySelectorAll('.lane:not(.is-filt-hidden) .row');
  box.classList.remove('filt-in');
  vis.forEach((r, i) => { r.style.animation = 'none'; r.style.setProperty('--fi', Math.min(i, 12)); });
  void box.offsetWidth;
  vis.forEach((r) => { r.style.animation = ''; });
  box.classList.add('filt-in');
}
