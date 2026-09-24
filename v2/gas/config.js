/*
 * 設定の読み込みと、本番を守るための安全装置。
 *
 * シート・カレンダー・Drive の親フォルダ・鍵は、コードに書かずスクリプトのプロパティから読む。
 *   SHEET_ID          スプレッドシートの ID
 *   CALENDAR_ID       予定を入れるカレンダーの ID
 *   DRIVE_PARENT_ID   会社ごとのフォルダを作る親フォルダの ID
 *   API_KEY           画面から呼ぶときの鍵
 *   ALLOW_PRODUCTION  本番に切り替えるときだけ yes にする（開発中は置かない）
 *   LEGACY_LOGOS      移行のときだけ使う。旧版のロゴの記録（JSON）
 *
 * カレンダーは必ず ID から開く。既定のカレンダーは本番なので、うっかり開かないよう使わない。
 */

/* 本番シートの ID の頭。開発中にこれを指していたら止める */
var PRODUCTION_SHEET_PREFIX = '1v-nnIz3';

function prop_(name, required) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  v = v == null ? '' : String(v).trim();
  if (required && !v) throw new Error('スクリプトのプロパティ ' + name + ' が入っていません。');
  return v;
}

function allowProduction_() {
  return prop_('ALLOW_PRODUCTION') === 'yes';
}

/* 1回の実行の中では、同じものを何度も開き直さない */
var cache_ = {};

/* 入口ごとに呼ぶ。前の呼び出しで読んだ中身を、次の呼び出しに持ち越さないため */
function resetRun_() {
  cache_ = {};
  tables_ = {};
}

function spreadsheet_() {
  if (cache_.ss) return cache_.ss;
  var id = prop_('SHEET_ID', true);
  if (id.indexOf(PRODUCTION_SHEET_PREFIX) === 0 && !allowProduction_()) {
    throw new Error('SHEET_ID が本番のシートを指しています。開発中は開発用シートの ID を入れてください。');
  }
  return (cache_.ss = SpreadsheetApp.openById(id));
}

function calendar_() {
  if (cache_.cal) return cache_.cal;
  var id = prop_('CALENDAR_ID', true);
  var cal = CalendarApp.getCalendarById(id);
  if (!cal) throw new Error('CALENDAR_ID のカレンダーが見つかりません。');
  /* 既定のカレンダー（本番）は、切り替えのときまで触らない */
  if (cal.isMyPrimaryCalendar() && !allowProduction_()) {
    throw new Error('CALENDAR_ID が既定のカレンダーを指しています。開発中は開発用カレンダーの ID を入れてください。');
  }
  cache_.calId = id;
  return (cache_.cal = cal);
}

function calendarId_() {
  calendar_();
  return cache_.calId;
}

function driveParent_() {
  if (cache_.drive) return cache_.drive;
  return (cache_.drive = DriveApp.getFolderById(prop_('DRIVE_PARENT_ID', true)));
}

/* 設定が揃っているかを確かめる。エディタから実行して、実行ログで結果を見る */
function checkSetup() {
  resetRun_();
  var ss = spreadsheet_();
  var cal = calendar_();
  var folder = driveParent_();
  prop_('API_KEY', true);
  console.log('シート：' + ss.getName());
  console.log('カレンダー：' + cal.getName());
  console.log('Drive の親フォルダ：' + folder.getName());
  console.log('本番への切り替え：' + (allowProduction_() ? 'オン' : 'オフ（開発中）'));
  return 'ok';
}
