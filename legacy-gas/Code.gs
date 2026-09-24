const PARENT_FOLDER_ID = '1uP4LgaMzmCfqusbhNKDqxtYnH66pkwYC';
const TARGET_SHEET_NAME = 'Sheet1';

// ============================================================
// トリガー
// onOpen: シンプルトリガー(自動) → メニュー追加 + ソート
// syncToCalendar: インストーラブルトリガー(編集時)として登録すること
// ============================================================

function onOpen() {
  // カスタムメニューを追加(手動実行がエディタ不要に)
  SpreadsheetApp.getUi()
    .createMenu('📋 就活管理')
    .addItem('既存行を一括カレンダー登録', 'registerExistingRows')
    .addItem('全企業フォルダを一括作成', 'createAllCompanyFolders')
    .addItem('Gmailから締切を取り込み', 'fetchDeadlinesFromGmail')
    .addItem('日付列に曜日表示を設定', 'setWeekdayFormat')
    .addItem('状態列を一括変換', 'waMigrateStatus')
    .addItem('日程削除を見送りに修正', 'waFixSkipped')
    .addItem('ドメインを自動入力', 'waFillDomains')
    .addItem('ロゴのキャッシュを消す', 'waClearLogos')
    .addItem('区分を夏インターンで埋める', 'waFillTerm')
    .addToUi();

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TARGET_SHEET_NAME);
  if (sheet) autoSort(sheet);
}

function syncToCalendar(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  if (sheet.getName() !== TARGET_SHEET_NAME) return;

  const row = e.range.getRow();
  const col = e.range.getColumn();

  if (row === 1 || e.range.getNumRows() > 1) return;

  // 連続編集時の競合を防ぐ排他ロック(最大10秒待機)
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;

  try {
    // A列に会社名が入力されたらフォルダ作成
    if (col === 1 && e.value) {
      createCompanyFolder(sheet, row, e.value);
    }

    // A(1), E(5), F(6), G(7), I(9), N(14) の編集でカレンダー更新
    if ([1, 5, 6, 7, 9, 14].indexOf(col) !== -1) {
      updateCalendarData(sheet, row, col);
    }

    // 日付・時刻・状況の編集でソート
    if ([5, 6, 7, 9].indexOf(col) !== -1) {
      autoSort(sheet);
    }
  } finally {
    lock.releaseLock();
    // シートを手で直した分も、ボードの読み取りにすぐ反映させる
    try { waBust_(); } catch (err) {}
  }
}

// ============================================================
// 共通ヘルパー
// ============================================================

/** 行データオブジェクトを配列から生成 */
function toRowData(v) {
  return {
    company: v[0], url: v[1], id: v[2], pw: v[3],
    deadlineVal: v[4], hourVal: v[5], minuteVal: v[6],
    stage: v[7], status: v[8], isRegistered: v[9],
    eventId: v[10], resultExpectedVal: v[13], resultEventId: v[14]
  };
}

/** 1行分のデータを一括取得 */
function getRowData(sheet, row) {
  return toRowData(sheet.getRange(row, 1, 1, 15).getValues()[0]);
}

/** 日付値を安全にDateへ変換(ハイフン区切り文字列のUTC解釈ズレを防止) */
function parseDate(val) {
  if (!val) return null;
  const d = val instanceof Date ? new Date(val.getTime()) : new Date(val.toString().replace(/-/g, '/'));
  return isNaN(d.getTime()) ? null : d;
}

/** イベントIDから安全に削除 */
function deleteEventById(calendar, eventId) {
  if (!eventId) return;
  try {
    const ev = calendar.getEventById(eventId);
    if (ev) ev.deleteEvent();
  } catch (err) {
    console.warn(`イベント削除失敗 (${eventId}): ${err}`);
  }
}

