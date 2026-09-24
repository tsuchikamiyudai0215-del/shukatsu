/**
 * 就活ボード バックエンド（区分対応・外部配信版）
 *
 * ・doGet / doPost は WebAppApi.gs 側にあるので、このファイルには置かない
 * ・スプレッドシートは ID で直接開く（ウェブアプリ経由では
 *   getActiveSpreadsheet() が使えないため）
 * ・api* は WebAppApi.gs の waRoute_ がロックを取った内側で呼ばれる。
 *   ここでは個別にロックを取らない（二重に取ると内側の解放で外側まで外れる）
 */

/* このスプレッドシートのID（URLの /d/ と /edit の間） */
const WA_SS_ID = '1v-nnIz3VQE2ksGTTc6YgQ6pHJapJVKusuaVpjreQE2A';
const WA_SHEET = 'Sheet1';
const WA_EVENTS = '予定';
const WA_DEFAULT_TERM = '夏インターン';
const WA_DEFAULT_ROUTE = ['エントリー', 'ES', '適性検査', 'GD', '面接', '最終面接', '内定'];
const WA_EVENT_HEAD = ['会社名', '種別', '日時', '場所', 'eventId', 'uid', '区分', '終了', '終日', '毎日'];

// 固定列（既存 Code.gs と同じ並び）
const COL = {
  company: 1, url: 2, id: 3, pw: 4,
  date: 5, hour: 6, minute: 7,
  stage: 8, oldStatus: 9, registered: 10, eventId: 11,
  failDate: 12, failStage: 13,
  resultDate: 14, resultEventId: 15, folder: 16
};

// ============================================================
// 共通ヘルパー
// ============================================================

/* 1回の実行の中では、同じシートを何度も開き直さない */
let _waSS = null, _waEvSheet = null;

function waSS_() {
  return _waSS || (_waSS = SpreadsheetApp.openById(WA_SS_ID));
}

function waSheet_() {
  return waSS_().getSheetByName(WA_SHEET);
}

function waEventSheet_() {
  if (_waEvSheet) return _waEvSheet;
  const ss = waSS_();
  const sh = ss.getSheetByName(WA_EVENTS) || ss.insertSheet(WA_EVENTS);
  /* 見出しは欠けている所だけ埋め、1回の書き込みで済ませる */
  const head = sh.getRange(1, 1, 1, WA_EVENT_HEAD.length).getValues()[0];
  let changed = false;
  for (let i = 0; i < WA_EVENT_HEAD.length; i++) {
    if (!head[i]) { head[i] = WA_EVENT_HEAD[i]; changed = true; }
  }
  if (changed) sh.getRange(1, 1, 1, WA_EVENT_HEAD.length).setValues([head]);
  return (_waEvSheet = sh);
}

function waCols_(sheet) {
  const head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  head.forEach(function (h, i) {
    const k = String(h).trim();
    if (k) map[k] = i + 1;
  });
  return map;
}

/* 書き込みだけの処理は、全データを返さず「済んだ」とだけ返す */
function waLight_() {
  return JSON.stringify({ ok: true, light: true });
}

function waTerm_(v) {
  const s = String(v == null ? '' : v).trim();
  return s || WA_DEFAULT_TERM;
}

/** 会社名＋区分から行番号を引く */
function waFindRow_(sheet, company, term, cols) {
  const c = cols || waCols_(sheet);
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const names = sheet.getRange(2, COL.company, last - 1, 1).getValues();
  const terms = c['区分']
    ? sheet.getRange(2, c['区分'], last - 1, 1).getValues()
    : null;
  const want = waTerm_(term);
  const name = String(company).trim();
  for (let i = 0; i < names.length; i++) {
    if (String(names[i][0]).trim() !== name) continue;
    if (waTerm_(terms ? terms[i][0] : '') === want) return i + 2;
  }
  return -1;
}

/** その行の選考ルート。ルート列が空なら既定のルート */
function waRouteOf_(sheet, row, c) {
  const raw = c['ルート'] ? String(sheet.getRange(row, c['ルート']).getValue()).trim() : '';
  return raw ? raw.split('>').map(function (s) { return s.trim(); }) : WA_DEFAULT_ROUTE;
}

function waToday_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd');
}

function waIso_(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v).replace(/-/g, '/'));
  if (isNaN(d.getTime())) return null;
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
}

