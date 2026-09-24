/*
 * companies と events の2枚のシートを読み書きする。
 *
 * ・1行目の見出しの名前で列を探す。列の順番には頼らない。
 * ・行は id で探す。シートの行は並べ替えない（並べ替えると、探した行と書く行がずれる）。
 *   行番号は id ごとに表で覚えておき、会社データそのものには持たせない。
 *   Domain.apply は写しを返すので、データに持たせると写したときに抜け落ちるため。
 * ・値は文字列のまま置く。書式が自動のままだと、2026-10-03 のような値が日付に化けるので、
 *   書く範囲は書式なしテキストにしてから書く。
 */

var COMPANY_COLS = ['id', 'kind', 'name', 'term', 'status', 'stage', 'route', 'lostStage',
  'dueAt', 'dueHasTime', 'submittedAt', 'resultAt', 'url', 'loginId', 'pw', 'domain', 'industry',
  'logo', 'logoManual', 'folderUrl', 'cal', 'updatedAt'];
var EVENT_COLS = ['id', 'companyId', 'kind', 'startAt', 'endAt', 'allDay', 'daily', 'place'];

var BOOL_COLS = { dueHasTime: 1, logoManual: 1, allDay: 1, daily: 1 };
var JSON_COLS = { route: '[]', cal: '{}' };
var DATE_ONLY_COLS = { submittedAt: 1, resultAt: 1 };

function Table_(name, cols) {
  this.name = name;
  this.cols = cols;
  this.sheet = null;
  this.rows = null;   // 読んだ行（id を持つものだけ）
  this.meta = null;   // id → { row: 行番号, raw: シートの値そのまま }
}

Table_.prototype.open = function () {
  if (this.sheet) return this;
  var ss = spreadsheet_();
  this.tz = ss.getSpreadsheetTimeZone();
  var sh = ss.getSheetByName(this.name);
  var created = !sh;
  if (!sh) sh = ss.insertSheet(this.name);
  this.sheet = sh;

  var head = this.readHead_();
  var missing = this.cols.filter(function (c) { return head.indexOf(c) < 0; });
  if (missing.length) {
    /* 足りない見出しは右端に足す。今ある列は動かさない */
    var start = head.length + 1;
    var need = start + missing.length - 1 - sh.getMaxColumns();
    if (need > 0) sh.insertColumnsAfter(sh.getMaxColumns(), need);
    sh.getRange(1, start, sh.getMaxRows(), missing.length).setNumberFormat('@');
    sh.getRange(1, start, 1, missing.length).setValues([missing]);
    head = this.readHead_();
  }
  if (created) sh.setFrozenRows(1);

  this.index = {};
  for (var i = 0; i < head.length; i++) if (head[i]) this.index[head[i]] = i;
  this.width = head.length;
  return this;
};

Table_.prototype.readHead_ = function () {
  var sh = this.sheet;
  var n = sh.getLastColumn();
  if (n < 1) return [];
  var head = sh.getRange(1, 1, 1, n).getValues()[0].map(function (h) { return str_(h).trim(); });
  while (head.length && !head[head.length - 1]) head.pop();
  return head;
};

Table_.prototype.fromCell_ = function (col, v) {
  if (has_(BOOL_COLS, col)) return v === true || str_(v).trim().toUpperCase() === 'TRUE';
  if (has_(JSON_COLS, col)) {
    try { return JSON.parse(str_(v).trim() || JSON_COLS[col]); } catch (e) { return JSON.parse(JSON_COLS[col]); }
  }
  /* 書式を消し忘れたなどで Date が入っていても、文字列にそろえる */
  if (isDate_(v)) return dateToWall_(v, this.tz, !has_(DATE_ONLY_COLS, col));
  return str_(v);
};

Table_.prototype.toCell_ = function (col, v) {
  if (has_(BOOL_COLS, col)) return v ? 'TRUE' : 'FALSE';
  if (has_(JSON_COLS, col)) return JSON.stringify(v == null || v === '' ? JSON.parse(JSON_COLS[col]) : v);
  return str_(v);
};