/** タイトル・説明文を生成 */
function buildEventContent(d) {
  let prefix = "就活";
  let suffix = " 締め切り";
  const interviewStatuses = ["面談", "面接", "GD", "最終面接", "インターン"];

  if (interviewStatuses.indexOf(d.status) !== -1) {
    prefix = d.status;
    suffix = "";
  } else if (d.status === "合格") {
    prefix = "合格 ✨";
    suffix = "";
  } else if (d.status === "内定") {
    prefix = "内定 🎉";
    suffix = "";
  }

  return {
    title: `【${prefix}】${d.company} (${d.stage || '未定'})${suffix}`,
    description: `マイページURL: ${d.url}\nID: ${d.id}\nパスワード: ${d.pw}\n現在の状況: ${d.status}`
  };
}

/** 締切イベントの日時と終日フラグを計算 */
function buildEventDate(d) {
  const eventDate = parseDate(d.deadlineVal);
  if (!eventDate) return null;

  let isAllDay = true;
  if (d.hourVal !== "" && d.hourVal !== null) {
    const h = parseInt(d.hourVal, 10);
    const m = (d.minuteVal !== "" && d.minuteVal !== null) ? parseInt(d.minuteVal, 10) : 0;
    if (!isNaN(h) && !isNaN(m)) {
      eventDate.setHours(h, m, 0, 0);
      isAllDay = false;
    }
  }
  return { eventDate: eventDate, isAllDay: isAllDay };
}

/** 締切イベントを作成または更新 */
function upsertDeadlineEvent(calendar, sheet, row, d) {
  const dt = buildEventDate(d);
  if (!dt) return false;

  const content = buildEventContent(d);

  // 既存イベントの更新を試行
  if (d.eventId) {
    try {
      const event = calendar.getEventById(d.eventId);
      if (event) {
        event.setTitle(content.title);
        event.setDescription(content.description);
        if (dt.isAllDay) {
          event.setAllDayDate(dt.eventDate);
        } else {
          event.setTime(dt.eventDate, new Date(dt.eventDate.getTime() + 30 * 60000));
        }
        setDeadlineReminders(event);
        sheet.getRange(row, 10).setValue("登録済");
        return true;
      }
    } catch (err) {
      console.warn(`行${row} イベント更新失敗: ${err}`);
    }
  }

  // 新規作成
  try {
    let event;
    if (dt.isAllDay) {
      event = calendar.createAllDayEvent(content.title, dt.eventDate, { description: content.description });
    } else {
      event = calendar.createEvent(content.title, dt.eventDate, new Date(dt.eventDate.getTime() + 30 * 60000), { description: content.description });
    }
    setDeadlineReminders(event);
    // J・K列は1回で書く
    sheet.getRange(row, 10, 1, 2).setValues([["登録済", event.getId()]]);
    return true;
  } catch (err) {
    console.warn(`行${row} イベント作成失敗: ${err}`);
    return false;
  }
}

/** 締切イベント: 4日前・2日前リマインダー */
function setDeadlineReminders(event) {
  event.removeAllReminders();
  event.addPopupReminder(5760);
  event.addPopupReminder(2880);
}

/** 結果発表イベントを作成または更新 */
function upsertResultEvent(calendar, sheet, row, d) {
  const resDate = parseDate(d.resultExpectedVal);
  if (!resDate) return;

  const resTitle = `【結果待ち】${d.company} (${d.stage || '未定'})`;
  const resDesc = `マイページURL: ${d.url}\nID: ${d.id}\nパスワード: ${d.pw}\n結果発表予定日です。`;

  if (d.resultEventId) {
    try {
      const resEvent = calendar.getEventById(d.resultEventId);
      if (resEvent) {
        resEvent.setTitle(resTitle);
        resEvent.setAllDayDate(resDate);
        resEvent.setDescription(resDesc);
        setResultReminders(resEvent);
        return;
      }
    } catch (err) {
      console.warn(`行${row} 結果イベント更新失敗: ${err}`);
    }
  }

  try {
    const resEvent = calendar.createAllDayEvent(resTitle, resDate, { description: resDesc });
    setResultReminders(resEvent);
    sheet.getRange(row, 15).setValue(resEvent.getId());
  } catch (err) {
    console.warn(`行${row} 結果イベント作成失敗: ${err}`);
  }
}

