/*
 * 日時の見せ方と、予定の読み方。
 *
 * 日時は日本時間の文字列（2026-10-03T23:59）で届く。Domain.parseWall で数に直してから計算するので、
 * 端末の時計の地域に左右されない。
 */

const JST_MS = 9 * 3600000;
const WD = ['日', '月', '火', '水', '木', '金', '土'];

/* 終了時刻が入っていない予定を、開始から何時間「開催中」とみなすか */
export const EV_GRACE_MS = 2 * 3600000;

/* 日本時間の文字列 → その瞬間の数（ミリ秒）。読めなければ null */
export function instant(s) {
  const w = Domain.parseWall(String(s == null ? '' : s).slice(0, 16));
  return w == null ? null : w - JST_MS;
}

function wall(s) {
  const w = Domain.parseWall(String(s == null ? '' : s).slice(0, 16));
  return w == null ? null : new Date(w);
}

const p2 = (n) => ('0' + n).slice(-2);

export function fdate(s) {
  const d = wall(s);
  return d ? (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '(' + WD[d.getUTCDay()] + ')' : '';
}

export function ftime(s) {
  const d = wall(s);
  return d && String(s).length >= 16 ? p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) : '';
}

/* 残り時間。過ぎていれば null */
export function rem(s, now = Date.now()) {
  const t = instant(s);
  if (t == null) return null;
  const ms = t - now;
  if (ms <= 0) return null;
  const x = Math.floor(ms / 1000);
  return { ms, d: Math.floor(x / 86400), h: Math.floor((x % 86400) / 3600), m: Math.floor((x % 3600) / 60), s: x % 60 };
}

export function since(date, now = Date.now()) {
  return Domain.daysSince(date, new Date(now));
}

// ============================================================
// 予定
// ============================================================

function dayStart(s) { return instant(String(s).slice(0, 10)); }

/* 予定が終わる瞬間。終日は終わりの日の終わり、時刻なしの予定は開始から一定時間 */
export function evEndAt(e) {
  if (e.allDay) return dayStart(e.endAt || e.startAt) + 86400000 - 60000;
  if (e.endAt) return instant(e.endAt);
  const s = instant(e.startAt);
  return s == null ? null : s + EV_GRACE_MS;
}

export function evActive(e, now = Date.now()) {
  const end = evEndAt(e);
  return end != null && end > now;
}

export function evOngoing(e, now = Date.now()) {
  return evActive(e, now) && !rem(e.startAt, now);
}

export function evDays(e) {
  if (!e.endAt) return 1;
  const a = dayStart(e.startAt), b = dayStart(e.endAt);
  if (a == null || b == null) return 1;
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

export function evWhen(e) {
  const n = evDays(e);
  if (n > 1 && e.daily) return fdate(e.startAt) + '〜' + fdate(e.endAt) + ' 毎日 ' + ftime(e.startAt) + '〜' + ftime(e.endAt);
  if (n > 1) {
    return e.allDay ? fdate(e.startAt) + ' 〜 ' + fdate(e.endAt)
      : fdate(e.startAt) + ' ' + ftime(e.startAt) + ' 〜 ' + fdate(e.endAt) + ' ' + ftime(e.endAt);
  }
  if (e.allDay) return fdate(e.startAt) + ' 終日';
  return e.endAt ? fdate(e.startAt) + ' ' + ftime(e.startAt) + '〜' + ftime(e.endAt) : fdate(e.startAt) + ' ' + ftime(e.startAt);
}

/* 一覧のタイル用。細かい時間帯は詳細に任せ、1行に収める */
export function evTile(e) {
  if (evDays(e) > 1) return fdate(e.startAt) + '〜' + fdate(e.endAt);
  if (e.allDay) return fdate(e.startAt) + ' 終日';
  return fdate(e.startAt) + ' ' + ftime(e.startAt);
}

export function evShort(e) {
  if (evDays(e) > 1) return fdate(e.startAt) + '〜' + fdate(e.endAt);
  if (e.allDay) return fdate(e.startAt) + ' 終日';
  return fdate(e.startAt) + ' 実施';
}

export function spanText(e) {
  const n = evDays(e);
  return n > 1 ? n + '日間' + (e.daily ? ' 連日' : '') : e.allDay ? '終日' : '';
}

export function byStart(a, b) {
  return String(a.startAt).localeCompare(String(b.startAt));
}

/* Googleカレンダーの追加画面を開く URL */
export function gcalUrl(title, at, details, allDay) {
  const w = Domain.parseWall(String(at).slice(0, 16));
  if (w == null) return '#';
  const f = (ms, t) => {
    const d = new Date(ms);
    const day = d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate());
    return t ? day + 'T' + p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + '00' : day;
  };
  const dates = allDay ? f(w, false) + '/' + f(w + 86400000, false) : f(w, true) + '/' + f(w + 3600000, true);
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(title) +
    '&dates=' + dates + '&ctz=Asia/Tokyo&details=' + encodeURIComponent(details || '');
}