function waIsoTime_(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v).replace(/-/g, '/'));
  if (isNaN(d.getTime())) return null;
  return Utilities.formatDate(d, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm");
}

// ============================================================
// 読み取り
// ============================================================

function apiGetData() {
  const sheet = waSheet_();
  const c = waCols_(sheet);
  const last = sheet.getLastRow();
  const items = [];

  if (last >= 2) {
    /* 見出しのある列までで足りる。22列固定だと列の少ないシートで範囲外エラーになる */
    const width = Math.max(sheet.getLastColumn(), COL.folder);
    const rows = sheet.getRange(2, 1, last - 1, width).getValues();
    /* P列は =HYPERLINK("url","📁 …") なので、値ではなく数式から取り出す */
    const folderF = sheet.getRange(2, COL.folder, last - 1, 1).getFormulas();

    rows.forEach(function (r, idx) {
      const company = String(r[COL.company - 1]).trim();
      if (!company) return;

      let folder = '';
      const fx = folderF[idx] ? String(folderF[idx][0] || '') : '';
      const fm = fx.match(/HYPERLINK\(\s*"([^"]+)"/i);
      if (fm) folder = fm[1];

      let due = null, timeUnset = true;
      const base = waIso_(r[COL.date - 1]);
      if (base) {
        const hour = r[COL.hour - 1], minute = r[COL.minute - 1];
        if (hour !== '' && hour !== null) {
          const hh = ('0' + parseInt(hour, 10)).slice(-2);
          const mm = ('0' + (minute === '' || minute === null ? 0 : parseInt(minute, 10))).slice(-2);
          due = base + 'T' + hh + ':' + mm;
          timeUnset = false;
        } else {
          due = base + 'T23:59';
        }
      }

      const routeRaw = c['ルート'] ? String(r[c['ルート'] - 1]).trim() : '';

      items.push({
        c: company,
        term: waTerm_(c['区分'] ? r[c['区分'] - 1] : ''),
        url: String(r[COL.url - 1] || ''),
        id: String(r[COL.id - 1] || ''),
        dom: c['ドメイン'] ? String(r[c['ドメイン'] - 1] || '') : '',
        folder: folder,
        ind: c['業種'] ? String(r[c['業種'] - 1] || '') : '',
        stage: String(r[COL.stage - 1] || ''),
        status: c['状態'] ? String(r[c['状態'] - 1] || '') : '',
        due: due,
        timeUnset: timeUnset,
        since: c['提出日'] ? waIso_(r[c['提出日'] - 1]) : null,
        on: waIso_(r[COL.failDate - 1]),
        lost: String(r[COL.failStage - 1] || ''),
        route: routeRaw ? routeRaw.split('>').map(function (s) { return s.trim(); }) : null
      });
    });
  }

  const es = waEventSheet_();
  const eLast = es.getLastRow();
  const events = [];
  if (eLast >= 2) {
    es.getRange(2, 1, eLast - 1, 10).getValues().forEach(function (r) {
      if (!r[0]) return;
      events.push({
        c: String(r[0]).trim(),
        kind: String(r[1] || '予定'),
        at: waIsoTime_(r[2]),
        place: String(r[3] || ''),
        uid: String(r[5] || ''),
        term: waTerm_(r[6]),
        end: waIsoTime_(r[7]),
        allDay: String(r[8]).toUpperCase() === 'TRUE',
        daily: String(r[9]).toUpperCase() === 'TRUE'
      });
    });
  }

  const logos = JSON.parse(PropertiesService.getUserProperties().getProperty('wa_logos') || '{}');
  return JSON.stringify({ items: items, events: events, route: WA_DEFAULT_ROUTE, logos: logos });
}

// ============================================================
// 書き戻し
// ============================================================

function apiMarkDone(company, term) {
  const sheet = waSheet_();
  const c = waCols_(sheet);
  const row = waFindRow_(sheet, company, term, c);
  if (row < 0) return waLight_();

  if (c['状態']) sheet.getRange(row, c['状態']).setValue('結果待ち');
  if (c['提出日']) sheet.getRange(row, c['提出日']).setValue(waToday_());
  sheet.getRange(row, COL.oldStatus).setValue('済');
  autoSort(sheet);
  return waLight_();
}

