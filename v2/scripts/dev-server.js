/*
 * 手元で画面を試すためのサーバー。Google には一切つながない。
 *
 *   node v2/scripts/dev-server.js   → http://localhost:8787/v2/
 *
 * ・リポジトリの一番上を配る（新版の画面は /v2/、アイコンは一番上にあるため）
 * ・POST /api は、GAS のコードを模擬環境（test/gas_mock.js）で動かして答える
 * ・中のデータは作り物の会社。止めると消える
 * 接続設定には URL「http://localhost:8787/api」と鍵「dev-key」を入れる。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { mk } = require('../test/gas_mock.js');

const PORT = +process.env.PORT || 8787;
const ROOT = path.join(__dirname, '..', '..');
const T = mk({ API_KEY: 'dev-key' });

const pad = (n) => ('0' + n).slice(-2);
/* 今から days 日後の日本時間の文字列 */
function at(days, hh, mm) {
  const d = new Date(Date.now() + 9 * 3600000 + days * 86400000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + 'T' + pad(hh) + ':' + pad(mm);
}

function seed() {
  const add = (f) => T.api('addCompany', f).company;
  const op = (c, o, args) => T.api('mutate', { id: c.id, op: o, args: args || {}, updatedAt: T.api('getData', {}).companies.find((x) => x.id === c.id).updatedAt });
  add({ name: 'テストセンター', kind: 'mgmt', stage: 'テスト', dueAt: at(5, 10, 0) });
  const a = add({ name: '株式会社サンプル商事', url: 'https://example.com/mypage', loginId: 'sample01', pw: 'dev-password', dueAt: at(1, 23, 59), stage: 'ES', domain: 'mitsubishicorp.com' });
  add({ name: 'テスト銀行', dueAt: at(6, 12, 0), stage: 'ES', domain: 'mufg.jp' });
  add({ name: 'ダミー電機株式会社', dueAt: at(12, 17, 0), stage: '面接', domain: 'panasonic.com' });
  const w = add({ name: 'モック通信', stage: 'テスト', domain: 'kddi.com' });
  op(w, 'done');
  const o = add({ name: '架空航空', stage: '面接', domain: 'ana.co.jp' });
  op(o, 'pass');
  const f = add({ name: '仮置きシステムズ', stage: '面接', industry: 'IT・SIer' });
  op(f, 'fail');
  const s = add({ name: '見送り物産', stage: 'ES' });
  op(s, 'skip');
  T.api('addEvent', { companyId: a.id, kind: '説明会', startAt: at(3, 13, 0), endAt: at(3, 14, 30), place: 'オンライン' });
  T.api('addEvent', { companyId: o.id, kind: 'インターン', startAt: at(9, 10, 0), endAt: at(11, 17, 0), daily: true });
  const r = add({ name: 'サンプル商事', term: '本選考', stage: 'ES', dueAt: at(20, 23, 59), domain: 'mitsubishicorp.com' });
  void r;
}
seed();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/api') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let out;
      try { out = T.ctx.route_(JSON.parse(body)); } catch (e) { out = JSON.stringify({ ok: false, error: 'bad payload' }); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(out);
    });
    return;
  }
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(PORT, () => console.log('http://localhost:' + PORT + '/v2/'));
