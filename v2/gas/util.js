/*
 * GAS 側で使い回す小さな道具。
 * 日時は Domain と同じく、日本時間の文字列（2026-10-03T23:59）でやり取りする。
 */

var JST_OFFSET_MS = 9 * 3600000;

function str_(v) { return v == null ? '' : String(v); }

function has_(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

/* 別の実行環境で作られた Date でも見分けられるよう、instanceof は使わない */
function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }

/* 日本時間の文字列を、カレンダーに渡す Date に直す */
function wallToDate_(s) {
  var ms = Domain.parseWall(s);
  if (ms == null) throw new Error('日時の形式が正しくありません：' + s);
  return new Date(ms - JST_OFFSET_MS);
}

/* 就活ボードの日時は、いつも日本時間で読む */
var APP_TZ = 'Asia/Tokyo';

/**
 * シートから読んだ Date を、日本時間の文字列に直す。
 * シートのタイムゾーンは使わない。本番シートも開発用シートもアメリカ西海岸（Los Angeles）になっていて、
 * それで直すと、夏は16時間、冬は17時間ずれる。
 * セルの Date は「その瞬間」を正しく持っている（旧版の GAS は日本時間で動いて書いていた）ので、
 * 日本時間で読めば、旧版の画面に出ていた時刻と同じになる。表示の文字（getDisplayValues）は読まない。
 */
function dateToWall_(d, withTime) {
  return Utilities.formatDate(d, APP_TZ, withTime ? "yyyy-MM-dd'T'HH:mm" : 'yyyy-MM-dd');
}

function newId_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function nowIso_() { return new Date().toISOString(); }

/* 書き換えの印。同じミリ秒に2回書いても前と同じ値にならないよう、必ず前より後にする */
function stampAfter_(prev) {
  var t = nowIso_();
  var p = Date.parse(str_(prev));
  if (!isNaN(p) && Date.parse(t) <= p) t = new Date(p + 1).toISOString();
  return t;
}