function apiMarkFail(company, term) {
  const sheet = waSheet_();
  const c = waCols_(sheet);
  const row = waFindRow_(sheet, company, term, c);
  if (row < 0) return apiGetData();

  sheet.getRange(row, COL.oldStatus).setValue('選考落ち');
  SpreadsheetApp.flush();
  updateCalendarData(sheet, row, COL.oldStatus);
  if (c['状態']) sheet.getRange(row, c['状態']).setValue('落選');
  autoSort(sheet);
  return apiGetData();
}

function apiMarkPass(company, term) {
  const sheet = waSheet_();
  const c = waCols_(sheet);
  const row = waFindRow_(sheet, company, term, c);
  if (row < 0) return apiGetData();

  const route = waRouteOf_(sheet, row, c);
  const stage = String(sheet.getRange(row, COL.stage).getValue()).trim();
  const i = route.indexOf(stage);

  const eventId = sheet.getRange(row, COL.eventId).getValue();
  if (eventId) deleteEventById(CalendarApp.getDefaultCalendar(), eventId);
  sheet.getRange(row, COL.date, 1, 3).clearContent();
  sheet.getRange(row, COL.registered).setValue('');
  sheet.getRange(row, COL.eventId).setValue('');
  if (c['提出日']) sheet.getRange(row, c['提出日']).setValue('');

  if (i < 0 || i >= route.length - 2) {
    /* 画面側と同じ結果にそろえる。
       夏インターンは「参加決定」、段階はルートの最後、結果日は今日 */
    const goal = waTerm_(term) === WA_DEFAULT_TERM ? '参加決定' : '内定';
    if (i >= 0) sheet.getRange(row, COL.stage).setValue(route[route.length - 1]);
    if (c['状態']) sheet.getRange(row, c['状態']).setValue(goal);
    sheet.getRange(row, COL.oldStatus).setValue('内定');
    sheet.getRange(row, COL.failDate).setValue(waToday_());
    sheet.getRange(row, COL.failStage).setValue('');
  } else {
    sheet.getRange(row, COL.stage).setValue(route[i + 1]);
    if (c['状態']) sheet.getRange(row, c['状態']).setValue('対応中');
    sheet.getRange(row, COL.oldStatus).setValue('未');
  }
  autoSort(sheet);
  return apiGetData();
}

function apiSetStatus(company, term, status) {
  const sheet = waSheet_();
  const c = waCols_(sheet);
  const row = waFindRow_(sheet, company, term, c);
  if (row < 0 || !c['状態']) return waLight_();

  sheet.getRange(row, c['状態']).setValue(status);

  if (status === '対応中') {
    sheet.getRange(row, COL.oldStatus).setValue('未');
    /* 落選から戻したときに、落ちた段階と結果日が残らないようにする */
    sheet.getRange(row, COL.failDate).setValue('');
    sheet.getRange(row, COL.failStage).setValue('');
    const reg = String(sheet.getRange(row, COL.registered).getValue());
    if (reg === '選考落ち' || reg === '日程削除済') sheet.getRange(row, COL.registered).setValue('');
  }

  if (status === '見送り') {
    /* シートで「日程削除」を選んだときと同じ後片付けをする。
       スクリプトからの書き込みでは編集トリガーが動かないので、ここで呼ぶ */
    sheet.getRange(row, COL.oldStatus).setValue('日程削除');
    SpreadsheetApp.flush();
    updateCalendarData(sheet, row, COL.oldStatus);
  }

  if (status === '結果待ち') {
    sheet.getRange(row, COL.oldStatus).setValue('済');
    if (c['提出日'] && !sheet.getRange(row, c['提出日']).getValue()) {
      sheet.getRange(row, c['提出日']).setValue(waToday_());
    }
    sheet.getRange(row, COL.failDate).setValue('');
    sheet.getRange(row, COL.failStage).setValue('');
  }
  autoSort(sheet);
  return waLight_();
}

function apiSetRoute(company, term, routeArr, stage) {
  const sheet = waSheet_();
  const c = waCols_(sheet);
  const row = waFindRow_(sheet, company, term, c);
  if (row < 0) return waLight_();

  if (c['ルート']) sheet.getRange(row, c['ルート']).setValue(routeArr.join('>'));
  if (stage) sheet.getRange(row, COL.stage).setValue(stage);
  return waLight_();
}