/** 結果発表イベント: 前日・当日リマインダー */
function setResultReminders(event) {
  event.removeAllReminders();
  event.addPopupReminder(1440);
  event.addPopupReminder(0);
}

// ============================================================
// メイン処理
// ============================================================

function updateCalendarData(sheet, row, col) {
  const d = getRowData(sheet, row);
  const calendar = CalendarApp.getDefaultCalendar();

  // --- I列(状況)の特殊コマンド ---
  if (col === 9 && d.status === "選考落ち") {
    deleteEventById(calendar, d.eventId);
    deleteEventById(calendar, d.resultEventId);
    sheet.getRange(row, 5, 1, 3).clearContent();
    sheet.getRange(row, 10, 1, 2).setValues([["選考落ち", ""]]);
    sheet.getRange(row, 12).setValue(new Date()).setNumberFormat('yyyy/MM/dd(ddd)').setHorizontalAlignment('center');
    sheet.getRange(row, 13).setValue(d.stage).setHorizontalAlignment('center');
    sheet.getRange(row, 15).setValue("");
    return;
  }

  if (col === 9 && d.status === "削除") {
    deleteEventById(calendar, d.eventId);
    deleteEventById(calendar, d.resultEventId);
    sheet.deleteRow(row);
    return;
  }

  if (col === 9 && d.status === "日程削除") {
    deleteEventById(calendar, d.eventId);
    deleteEventById(calendar, d.resultEventId);
    sheet.getRange(row, 5, 1, 3).clearContent();
    sheet.getRange(row, 10, 1, 2).setValues([["日程削除済", ""]]);
    sheet.getRange(row, 15).setValue("");
    return;
  }

  // --- 結果発表イベント ---
  if (d.resultExpectedVal && d.company) {
    upsertResultEvent(calendar, sheet, row, d);
  } else if (col === 14 && !d.resultExpectedVal && d.resultEventId) {
    deleteEventById(calendar, d.resultEventId);
    sheet.getRange(row, 15).setValue("");
  }

  // --- 締切イベント ---
  if (!d.company || !d.deadlineVal) return;
  if (d.isRegistered === "日程削除済" && col === 9 && !d.eventId) return;

  upsertDeadlineEvent(calendar, sheet, row, d);
}

/** 既存行の一括登録(手動実行 or メニューから) */
function registerExistingRows() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TARGET_SHEET_NAME);
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const calendar = CalendarApp.getDefaultCalendar();

  // 全行を一括読み込み(行ごとのgetRangeを排除して大幅高速化)
  const allValues = sheet.getRange(2, 1, lastRow - 1, 15).getValues();

  for (let i = 0; i < allValues.length; i++) {
    const row = i + 2;
    const d = toRowData(allValues[i]);

    if (d.isRegistered === "日程削除済" || d.isRegistered === "選考落ち") {
      // すでに空なら書き込まない
      if (d.deadlineVal !== "" || d.hourVal !== "" || d.minuteVal !== "") {
        sheet.getRange(row, 5, 1, 3).clearContent();
      }
      if (d.eventId) sheet.getRange(row, 11).setValue("");
      if (d.resultEventId) sheet.getRange(row, 15).setValue("");
      continue;
    }

    if (d.resultExpectedVal && !d.resultEventId) {
      upsertResultEvent(calendar, sheet, row, d);
    }

    if (!d.company || !d.deadlineVal) continue;

    if (d.eventId) {
      upsertDeadlineEvent(calendar, sheet, row, d);
      continue;
    }
    if (d.isRegistered === "登録済") continue;

    upsertDeadlineEvent(calendar, sheet, row, d);
  }
  autoSort(sheet);
  waBust_();
}

// ============================================================
// フォルダ作成
// ============================================================

