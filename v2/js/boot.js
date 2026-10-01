/*
 * ページから読み込む入口。main.js は読み込んだだけでは動かないので（テストで起動し直すため）、ここで始める。
 */
import { start, settlePills } from './main.js';

start();
/* ページに直接書いた「始まらなかったとき」の見張りに、始まったことを知らせる */
window.__started = true;
window.addEventListener('load', settlePills);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(settlePills);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