/** 夏インターンの行を本選考へ引き継ぐ（会社情報だけ複製） */
function apiCarryOver(company, term) {
  const sheet = waSheet_();
  const c = waCols_(sheet);
  const src = waFindRow_(sheet, company, term, c);
  if (src < 0) return apiGetData();
  if (waFindRow_(sheet, company, '本選考', c) > 0) return apiGetData(); // 既にある

  /* 元の行はまとめて1回で読む */
  const s = sheet.getRange(src, 1, 1, COL.pw).getValues()[0];
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, COL.pw).setValues([s]);
  sheet.getRange(row, COL.stage).setValue('エントリー');
  sheet.getRange(row, COL.oldStatus).setValue('未');
  if (c['状態']) sheet.getRange(row, c['状態']).setValue('対応中');
  if (c['区分']) sheet.getRange(row, c['区分']).setValue('本選考');
  if (c['ドメイン']) sheet.getRange(row, c['ドメイン']).setValue(sheet.getRange(src, c['ドメイン']).getValue());

  SpreadsheetApp.flush();
  const f = sheet.getRange(src, COL.folder).getFormula();
  if (f) sheet.getRange(row, COL.folder).setFormula(f).setHorizontalAlignment('center');
  autoSort(sheet);
  return apiGetData();
}

function apiAddEvent(company, term, kind, at, place, endAt, allDay, daily) {
  const es = waEventSheet_();
  const uid = Utilities.getUuid().slice(0, 8);
  const start = new Date(String(at).replace(/-/g, '/').replace('T', ' '));
  if (isNaN(start.getTime())) return apiGetData();

  let end = null;
  if (endAt) {
    const d = new Date(String(endAt).replace(/-/g, '/').replace('T', ' '));
    if (!isNaN(d.getTime()) && d > start) end = d;
  }
  const isAll = (allDay === true || String(allDay).toUpperCase() === 'TRUE');
  const isDaily = !isAll && (daily === true || String(daily).toUpperCase() === 'TRUE') && !!end;

  let eventId = '';
  try {
    const sheet = waSheet_();
    const row = waFindRow_(sheet, company, term);
    const url = row > 0 ? sheet.getRange(row, COL.url).getValue() : '';
    const cal = CalendarApp.getDefaultCalendar();
    const title = '【' + kind + '】' + company;
    const opt = { description: [place, url ? 'マイページ: ' + url : ''].filter(String).join('\n') };

    let ev = null;
    if (isAll) {
      /* 終日。終了日は翌日を指定する決まりなので +1 日する */
      const sd = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const ed = end ? new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1)
                     : new Date(sd.getFullYear(), sd.getMonth(), sd.getDate() + 1);
      ev = cal.createAllDayEvent(title, sd, ed, opt);
    } else if (isDaily) {
      /* 日ごとに独立した予定として作る */
      const d0 = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const dN = new Date(end.getFullYear(), end.getMonth(), end.getDate());
      const span = Math.max(0, Math.round((dN - d0) / 86400000));
      const ids = [];
      for (let i = 0; i <= span && i < 60; i++) {
        const s1 = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i,
                            start.getHours(), start.getMinutes());
        const e1 = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i,
                            end.getHours(), end.getMinutes());
        const label = span > 0 ? title + '（' + (i + 1) + '/' + (span + 1) + '日目）' : title;
        const one = cal.createEvent(label, s1,
                      e1 > s1 ? e1 : new Date(s1.getTime() + 60 * 60000), opt);
        one.removeAllReminders();
        one.addPopupReminder(60);
        if (i === 0) one.addPopupReminder(1440);
        ids.push(one.getId());
      }
      eventId = ids.join(',');
    } else {
      ev = cal.createEvent(title, start, end || new Date(start.getTime() + 60 * 60000), opt);
    }
    if (ev) {
      ev.removeAllReminders();
      ev.addPopupReminder(1440);
      if (!isAll) ev.addPopupReminder(60);
      eventId = ev.getId();
    }
  } catch (err) {
    console.warn('予定のカレンダー作成失敗: ' + err);
  }

  es.appendRow([company, kind, start, place || '', eventId, uid, waTerm_(term),
                end || '', isAll ? 'TRUE' : '', isDaily ? 'TRUE' : '']);
  const r = es.getLastRow();
  const fmt = isAll ? 'yyyy/MM/dd(ddd)' : 'yyyy/MM/dd(ddd) HH:mm';
  es.getRange(r, 3).setNumberFormat(fmt);
  if (end) es.getRange(r, 8).setNumberFormat(fmt);
  return apiGetData();
}