function createCompanyFolder(sheet, row, companyName) {
  if (!PARENT_FOLDER_ID || PARENT_FOLDER_ID === 'ここにフォルダのIDを貼り付けてください') return;

  try {
    const parentFolder = DriveApp.getFolderById(PARENT_FOLDER_ID);
    const folders = parentFolder.getFoldersByName(companyName);
    const folder = folders.hasNext() ? folders.next() : parentFolder.createFolder(companyName);
    sheet.getRange(row, 16)
      .setFormula(`=HYPERLINK("${folder.getUrl()}", "📁 フォルダを開く")`)
      .setHorizontalAlignment('center');
  } catch (err) {
    console.warn(`フォルダ作成失敗 (${companyName}): ${err}`);
  }
}

function createAllCompanyFolders() {
  if (!PARENT_FOLDER_ID || PARENT_FOLDER_ID === 'ここにフォルダのIDを貼り付けてください') {
    SpreadsheetApp.getUi().alert("コードの1行目にフォルダIDを設定してください。");
    return;
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TARGET_SHEET_NAME);
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  // 会社名と既存リンクを一括読み込み
  const companies = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const links = sheet.getRange(2, 16, lastRow - 1, 1).getFormulas();

  for (let i = 0; i < companies.length; i++) {
    if (companies[i][0] && !links[i][0]) {
      createCompanyFolder(sheet, i + 2, companies[i][0]);
    }
  }
  waBust_();
}

// ============================================================
// ソート
// ============================================================

function autoSort(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const lastCol = Math.max(sheet.getLastColumn(), 16);
  const tempCol = lastCol + 1;

  if (sheet.getMaxColumns() < tempCol) {
    sheet.insertColumnAfter(sheet.getMaxColumns());
  }

  // A列とI列は1回の読み取りで取る
  const before = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  const sortKeys = before.map(r => [getLaneGroup(r[8], r[0])]);
  sheet.getRange(2, tempCol, lastRow - 1, 1).setValues(sortKeys);

  sheet.getRange(2, 1, lastRow - 1, tempCol).sort([
    { column: tempCol, ascending: true },
    { column: 5, ascending: true },
    { column: 6, ascending: true },
    { column: 7, ascending: true }
  ]);

  // 並べ替え後のレーン番号は一時列からそのまま読める
  const lanes = sheet.getRange(2, tempCol, lastRow - 1, 1).getValues().map(r => r[0]);
  sheet.getRange(2, tempCol, lastRow - 1, 1).clearContent();

  // レーン区切りの罫線を引き直す
  sheet.getRange(2, 1, lastRow - 1, lastCol).setBorder(false, false, false, false, false, false);

  for (let i = 0; i < lanes.length - 1; i++) {
    const cur = lanes[i];
    const next = lanes[i + 1];
    if (cur !== next && cur !== 8 && next !== 8) {
      sheet.getRange(i + 2, 1, 1, lastCol).setBorder(null, null, true, null, null, null, "black", SpreadsheetApp.BorderStyle.SOLID_THICK);
    }
  }
}

function getLaneGroup(status, company) {
  if (company === "テストセンター") return 0; // テストセンターを無条件で一番上（0番レーン）に固定

  if (!company) return 8;
  if (status === "未" || status === "") return 1;
  if (["面談", "面接", "GD", "最終面接", "インターン"].indexOf(status) !== -1) return 2;
  if (status === "合格") return 3;
  if (status === "内定") return 4;
  if (status === "済") return 5;
  if (status === "選考落ち") return 6;
  if (status === "日程削除") return 7;
  return 8;
}

// ============================================================
// Gmail連携
// ============================================================

