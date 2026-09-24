/*
 * GAS の模擬環境。reference-tests/gas_mock.js を土台に、新しい GAS に合わせて組み直したもの。
 *
 * 本番を守れているかを確かめられるよう、わざと厳しくしてある。
 * ・CalendarApp.getDefaultCalendar() とユーザーのプロパティは、呼んだらエラーにする
 * ・getEventById は、ほかのカレンダーの予定も返してしまう（いちばん悪い場合を想定）
 * ・開いたシートの ID を覚えておく
 */
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const GAS_DIR = path.join(__dirname, '..', 'gas');
const DEV_SHEET = 'dev_sheet';
const PROD_SHEET = '1v-nnIz3_production';
const DEV_CAL = 'dev_cal@group.calendar.google.com';
const PRIMARY_CAL = 'me@gmail.com';
const PARENT = 'parent_folder';

class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
  cell(i, j) {
    const row = this.sh.d[this.r - 1 + i] || [];
    const v = row[this.c - 1 + j];
    return v === undefined ? '' : v;
  }
  getValues() {
    const o = [];
    for (let i = 0; i < this.nr; i++) {
      const a = [];
      for (let j = 0; j < this.nc; j++) a.push(this.cell(i, j));
      o.push(a);
    }
    return o;
  }
  getValue() { return this.cell(0, 0); }
  setValues(v) {
    if (v.length !== this.nr || v.some((row) => row.length !== this.nc)) {
      throw new Error(`setValues の大きさが違う ${v.length}x${v[0].length} / ${this.nr}x${this.nc}`);
    }
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.put(this.r + i, this.c + j, v[i][j]);
    this.sh.writes++;
    return this;
  }
  getFormulas() {
    const o = [];
    for (let i = 0; i < this.nr; i++) {
      const a = [];
      for (let j = 0; j < this.nc; j++) a.push(this.sh.f[`${this.r + i},${this.c + j}`] || '');
      o.push(a);
    }
    return o;
  }
  setNumberFormat(f) { this.sh.formats.push({ r: this.r, c: this.c, nr: this.nr, nc: this.nc, f }); return this; }
}