/* 単発・繰り返しのどちらでも消せるようにする */
function waDeleteCalendar_(id) {
  if (!id) return;
  const cal = CalendarApp.getDefaultCalendar();
  try {
    const ev = cal.getEventById(id);
    if (ev) { ev.deleteEvent(); return; }
  } catch (e) {}
  try {
    const se = cal.getEventSeriesById(id);
    if (se) se.deleteEventSeries();
  } catch (e) {}
}

/* カンマ区切りで複数のIDを持つ「連日」の予定もまとめて消す */
function waDeleteCalendarIds_(ids) {
  String(ids || '').split(',').forEach(function (one) {
    one = one.trim();
    if (one) waDeleteCalendar_(one);
  });
}

function apiDeleteEvent(uid) {
  const es = waEventSheet_();
  const last = es.getLastRow();
  if (last < 2) return apiGetData();

  const rows = es.getRange(2, 1, last - 1, 10).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][5]) === String(uid)) {
      waDeleteCalendarIds_(rows[i][4]);
      es.deleteRow(i + 2);
      break;
    }
  }
  return apiGetData();
}

function apiAddCompany(obj) {
  const sheet = waSheet_();
  const c = waCols_(sheet);
  /* 画面側でも弾いているが、二重送信に備えてこちらでも確かめる */
  if (waFindRow_(sheet, obj.c, obj.term, c) > 0) return apiGetData();

  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, COL.company).setValue(obj.c);
  if (obj.url) sheet.getRange(row, COL.url).setValue(obj.url);
  if (obj.id) sheet.getRange(row, COL.id).setValue(obj.id);
  sheet.getRange(row, COL.stage).setValue(obj.stage || 'エントリー');
  sheet.getRange(row, COL.oldStatus).setValue('未');
  if (c['状態']) sheet.getRange(row, c['状態']).setValue('対応中');
  if (c['区分']) sheet.getRange(row, c['区分']).setValue(waTerm_(obj.term));
  if (c['ドメイン'] && obj.dom) sheet.getRange(row, c['ドメイン']).setValue(obj.dom);

  if (obj.due) {
    const d = new Date(String(obj.due).replace(/-/g, '/').replace('T', ' '));
    if (!isNaN(d.getTime())) {
      sheet.getRange(row, COL.date, 1, 3).setValues([[
        Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd'), d.getHours(), d.getMinutes()
      ]]);
    }
  }

  SpreadsheetApp.flush();
  createCompanyFolder(sheet, row, obj.c);
  updateCalendarData(sheet, row, COL.company);
  autoSort(sheet);
  return apiGetData();
}

/**
 * 会社をまるごと削除する。
 * 消すもの：Sheet1 の行、締切・結果発表のイベント、「予定」シートの行とその予定、
 *           他の区分に残っていなければロゴの記録
 * 消さないもの：Drive の企業フォルダ（書類が入っていることがあるので手動で消す）
 */
function apiDeleteCompany(company, term) {
  const sheet = waSheet_();
  const c = waCols_(sheet);
  const row = waFindRow_(sheet, company, term, c);
  if (row < 0) return apiGetData();

  const cal = CalendarApp.getDefaultCalendar();
  deleteEventById(cal, sheet.getRange(row, COL.eventId).getValue());
  deleteEventById(cal, sheet.getRange(row, COL.resultEventId).getValue());

  const es = waEventSheet_();
  const eLast = es.getLastRow();
  if (eLast >= 2) {
    const rows = es.getRange(2, 1, eLast - 1, 10).getValues();
    const want = waTerm_(term);
    const name = String(company).trim();
    /* 行番号がずれないよう、必ず下から上へ回す */
    for (let i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i][0]).trim() !== name) continue;
      if (waTerm_(rows[i][6]) !== want) continue;
      waDeleteCalendarIds_(rows[i][4]);
      es.deleteRow(i + 2);
    }
  }

  sheet.deleteRow(row);

  SpreadsheetApp.flush();
  const remains = ['夏インターン', '本選考'].some(function (t) {
    return waFindRow_(sheet, company, t, c) > 0;
  });
  if (!remains) {
    const p = PropertiesService.getUserProperties();
    const m = JSON.parse(p.getProperty('wa_logos') || '{}');
    if (m[company] !== undefined) {
      delete m[company];
      p.setProperty('wa_logos', JSON.stringify(m));
    }
  }

  autoSort(sheet);
  return apiGetData();
}

