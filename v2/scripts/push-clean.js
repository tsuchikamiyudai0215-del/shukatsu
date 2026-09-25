/*
 * 手元で消したファイルを、GAS の上からも消して送る。
 *
 * clasp push は、手元にあるファイルが GAS と同じなら「もう最新」として何も送らない。
 * 手元で消したファイル（一時ファイルなど）は比べる対象に入らないので、GAS の上に残ってしまう。
 * 送るときは GAS の上を手元のファイルで丸ごと置き換えるので、わざと1か所だけ変えて送り、
 * 元に戻してもう一度送る。最後は GAS の上が手元と同じになる。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const file = path.join(__dirname, '..', 'gas', 'util.js');
const orig = fs.readFileSync(file, 'utf8');
const run = () => execSync('npx clasp push --force', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });

execSync('node scripts/sync.js', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
try {
  fs.writeFileSync(file, orig + '\n');
  run();
} finally {
  fs.writeFileSync(file, orig);
}
run();
console.log('GAS の上を手元のファイルと同じにしました。');