Table_.prototype.load_ = function () {
  if (this.rows) return this.rows;
  var sh = this.sheet, last = sh.getLastRow(), self = this;
  this.rows = [];
  this.meta = {};
  if (last < 2 || !this.width) return this.rows;
  sh.getRange(2, 1, last - 1, this.width).getValues().forEach(function (raw, i) {
    var o = {};
    self.cols.forEach(function (c) { o[c] = self.fromCell_(c, raw[self.index[c]]); });
    if (!o.id || has_(self.meta, o.id)) return;
    self.meta[o.id] = { row: i + 2, raw: raw };
    self.rows.push(o);
  });
  return this.rows;
};

/* 呼び出し側が書き換えても表の中身が変わらないよう、写しを返す */
Table_.prototype.all = function () {
  return this.load_().map(function (o) { return JSON.parse(JSON.stringify(o)); });
};

Table_.prototype.find = function (id) {
  var rows = this.load_();
  for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return JSON.parse(JSON.stringify(rows[i]));
  return null;
};

Table_.prototype.rowOf_ = function (obj, base) {
  var arr = base ? base.slice() : [];
  while (arr.length < this.width) arr.push('');
  for (var i = 0; i < this.cols.length; i++) {
    var c = this.cols[i];
    if (has_(obj, c)) arr[this.index[c]] = this.toCell_(c, obj[c]);
  }
  return arr;
};

/* 1行を書く。同じ id の行があればそこへ、無ければ末尾に足す */
Table_.prototype.write = function (obj) {
  if (!obj || !obj.id) throw new Error('id の無い行は書けません。');
  this.load_();
  var m = this.meta[obj.id];
  var arr = this.rowOf_(obj, m && m.raw);
  var row = m ? m.row : this.sheet.getLastRow() + 1;
  this.ensureRows_(row);
  var range = this.sheet.getRange(row, 1, 1, this.width);
  range.setNumberFormat('@');
  range.setValues([arr]);

  var saved = {};
  var self = this;
  this.cols.forEach(function (c) { saved[c] = self.fromCell_(c, arr[self.index[c]]); });
  this.meta[obj.id] = { row: row, raw: arr };
  var at = -1;
  for (var i = 0; i < this.rows.length; i++) if (this.rows[i].id === obj.id) at = i;
  if (at >= 0) this.rows[at] = saved; else this.rows.push(saved);
};

/* 移行のときに、まとめて1回で書く */
Table_.prototype.appendMany = function (objs) {
  if (!objs.length) return;
  this.load_();
  var self = this;
  var start = this.sheet.getLastRow() + 1;
  this.ensureRows_(start + objs.length - 1);
  var range = this.sheet.getRange(start, 1, objs.length, this.width);
  range.setNumberFormat('@');
  range.setValues(objs.map(function (o) { return self.rowOf_(o, null); }));
  this.rows = null;
};

Table_.prototype.ensureRows_ = function (row) {
  var max = this.sheet.getMaxRows();
  if (row > max) this.sheet.insertRowsAfter(max, row - max);
};

/* id の並びで行を消す。下から消すので、残りの行番号はずれない */
Table_.prototype.removeMany = function (ids) {
  this.load_();
  var self = this;
  var rows = ids.map(function (id) { return self.meta[id] && self.meta[id].row; }).filter(Boolean)
    .sort(function (a, b) { return b - a; });
  for (var i = 0; i < rows.length; i++) this.sheet.deleteRow(rows[i]);
  this.rows = null;
};

var tables_ = {};
function companies_() { return tables_.c || (tables_.c = new Table_('companies', COMPANY_COLS).open()); }
function events_() { return tables_.e || (tables_.e = new Table_('events', EVENT_COLS).open()); }

/* 画面へ返す形。パスワードとカレンダーの対応表は載せない */
function publicCompany_(c) {
  var o = {};
  COMPANY_COLS.forEach(function (k) { if (k !== 'pw' && k !== 'cal') o[k] = c[k]; });
  return o;
}

function publicEvent_(e) {
  var o = {};
  EVENT_COLS.forEach(function (k) { o[k] = e[k]; });
  return o;
}

function eventsOf_(companyId) {
  return events_().all().filter(function (e) { return e.companyId === companyId; });
}