/** 業種を書き込む。「業種」という見出しの列が無ければ何もしない */
function apiSetIndustry(company, term, value) {
  const sheet = waSheet_();
  const c = waCols_(sheet);
  const row = waFindRow_(sheet, company, term, c);
  if (row < 0 || !c['業種']) return waLight_();

  sheet.getRange(row, c['業種']).setValue(String(value || '').trim());
  return waLight_();
}

/**
 * 同じマイページを使う別コースを、別の行として増やす。
 * URL・ID・パスワード・ドメイン・業種・ルート・フォルダのリンクを引き継ぐ。
 */
function apiSplitCompany(company, term, newName) {
  newName = String(newName || '').trim();
  if (!newName) throw new Error('新しい選考の名前が空です');

  const sheet = waSheet_();
  const c = waCols_(sheet);
  const src = waFindRow_(sheet, company, term, c);
  if (src < 0) throw new Error('元の行が見つかりませんでした: ' + company);
  if (waFindRow_(sheet, newName, term, c) > 0) {
    throw new Error('その名前はすでに登録されています: ' + newName);
  }

  const s = sheet.getRange(src, 1, 1, COL.pw).getValues()[0];
  s[COL.company - 1] = newName;
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, COL.pw).setValues([s]);
  sheet.getRange(row, COL.stage).setValue('エントリー');
  sheet.getRange(row, COL.oldStatus).setValue('未');
  if (c['状態']) sheet.getRange(row, c['状態']).setValue('対応中');
  if (c['区分']) sheet.getRange(row, c['区分']).setValue(waTerm_(term));
  ['ドメイン', '業種', 'ルート'].forEach(function (h) {
    if (c[h]) sheet.getRange(row, c[h]).setValue(sheet.getRange(src, c[h]).getValue());
  });

  SpreadsheetApp.flush();
  const f = sheet.getRange(src, COL.folder).getFormula();
  if (f) sheet.getRange(row, COL.folder).setFormula(f).setHorizontalAlignment('center');

  const p = PropertiesService.getUserProperties();
  const m = JSON.parse(p.getProperty('wa_logos') || '{}');
  if (m[company] !== undefined && m[newName] === undefined) {
    m[newName] = m[company];
    p.setProperty('wa_logos', JSON.stringify(m));
  }

  autoSort(sheet);
  return apiGetData();
}

/**
 * 登録済みの会社名を付け替える。
 * 付け替えないもの：「予定」から作ったカレンダーの見出し、Drive のフォルダ名とP列のリンク
 */
function apiRenameCompany(company, term, newName) {
  newName = String(newName || '').trim();
  if (!newName) throw new Error('新しい会社名が空です');
  if (newName === company) return apiGetData();

  const sheet = waSheet_();
  const c = waCols_(sheet);
  const row = waFindRow_(sheet, company, term, c);
  if (row < 0) throw new Error('該当する行が見つかりませんでした: ' + company);
  if (waFindRow_(sheet, newName, term, c) > 0) {
    throw new Error('その名前はすでに登録されています: ' + newName);
  }

  sheet.getRange(row, COL.company).setValue(newName);

  const es = waEventSheet_();
  const eLast = es.getLastRow();
  if (eLast >= 2) {
    const rows = es.getRange(2, 1, eLast - 1, 10).getValues();
    const want = waTerm_(term);
    const old = String(company).trim();
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]).trim() !== old) continue;
      if (waTerm_(rows[i][6]) !== want) continue;
      es.getRange(i + 2, 1).setValue(newName);
    }
  }

  const p = PropertiesService.getUserProperties();
  const m = JSON.parse(p.getProperty('wa_logos') || '{}');
  if (m[company] !== undefined) {
    if (m[newName] === undefined) m[newName] = m[company];
    delete m[company];
    p.setProperty('wa_logos', JSON.stringify(m));
  }

  SpreadsheetApp.flush();
  try { updateCalendarData(sheet, row, COL.company); }
  catch (e) { console.warn('カレンダーの見出し更新に失敗: ' + e); }

  autoSort(sheet);
  return apiGetData();
}

// ============================================================
// ロゴ
// ============================================================

