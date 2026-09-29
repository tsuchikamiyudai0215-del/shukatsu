/*
 * 切り替えの日に一番上の index.html へ写す、差し替え用のページのテスト。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '../cutover/root-index.html'), 'utf8');
const ROOT = 'https://tsuchikamiyudai0215-del.github.io/shukatsu/index.html';

test('一番上に置くと、location.replace で /shukatsu/v2/ へ移る（履歴を増やさない）', () => {
  let replaced = null, assigned = false;
  const dom = new JSDOM(SRC.replace(/<script>[\s\S]*?<\/script>/, ''), { url: ROOT + '?from=icon#x' });
  const w = dom.window;
  const fake = { search: w.location.search, hash: w.location.hash, replace: (u) => { replaced = new URL(u, ROOT).href; } };
  Object.defineProperty(fake, 'href', { set: () => { assigned = true; } });
  const code = SRC.match(/<script>([\s\S]*?)<\/script>/)[1];
  new Function('location', code)(fake);
  assert.equal(replaced, 'https://tsuchikamiyudai0215-del.github.io/shukatsu/v2/?from=icon#x');
  assert.equal(assigned, false);
  w.close();
});

test('JavaScript が動かないときのために、/v2/ へのリンクを置く', () => {
  const dom = new JSDOM(SRC, { url: ROOT });
  const a = dom.window.document.querySelector('a');
  assert.equal(a.href, 'https://tsuchikamiyudai0215-del.github.io/shukatsu/v2/');
  dom.window.close();
});

test('移る前に白い画面を出さない：html に暗い色を書き、暗い画面として扱う印を付ける', () => {
  /* <head> の中ですぐ移るので body はできない。html の色が無いと、/v2/ が届くまで白くなる */
  assert.match(SRC, /html\s*\{\s*background:\s*#04040A;?\s*\}/);
  assert.match(SRC, /<meta name="color-scheme" content="dark">/);
});

test('一番上の index.html は、この下書きと同じ中身にしてある', () => {
  const root = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.equal(root.replace(/\r/g, ''), SRC.replace(/\r/g, ''));
});
