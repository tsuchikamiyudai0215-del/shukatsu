/*
 * shared/domain.js を gas/ へ写す。GAS は ES モジュールを読めないので、同じファイルを置いて使う。
 * 写し忘れはテスト（gas.test.js）で見つかる。
 */
const fs = require('node:fs');
const path = require('node:path');

const from = path.join(__dirname, '..', 'shared', 'domain.js');
const to = path.join(__dirname, '..', 'gas', 'domain.js');
fs.copyFileSync(from, to);
console.log('shared/domain.js → gas/domain.js');