function apiSaveLogo(company, url) {
  /* ロックの内側で読み書きするので、並行した保存で他社の分が消えない */
  const p = PropertiesService.getUserProperties();
  const m = JSON.parse(p.getProperty('wa_logos') || '{}');
  m[company] = url;
  try {
    p.setProperty('wa_logos', JSON.stringify(m));
  } catch (e) {
    /* 1つの値は約9KBまで。超えたらロゴは端末側のキャッシュだけで持つ */
    console.warn('ロゴの保存に失敗（容量超過の可能性）: ' + e);
  }
  return waLight_();
}

function waClearLogos() {
  PropertiesService.getUserProperties().deleteProperty('wa_logos');
  waBust_();
  SpreadsheetApp.getUi().alert('ロゴのキャッシュを消しました。');
}

// ============================================================
// メニューから一度だけ実行するもの
// ============================================================

function waMigrateStatus() {
  const sheet = waSheet_();
  const c = waCols_(sheet);
  if (!c['状態']) {
    SpreadsheetApp.getUi().alert('「状態」という見出しの列が見つかりません。');
    return;
  }

  const last = sheet.getLastRow();
  if (last < 2) return;

  const old = sheet.getRange(2, COL.oldStatus, last - 1, 1).getValues();
  const cur = sheet.getRange(2, c['状態'], last - 1, 1).getValues();
  const MAP = { '済': '結果待ち', '選考落ち': '落選', '合格': '参加決定', '内定': '内定', '日程削除': '見送り' };
  const out = cur.map(function (r, i) {
    if (r[0]) return [r[0]];
    return [MAP[String(old[i][0]).trim()] || '対応中'];
  });

  sheet.getRange(2, c['状態'], out.length, 1).setValues(out);
  waBust_();
  SpreadsheetApp.getUi().alert('状態列に ' + out.length + ' 行を変換しました。');
}

function waFixSkipped() {
  const sheet = waSheet_();
  const c = waCols_(sheet);
  const last = sheet.getLastRow();
  if (last < 2 || !c['状態']) return;

  const old = sheet.getRange(2, COL.oldStatus, last - 1, 1).getValues();
  const cur = sheet.getRange(2, c['状態'], last - 1, 1).getValues();
  /* L・M列はまとめて読み書きする */
  const lm = sheet.getRange(2, COL.failDate, last - 1, 2).getValues();
  let n = 0;

  for (let i = 0; i < old.length; i++) {
    if (String(old[i][0]).trim() === '日程削除') {
      cur[i][0] = '見送り';
      lm[i][0] = '';
      lm[i][1] = '';
      n++;
    }
  }
  sheet.getRange(2, c['状態'], cur.length, 1).setValues(cur);
  sheet.getRange(2, COL.failDate, lm.length, 2).setValues(lm);
  waBust_();
  SpreadsheetApp.getUi().alert(n + ' 行を見送りに直しました。');
}

/** 区分列の空欄を夏インターンで埋める */
function waFillTerm() {
  const sheet = waSheet_();
  const c = waCols_(sheet);
  if (!c['区分']) { SpreadsheetApp.getUi().alert('「区分」列が見つかりません。'); return; }

  const last = sheet.getLastRow();
  if (last < 2) return;
  const cur = sheet.getRange(2, c['区分'], last - 1, 1).getValues();
  let n = 0;
  for (let i = 0; i < cur.length; i++) {
    if (!String(cur[i][0]).trim()) { cur[i][0] = WA_DEFAULT_TERM; n++; }
  }
  sheet.getRange(2, c['区分'], cur.length, 1).setValues(cur);
  waBust_();
  SpreadsheetApp.getUi().alert(n + ' 行を「' + WA_DEFAULT_TERM + '」にしました。');
}