class Sheet {
  constructor(name, d) {
    this.name = name;
    this.d = d || [];
    this.f = {};
    this.maxRows = Math.max(1000, this.d.length);
    this.maxCols = 26;
    this.formats = [];
    this.writes = 0;
    this.frozen = 0;
  }
  getName() { return this.name; }
  put(r, c, v) {
    while (this.d.length < r) this.d.push([]);
    const row = this.d[r - 1];
    while (row.length < c) row.push('');
    row[c - 1] = v;
  }
  getRange(r, c, nr, nc) {
    nr = nr || 1; nc = nc || 1;
    if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error(`範囲がおかしい ${[r, c, nr, nc]}`);
    if (r + nr - 1 > this.maxRows || c + nc - 1 > this.maxCols) throw new Error('シートの大きさの範囲外');
    return new Range(this, r, c, nr, nc);
  }
  getLastRow() {
    for (let i = this.d.length; i > 0; i--) if ((this.d[i - 1] || []).some((v) => v !== '' && v !== undefined)) return i;
    return 0;
  }
  getLastColumn() {
    let m = 0;
    this.d.forEach((r) => r.forEach((v, j) => { if (v !== '' && v !== undefined) m = Math.max(m, j + 1); }));
    return m;
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(after, n) { this.maxRows += n; }
  insertColumnsAfter(after, n) { this.maxCols += n; }
  setFrozenRows(n) { this.frozen = n; }
  deleteRow(r) {
    this.d.splice(r - 1, 1);
    this.maxRows--;
  }
  /* 並べ替えは禁止。呼ばれたらテストで気づけるようにする */
  sort() { throw new Error('シートを並べ替えてはいけない'); }
}

class Book {
  constructor(id, name) { this.id = id; this.name = name; this.sheets = {}; }
  getName() { return this.name; }
  getSpreadsheetTimeZone() { return 'Asia/Tokyo'; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { return (this.sheets[n] = new Sheet(n, [])); }
}

/* 日本時間での書式。Utilities.formatDate の代わり */
function formatDate(d, tz, fmt) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return fmt.replace(/'T'/, 'T').replace('yyyy', parts.year).replace('MM', parts.month)
    .replace('dd', parts.day).replace('HH', parts.hour).replace('mm', parts.minute);
}

function mk(props) {
  const log = [];
  const books = {
    [DEV_SHEET]: new Book(DEV_SHEET, '就活シート（開発用）'),
    [PROD_SHEET]: new Book(PROD_SHEET, '就活シート（本番）')
  };
  const opened = [];

  let evSeq = 0;
  const allEvents = {};
  const calCalls = { create: 0, update: 0, remove: 0, get: 0 };
  function mkEvent(calId, title, start, end, opt, allDay) {
    const id = 'ev' + (++evSeq) + '@google.com';
    const o = {
      id, calId, title, start, end, allDay, desc: (opt && opt.description) || '', reminders: [], alive: true,
      getId: () => id,
      getTitle: () => o.title,
      getDescription: () => o.desc,
      getOriginalCalendarId: () => o.calId,
      isAllDayEvent: () => o.allDay,
      setTitle(t) { calCalls.update++; o.title = t; return o; },
      setDescription(t) { calCalls.update++; o.desc = t; return o; },
      setTime(s, e) { calCalls.update++; o.start = s; o.end = e; return o; },
      setAllDayDates(s, e) { calCalls.update++; o.start = s; o.end = e; return o; },
      removeAllReminders() { o.reminders = []; return o; },
      addPopupReminder(m) { o.reminders.push(m); return o; },
      deleteEvent() { calCalls.remove++; o.alive = false; }
    };
    allEvents[id] = o;
    return o;
  }
  function mkCalendar(id, name, primary) {
    return {
      getId: () => id,
      getName: () => name,
      isMyPrimaryCalendar: () => primary,
      createEvent(t, s, e, opt) { calCalls.create++; return mkEvent(id, t, s, e, opt, false); },
      createAllDayEvent(t, s, e, opt) { calCalls.create++; return mkEvent(id, t, s, e, opt, true); },
      getEvents(s, e) {
        return Object.values(allEvents).filter((x) => x.alive && x.calId === id && x.start < e && x.end > s)
          .map((x) => ({ getTitle: () => x.title }));
      },
      /* ほかのカレンダーの予定も返してしまう */
      getEventById(eid) { calCalls.get++; const e = allEvents[eid]; return e && e.alive ? e : null; }
    };
  }
  const calendars = {
    [DEV_CAL]: mkCalendar(DEV_CAL, '就活（開発用）', false),
    [PRIMARY_CAL]: mkCalendar(PRIMARY_CAL, '本番', true)
  };

  const folders = {};
  function mkFolder(id, name) {
    const f = {
      id, name, children: [],
      getName: () => name,
      getUrl: () => 'https://drive.google.com/drive/folders/' + id,
      getFoldersByName(n) {
        const hit = f.children.filter((c) => c.name === n);
        let i = 0;
        return { hasNext: () => i < hit.length, next: () => hit[i++] };
      },
      createFolder(n) { const c = mkFolder('f' + Object.keys(folders).length, n); f.children.push(c); return c; }
    };
    folders[id] = f;
    return f;
  }
  mkFolder(PARENT, '就活（開発用）');

  let held = false;
  const cache = {};
  const scriptProps = Object.assign({
    SHEET_ID: DEV_SHEET, CALENDAR_ID: DEV_CAL, DRIVE_PARENT_ID: PARENT, API_KEY: 'secret-key'
  }, props || {});

  const ctx = {
    console: { log: (...a) => log.push(a.join(' ')), warn: (...a) => log.push('WARN ' + a.join(' ')) },
    Date,
    SpreadsheetApp: {
      openById(id) {
        opened.push(id);
        if (!books[id]) throw new Error('そのシートは無い');
        return books[id];
      },
      getActiveSpreadsheet() { throw new Error('getActiveSpreadsheet は使わない'); }
    },
    CalendarApp: {
      getDefaultCalendar() { throw new Error('既定のカレンダーは使わない'); },
      getCalendarById: (id) => calendars[id] || null
    },
    DriveApp: {
      getFolderById(id) { if (!folders[id]) throw new Error('そのフォルダは無い'); return folders[id]; }
    },
    LockService: {
      getScriptLock: () => ({
        waitLock() { if (held) throw new Error('ロックを二重に取った'); held = true; },
        releaseLock() { held = false; }
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in cache ? cache[k] : null),
        put: (k, v) => { if (v.length > 100000) throw new Error('大きすぎる'); cache[k] = v; },
        remove: (k) => { delete cache[k]; }
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in scriptProps ? scriptProps[k] : null),
        setProperty: (k, v) => { scriptProps[k] = v; }
      }),
      getUserProperties() { throw new Error('ユーザーのプロパティは使わない'); }
    },
    Utilities: { getUuid: () => crypto.randomUUID(), formatDate },
    ContentService: {
      createTextOutput: (s) => ({ s, setMimeType() { return this; } }),
      MimeType: { JSON: 'json' }
    }
  };
  vm.createContext(ctx);

  /* GAS と同じく全部のファイルを1つの場所に読み込む。domain.js を先に */
  const files = fs.readdirSync(GAS_DIR).filter((f) => f.endsWith('.js'))
    .sort((a, b) => (a === 'domain.js' ? -1 : b === 'domain.js' ? 1 : a.localeCompare(b)));
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(GAS_DIR, f), 'utf8'), ctx, { filename: f });

  const T = {
    ctx, books, calendars, allEvents, calCalls, folders, cache, scriptProps, log, opened,
    dev: books[DEV_SHEET],
    heldLock: () => held,
    /* 画面からの呼び出しと同じ形で呼び、結果はこちら側のオブジェクトにして返す */
    api(action, args, key) {
      return JSON.parse(ctx.route_({ key: key === undefined ? scriptProps.API_KEY : key, action, args }));
    },
    run(fnName) { return JSON.parse(JSON.stringify(ctx[fnName]() || null)); },
    sheet(name) { return books[DEV_SHEET].getSheetByName(name); },
    /* シートの中身を見出しつきのオブジェクトで読む */
    rows(name) {
      const sh = T.sheet(name);
      if (!sh) return [];
      const [head, ...rest] = sh.d;
      return rest.filter((r) => r.some((v) => v !== '')).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
    },
    live: () => Object.values(allEvents).filter((e) => e.alive),
    liveIn: (calId) => Object.values(allEvents).filter((e) => e.alive && e.calId === calId),
    resetCalls() { for (const k in calCalls) calCalls[k] = 0; }
  };
  return T;
}

module.exports = { mk, formatDate, DEV_SHEET, PROD_SHEET, DEV_CAL, PRIMARY_CAL, PARENT, Sheet };