/** 本文から締切日を拾う。年付き → 月日の順で探し、ありえない月日は捨てる */
function gmPickDate_(body) {
  const now = new Date();
  const ok = function (mo, d) { return mo >= 1 && mo <= 12 && d >= 1 && d <= 31; };

  let m = body.match(/(20\d{2})\s*[\/\-年.]\s*(\d{1,2})\s*[\/\-月.]\s*(\d{1,2})/);
  if (m && ok(+m[2], +m[3])) return m[1] + '/' + (+m[2]) + '/' + (+m[3]);

  // 前後に数字が続く所は拾わない（2026/09/30 の「26/09」を月日と取り違えないため）
  const re = /(?:^|[^\d])(\d{1,2})\s*[\/\-月]\s*(\d{1,2})(?!\d)/g;
  while ((m = re.exec(body))) {
    const mo = +m[1], d = +m[2];
    if (!ok(mo, d)) continue;
    let year = now.getFullYear();
    // 検出した月日が過去なら翌年と判断(年末年始の年またぎ対応)
    const cand = new Date(year, mo - 1, d);
    if (cand.getTime() < now.getTime() - 24 * 60 * 60 * 1000) year += 1;
    return year + '/' + mo + '/' + d;
  }
  return null;
}

function fetchDeadlinesFromGmail() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TARGET_SHEET_NAME);
  if (!sheet) return;

  const labelName = "就活シート連携済";
  const label = GmailApp.getUserLabelByName(labelName) || GmailApp.createLabel(labelName);

  const query = `subject:(締切 OR 締め切り OR 期限 OR エントリー) -label:${labelName} newer_than:3d`;
  const threads = GmailApp.search(query, 0, 10);
  if (threads.length === 0) return;

  // 重複チェック用に既存の会社名一覧を取得
  const lastRow = sheet.getLastRow();
  const existingCompanies = lastRow >= 2
    ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(r => String(r[0]).trim())
    : [];

  const newRows = [];

  for (const thread of threads) {
    const messages = thread.getMessages();
    const latestMessage = messages[messages.length - 1];
    const subject = latestMessage.getSubject();
    const body = latestMessage.getPlainBody();

    let companyName = "";
    const companyMatch = subject.match(/【([^】]+)】/);
    if (companyMatch) {
      companyName = companyMatch[1].replace(/(マイナビ|リクナビ|キャリタス|インターンシップ|就活)/g, "").trim();
    }
    if (!companyName || companyName.length < 2) {
      companyName = latestMessage.getFrom().replace(/<[^>]+>/g, "").replace(/"/g, "").trim();
    }

    // 既にシートに存在する会社はスキップ(重複行の防止)
    if (existingCompanies.indexOf(companyName) !== -1) {
      thread.addLabel(label);
      continue;
    }

    let detectedDateStr = gmPickDate_(body);
    if (!detectedDateStr) {
      const fallbackDate = new Date(latestMessage.getDate());
      fallbackDate.setDate(fallbackDate.getDate() + 3);
      detectedDateStr = Utilities.formatDate(fallbackDate, "Asia/Tokyo", "yyyy/MM/dd");
    }

    newRows.push({ company: companyName, date: detectedDateStr });
    existingCompanies.push(companyName);
    thread.addLabel(label);
  }

  if (!newRows.length) return;

  // 画面側が「状態」「区分」を見て並べるので、ここでも埋めておく
  const c = waCols_(sheet);
  let targetRow = sheet.getLastRow() + 1;
  for (const r of newRows) {
    sheet.getRange(targetRow, 1).setValue(r.company);
    sheet.getRange(targetRow, 5).setValue(r.date);
    sheet.getRange(targetRow, 8, 1, 2).setValues([["メール自動検出", "未"]]);
    if (c['状態']) sheet.getRange(targetRow, c['状態']).setValue('対応中');
    if (c['区分']) sheet.getRange(targetRow, c['区分']).setValue(WA_DEFAULT_TERM);
    targetRow++;
  }

  autoSort(sheet);
  waBust_();
}

// ============================================================
// 書式設定(手動実行 or メニューから)
// ============================================================

function setWeekdayFormat() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TARGET_SHEET_NAME);
  if (!sheet) return;

  const format = 'yyyy/MM/dd(ddd)';
  sheet.getRangeList(["E2:E", "L2:L", "N2:N"]).setNumberFormat(format);

  SpreadsheetApp.getUi().alert("すべてのカレンダー/日付に曜日を表示する設定が完了しました！");
}