function waFillDomains() {
  const T = [
    ['富士フィルム','fujifilm.com'], ['富士フイルム','fujifilm.com'],
    ['SMFL','smfl.co.jp'], ['日立','hitachi.co.jp'],
    ['キャノンマーケティング','canon.jp'], ['キヤノンマーケティング','canon.jp'],
    ['JERA','jera.co.jp'], ['NRI','nri.com'],
    ['日本製鉄','nipponsteel.com'], ['日鉄ソリューション','nssol.nipponsteel.com'],
    ['パナソニック','panasonic.com'], ['ドコモソリューション','docomo.ne.jp'],
    ['NTT docomo','docomo.ne.jp'], ['NTTファイナンス','nttfinance.co.jp'],
    ['NTTDATA研究','nttdata-strategy.com'], ['NTTデータ','nttdata.com'],
    ['NTT東日本','ntt-east.co.jp'], ['富士通','fujitsu.com'],
    ['HIS','his-j.com'], ['JAL CARD','jalcard.co.jp'], ['JALUX','jalux.com'],
    ['JAL','jal.co.jp'], ['ANA','ana.co.jp'],
    ['三菱UFJ信託','tr.mufg.jp'], ['三菱UFJ','bk.mufg.jp'],
    ['三菱電機','mitsubishielectric.co.jp'], ['川崎重工','khi.co.jp'],
    ['SBI','sbigroup.co.jp'], ['東日本旅客鉄道','jreast.co.jp'], ['JR東日本','jreast.co.jp'],
    ['KDDI','kddi.com'], ['商船三井','mol.co.jp'], ['日本郵政','japanpost.jp']
  ];

  const sheet = waSheet_();
  const c = waCols_(sheet);
  if (!c['ドメイン']) { SpreadsheetApp.getUi().alert('「ドメイン」列が見つかりません。'); return; }

  const last = sheet.getLastRow();
  if (last < 2) return;
  const names = sheet.getRange(2, COL.company, last - 1, 1).getValues();
  const cur = sheet.getRange(2, c['ドメイン'], last - 1, 1).getValues();
  let n = 0;

  for (let i = 0; i < names.length; i++) {
    if (cur[i][0]) continue;
    const name = String(names[i][0]);
    for (let k = 0; k < T.length; k++) {
      if (name.indexOf(T[k][0]) !== -1) { cur[i][0] = T[k][1]; n++; break; }
    }
  }
  sheet.getRange(2, c['ドメイン'], cur.length, 1).setValues(cur);
  waBust_();
  SpreadsheetApp.getUi().alert(n + ' 社のドメインを入れました。');
}

/** マイページのURLとログインIDを後から書き換える */
function apiSetInfo(company, term, url, id) {
  const sheet = waSheet_();
  const c = waCols_(sheet);
  const row = waFindRow_(sheet, company, term, c);
  if (row < 0) return waLight_();

  sheet.getRange(row, COL.url, 1, 2).setValues([[url || '', id || '']]);
  return waLight_();
}

/** 締切を設定・解除する */
function apiSetDue(company, term, iso) {
  const sheet = waSheet_();
  const c = waCols_(sheet);
  const row = waFindRow_(sheet, company, term, c);
  if (row < 0) return apiGetData();

  if (!iso) {
    const eid = sheet.getRange(row, COL.eventId).getValue();
    if (eid) deleteEventById(CalendarApp.getDefaultCalendar(), eid);
    sheet.getRange(row, COL.date, 1, 3).clearContent();
    sheet.getRange(row, COL.registered, 1, 2).setValues([['', '']]);
  } else {
    const d = new Date(String(iso).replace(/-/g, '/').replace('T', ' '));
    if (!isNaN(d.getTime())) {
      sheet.getRange(row, COL.date, 1, 3).setValues([[
        Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd'), d.getHours(), d.getMinutes()
      ]]);
      SpreadsheetApp.flush();
      updateCalendarData(sheet, row, COL.date);
    }
  }
  autoSort(sheet);
  return apiGetData();
}

/** 1段階戻す：段階・状態・結果日をまとめて巻き戻す */
function apiPrevStage(company, term, stage) {
  const sheet = waSheet_();
  const c = waCols_(sheet);
  const row = waFindRow_(sheet, company, term, c);
  if (row < 0) return apiGetData();

  const eid = sheet.getRange(row, COL.eventId).getValue();
  if (eid) deleteEventById(CalendarApp.getDefaultCalendar(), eid);

  /* E〜M列（日付・時・分・段階・状況・登録・ID・結果日・落ちた段階）を1回で書く */
  sheet.getRange(row, COL.date, 1, COL.failStage - COL.date + 1)
    .setValues([['', '', '', stage, '未', '', '', '', '']]);
  if (c['状態']) sheet.getRange(row, c['状態']).setValue('対応中');
  if (c['提出日']) sheet.getRange(row, c['提出日']).setValue('');
  autoSort(sheet);
  return apiGetData();
}
