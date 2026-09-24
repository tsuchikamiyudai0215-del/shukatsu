/*
 * カレンダーを「あるべき予定」に合わせる。
 *
 * 書き込みのたびに Domain.desiredCalendar であるべき予定を出し、会社の cal 列にある
 * 対応表（キー → { id, sig }）と照らして、作る・直す・消すを行う。
 * 見送り・落選・削除・改名のどれでもこの手順だけで済むので、個別の後片付けは書かない。
 */

/* ID から予定を開く。ほかのカレンダーの予定だったら触らない（本番の予定を守るため） */
function ownEvent_(cal, id) {
  var ev = null;
  try { ev = cal.getEventById(id); } catch (e) { return null; }
  if (!ev) return null;
  if (ev.getOriginalCalendarId() !== calendarId_()) {
    console.warn('別のカレンダーの予定なので触りません：' + id);
    return null;
  }
  return ev;
}

function setReminders_(ev, minutes) {
  ev.removeAllReminders();
  minutes.forEach(function (m) { ev.addPopupReminder(m); });
}

function createCalEvent_(cal, item) {
  var opt = { description: item.description || '' };
  var ev = item.allDay
    ? cal.createAllDayEvent(item.title, wallToDate_(item.start), wallToDate_(item.end), opt)
    : cal.createEvent(item.title, wallToDate_(item.start), wallToDate_(item.end), opt);
  setReminders_(ev, item.reminders);
  return ev;
}

/* 中身を書き換える。終日と時刻ありを行き来するときは、作り直した方が確実なので false を返す */
function updateCalEvent_(ev, item) {
  if (ev.isAllDayEvent() !== !!item.allDay) return false;
  ev.setTitle(item.title);
  ev.setDescription(item.description || '');
  if (item.allDay) ev.setAllDayDates(wallToDate_(item.start), wallToDate_(item.end));
  else ev.setTime(wallToDate_(item.start), wallToDate_(item.end));
  setReminders_(ev, item.reminders);
  return true;
}

/**
 * 1社分のカレンダーを合わせ、新しい対応表を返す。
 * 途中で失敗したものは、次に保存したときにもう一度試せるよう、元の対応を残す。
 * 戻り値：{ cal: 新しい対応表, failed: 失敗した数 }
 */
function syncCalendar_(company, events, now) {
  var current = company.cal || {};
  var desired = Domain.desiredCalendar(company, events, now);
  var diff = Domain.calendarDiff(desired, current);
  var cal = calendar_();
  var next = {};
  var failed = 0;

  diff.keep.forEach(function (k) { next[k.key] = current[k.key]; });

  diff.update.forEach(function (u) {
    try {
      var ev = ownEvent_(cal, u.id);
      if (ev && updateCalEvent_(ev, u.item)) {
        next[u.key] = { id: u.id, sig: Domain.calendarSig(u.item) };
        return;
      }
      if (ev) ev.deleteEvent();
      /* 手で消されていた予定は作り直す */
      next[u.key] = { id: createCalEvent_(cal, u.item).getId(), sig: Domain.calendarSig(u.item) };
    } catch (e) {
      console.warn('予定を直せませんでした（' + u.key + '）：' + e);
      next[u.key] = current[u.key];
      failed++;
    }
  });

  diff.create.forEach(function (item) {
    try {
      next[item.key] = { id: createCalEvent_(cal, item).getId(), sig: Domain.calendarSig(item) };
    } catch (e) {
      console.warn('予定を作れませんでした（' + item.key + '）：' + e);
      failed++;
    }
  });

  diff.remove.forEach(function (r) {
    try {
      var ev = ownEvent_(cal, r.id);
      if (ev) ev.deleteEvent();
    } catch (e) {
      console.warn('予定を消せませんでした（' + r.key + '）：' + e);
      next[r.key] = current[r.key];
      failed++;
    }
  });

  return { cal: next, failed: failed };
}

/* 会社を消すときに、その会社の予定を全部消す */
function removeAllCalendar_(company) {
  var cal = calendar_();
  var failed = 0;
  Object.keys(company.cal || {}).forEach(function (k) {
    var cur = company.cal[k];
    var id = cur && typeof cur === 'object' ? cur.id : cur;
    if (!id) return;
    try {
      var ev = ownEvent_(cal, id);
      if (ev) ev.deleteEvent();
    } catch (e) {
      console.warn('予定を消せませんでした（' + k + '）：' + e);
      failed++;
    }
  });
  return failed;
}

/* 対応表が同じか。キーの並び順の違いは同じとみなす（並びが違うだけで書き直さないように） */
function sameCal_(a, b) {
  var ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.join('\n') !== kb.join('\n')) return false;
  return ka.every(function (k) { return JSON.stringify(a[k]) === JSON.stringify(b[k]); });
}

/**
 * 何も書き換えずに、各社のカレンダーの見込みを実行ログに出す。予定が作られないときの調べ物用。
 * 締切の値は、見えない文字も分かるよう JSON の形で出す。パスワードは出さない。
 */
function inspectCalendar() {
  resetRun_();
  var now = new Date();
  var allEvents = events_().all();
  var cal = calendar_();
  companies_().all().forEach(function (c) {
    if (c.status !== 'todo' && !c.dueAt) return;
    var evs = allEvents.filter(function (e) { return e.companyId === c.id; });
    var desired = Domain.desiredCalendar(c, evs, now);
    console.log([
      c.name, 'status=' + JSON.stringify(c.status), 'dueAt=' + JSON.stringify(c.dueAt),
      '読めるか=' + (Domain.parseWall(c.dueAt) != null), 'あるべき=' + desired.map(function (d) { return d.key; }).join(','),
      '対応表=' + Object.keys(c.cal || {}).join(',')
    ].join(' / '));
  });
  var list = cal.getEvents(new Date(2020, 0, 1), new Date(2035, 0, 1));
  console.log('開発用カレンダーの予定：' + list.length + ' 件');
  list.forEach(function (e) { console.log('  ' + e.getTitle()); });
}

/**
 * 全社のカレンダーをまとめて合わせる。移行のあとにエディタから実行する。
 * 時間切れ（6分）にならないよう、4分半で止める。もう合っている会社はカレンダーに問い合わせないので、
 * 止まったらもう一度実行すれば続きから進む。
 */
function syncAllCalendars() {
  resetRun_();
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    var started = Date.now();
    var now = new Date();
    var table = companies_();
    var allEvents = events_().all();
    var done = 0, changed = 0, failed = 0, left = 0;
    table.all().forEach(function (c) {
      if (Date.now() - started > 270000) { left++; return; }
      var evs = allEvents.filter(function (e) { return e.companyId === c.id; });
      var res = syncCalendar_(c, evs, now);
      failed += res.failed;
      done++;
      if (!sameCal_(res.cal, c.cal || {})) {
        c.cal = res.cal;
        table.write(c);
        changed++;
      }
    });
    bustCache_();
    var msg = done + ' 社を確かめ、' + changed + ' 社の予定を直しました。' +
      (failed ? '失敗 ' + failed + ' 件。' : '') +
      (left ? 'まだ ' + left + ' 社残っています。もう一度実行してください。' : 'すべて終わりました。');
    console.log(msg);
    return { done: done, changed: changed, failed: failed, left: left };
  } finally {
    lock.releaseLock();
  }
}
