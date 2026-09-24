/*
 * 端末の保存領域（localStorage）。
 *
 * 旧版と新版は同じ場所（github.io の同じオリジン）に置くので、保存領域も共有になる。
 * 取り違えないよう、新版のキーには必ず sk2_ を付ける。
 * プライベートブラウズなどで使えないこともあるので、失敗しても止めない。
 * パスワードはここに置かない。
 */

const PREFIX = 'sk2_';

export function get(key, fallback) {
  try {
    const v = window.localStorage.getItem(PREFIX + key);
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

export function set(key, value) {
  try { window.localStorage.setItem(PREFIX + key, String(value)); } catch (e) { /* 容量不足などは諦める */ }
}

export function remove(key) {
  try { window.localStorage.removeItem(PREFIX + key); } catch (e) { /* 何もしない */ }
}

export function getJson(key, fallback) {
  try {
    const v = get(key, null);
    return v == null ? fallback : JSON.parse(v);
  } catch (e) {
    return fallback;
  }
}

export function setJson(key, value) {
  set(key, JSON.stringify(value));
}
