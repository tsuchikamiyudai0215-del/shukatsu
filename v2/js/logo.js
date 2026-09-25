/*
 * 会社ロゴ。
 *
 * 優先順：この端末で選んだ画像ファイル → シートの logo 列（手動の URL か、自動で見つけたもの）→ ドメインのファビコン。
 * logo 列が空の会社は、裏で次の順に探して保存する。
 *   Wikidata の公式ロゴ → DuckDuckGo で有無を確かめて Google の256px版 → サイト直下の favicon.ico → Wikipedia の画像
 * 採用管理システムのドメインは別の会社の印になるので、ロゴ探しに使わない。
 * Wikidata などへ一度に投げすぎないよう、同時に探すのは3件まで。
 */
import { html, safeUrl, replaceHtml } from './html.js';
import * as storage from './storage.js';
import * as store from './store.js';

const L = {};

export function resetLogos() {
  /* 起動し直したら、前の起動の探し物は途中で捨てる */
  L.gen = (L.gen || 0) + 1;
  L.ok = new Set();         // 一度表示できた URL（描き直しのちらつきを防ぐ）
  L.tried = new Set();      // 探しに行った会社
  L.queue = [];
  L.running = 0;
  L.files = storage.getJson('file_logos', {});   // id → 端末で選んだ画像（data URL）
  L.onChange = null;
}

export function onLogoChange(fn) { L.onChange = fn; }

// ============================================================
// ドメイン
// ============================================================

function hostOf(url) {
  const m = String(url || '').match(/^https?:\/\/(?:www\.)?([^\/?#:]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/* co.jp のように実質2階層の接尾辞。ここまでを会社のドメインとみなす */
const SLD = ['co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'gr.jp', 'co.uk', 'com.au', 'co.kr', 'com.cn', 'com.tw', 'co.th', 'com.sg'];
function apexOf(host) {
  const p = String(host).split('.');
  if (p.length <= 2) return host;
  return p.slice(SLD.includes(p.slice(-2).join('.')) ? -3 : -2).join('.');
}

const ATS = ['rikunabi', 'mynavi', 'recruit.co.jp', 'en-japan', 'doda', 'wantedly', 'openwork', 'jobcan', 'hrmos',
  'herp', 'talentio', 'sonar', 'i-web', 'axol', 'e-syutsugan', 'entryweb', 'career-tasu', 'onecareer', 'offerbox',
  'unistyle', 'gyakukyujin', 'shukatsu', 'job-', 'saiyo', 'workscircle', 'goodfind', 'type.jp', 'athuman', 'jinzai',
  'recme', 'ats-', 'successfactors', 'taleo', 'workday', 'greenhouse', 'lever.co', 'smartrecruiters'];
function looksLikeAts(host) {
  if (!host) return true;
  const h = String(host).toLowerCase();
  return ATS.some((x) => h.includes(x));
}

function pushDomain(list, host) {
  if (!host || looksLikeAts(host)) return list;
  [host, apexOf(host)].forEach((d) => { if (d && !list.includes(d)) list.push(d); });
  return list;
}

export function logoDomains(c) {
  const list = [];
  const dom = c.domain ? String(c.domain).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase() : null;
  pushDomain(list, dom);
  pushDomain(list, hostOf(c.url));
  return list;
}

const ddgIcon = (d) => 'https://icons.duckduckgo.com/ip3/' + encodeURIComponent(d) + '.ico';
const gIcon = (d) => 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(d) + '&sz=256';
const siteIcon = (d) => 'https://' + d + '/favicon.ico';

// ============================================================
// 表示
// ============================================================

function isManual(c) { return !!L.files[c.id] || !!c.logoManual; }

export function logoUrl(c) {
  if (L.files[c.id]) return L.files[c.id];
  if (c.logo && c.logo !== 'none') return c.logo;
  const doms = logoDomains(c);
  return doms.length ? ddgIcon(doms[0]) : null;
}

/* 手動で入れた値（設定欄に出す用）。画像ファイルは長いので出さない */
export function manualValue(c) {
  return c.logo && c.logo !== 'none' ? c.logo : '';
}

function mono(c, s) {
  return html`<div class="logo mono" style="width:${s}px;height:${s}px;border-radius:${s / 2}px" data-id="${c.id}" data-sz="${s}"><span style="font-size:${Math.round(s * 0.42)}px">${String(c.name || '').slice(0, 1)}</span></div>`;
}

function imgBox(c, s, u) {
  return html`<div class="logo${L.ok.has(u) ? ' rdy' : ''}" style="width:${s}px;height:${s}px;border-radius:${s / 2}px" data-id="${c.id}" data-sz="${s}" data-doms="${logoDomains(c).join(',')}"><img decoding="sync" referrerpolicy="no-referrer" src="${safeUrl(u)}"></div>`;
}

export function logo(c, size) {
  const s = size || 28;
  const u = logoUrl(c);
  return u ? imgBox(c, s, u) : mono(c, s);
}

/* 画像が読めたら白い下地にする。main.js が load を拾って呼ぶ */
export function logoLoaded(img) {
  if (img.src) L.ok.add(img.getAttribute('src'));
  const b = img.parentNode;
  if (b && b.classList) b.classList.add('rdy');
}

/* 読めなかったら、その場で次の候補へ差し替える。同じ URL は繰り返さない */
export function logoFailed(img) {
  const b = img.parentNode;
  if (!b || !b.dataset) return;
  const c = store.company(b.dataset.id) || { id: b.dataset.id, name: '' };
  const s = parseFloat(b.dataset.sz) || 28;
  const toMono = () => replaceHtml(b, mono(c, s));
  /* 手動で指定した画像が壊れているときは、勝手に別の画像にしない */
  if (isManual(c)) return toMono();

  const doms = (b.dataset.doms || '').split(',').filter(Boolean);
  const chain = doms.map(ddgIcon).concat(doms.map(gIcon));
  let step = parseInt(b.dataset.step || '0', 10);
  const failed = img.getAttribute('src');
  while (step < chain.length && chain[step] === failed) step++;
  if (step < chain.length) {
    b.dataset.step = String(step + 1);
    b.classList.remove('rdy');
    img.src = chain[step];
    return;
  }
  toMono();
}

function paint(c) {
  const u = logoUrl(c);
  document.querySelectorAll('.logo[data-id]').forEach((b) => {
    if (b.dataset.id !== c.id) return;
    const s = parseFloat(b.dataset.sz) || 28;
    replaceHtml(b, u ? imgBox(c, s, u) : mono(c, s));
  });
}

// ============================================================
// 探す
// ============================================================

function probe(url, ms) {
  return new Promise((resolve) => {
    if (!url) return resolve(false);
    const img = new window.Image();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(t); resolve(ok); };
    const t = setTimeout(() => { img.src = ''; finish(false); }, ms || 3500);
    /* 1×1 の透明な画像を返すサービスがあるので、小さすぎるものは失敗とみなす */
    img.onload = () => finish(img.naturalWidth > 2 && img.naturalHeight > 2);
    img.onerror = () => finish(false);
    img.referrerPolicy = 'no-referrer';
    img.src = url;
  });
}

async function getJson(url) {
  try { return await (await window.fetch(url)).json(); } catch (e) { return null; }
}

export function cleanName(name) {
  return String(name || '')
    .replace(/[\(（](?:株|有|社|合|資)[\)）]/g, '')
    .replace(/株式会社|有限会社|合同会社|合資会社|合名会社/g, '')
    .replace(/グループ|ホールディングス|HD/ig, '')
    .trim();
}

/* 会社名の候補。追加フォームで使う */
export async function wdSuggest(q) {
  const j = await getJson('https://www.wikidata.org/w/api.php?action=wbsearchentities&search=' +
    encodeURIComponent(q) + '&language=ja&uselang=ja&type=item&limit=6&format=json&origin=*');
  return ((j && j.search) || []).map((x) => ({ id: x.id, label: x.label || '', desc: x.description || '' }))
    .filter((x) => x.label);
}

/* Wikidata の公式ロゴ（P154）と公式サイト（P856） */
export async function wdClaims(id) {
  const j = await getJson('https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=' + encodeURIComponent(id) +
    '&property=P154|P856&format=json&origin=*');
  if (!j) return null;
  const val = (p) => {
    const c = j.claims && j.claims[p] && j.claims[p][0];
    return c && c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value;
  };
  const file = val('P154');
  return {
    logoUrl: file ? 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(file) + '?width=240' : null,
    domain: hostOf(val('P856'))
  };
}

async function wdLogoAndSite(name) {
  const queries = [cleanName(name)];
  if (queries[0] !== name) queries.push(name);
  const out = { logoUrl: null, domain: null };
  for (const q of queries) {
    const j = await getJson('https://www.wikidata.org/w/api.php?action=wbsearchentities&search=' +
      encodeURIComponent(q) + '&language=ja&uselang=ja&type=item&limit=2&format=json&origin=*');
    for (const x of (j && j.search) || []) {
      const c = await wdClaims(x.id);
      if (!c) continue;
      if (!out.logoUrl && c.logoUrl) out.logoUrl = c.logoUrl;
      if (!out.domain && c.domain) out.domain = c.domain;
      if (out.logoUrl && out.domain) return out;
    }
    if (out.logoUrl || out.domain) return out;
  }
  return out;
}

async function wpThumb(name) {
  const j = await getJson('https://ja.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=' +
    encodeURIComponent(cleanName(name)) + '&gsrlimit=1&prop=pageimages&piprop=thumbnail&pithumbsize=200&format=json&origin=*');
  const pages = j && j.query && j.query.pages;
  if (pages) for (const k in pages) if (pages[k].thumbnail && pages[k].thumbnail.source) return pages[k].thumbnail.source;
  return null;
}

export async function resolveBest(c) {
  let doms = logoDomains(c);
  const wd = await wdLogoAndSite(c.name);
  if (wd.logoUrl && await probe(wd.logoUrl, 3000)) return wd.logoUrl;
  if (wd.domain) doms = pushDomain(doms, wd.domain);
  /* DuckDuckGo は無ければ失敗するので「あるか」の確認に使い、出すのは解像度の高い Google の方 */
  for (const d of doms) if (await probe(ddgIcon(d), 2500)) return gIcon(d);
  for (const d of doms) if (await probe(siteIcon(d), 2500)) return siteIcon(d);
  const wt = await wpThumb(c.name);
  if (wt && await probe(wt, 3000)) return wt;
  /* 最後の受け皿。Google は何かしら返すので、成否は見ない */
  if (doms.length) return gIcon(doms[0]);
  return 'none';
}

function pump() {
  while (L.running < 3 && L.queue.length) {
    const task = L.queue.shift();
    L.running++;
    task().catch(() => {}).then(() => { L.running--; pump(); });
  }
}

/* logo 列が空の会社のロゴを、裏で探して保存する */
export function hydrate(list) {
  list.forEach((c) => {
    if (c.kind === 'mgmt' || c.logo || isManual(c) || L.tried.has(c.id)) return;
    L.tried.add(c.id);
    const gen = L.gen;
    L.queue.push(async () => {
      if (gen !== L.gen) return;
      const url = await resolveBest(c);
      if (gen !== L.gen) return;
      const now = store.company(c.id);
      /* 探している間に手動で入れられたら、上書きしない */
      if (!now || isManual(now) || now.logo) return;
      store.setLogoLocal(c.id, url, false);
      if (url !== 'none') paint(store.company(c.id));
      await store.saveLogo(c.id, url, false).catch(() => {});
    });
  });
  pump();
}

/* 設定欄から。手動の URL はシートにも保存する */
export async function setManualUrl(id, url) {
  delete L.files[id];
  storage.setJson('file_logos', L.files);
  L.tried.add(id);
  store.setLogoLocal(id, url, true);
  if (L.onChange) L.onChange();
  await store.saveLogo(id, url, true);
}

export async function refetch(id) {
  delete L.files[id];
  storage.setJson('file_logos', L.files);
  L.tried.add(id);
  const c = store.company(id);
  if (!c) return 'none';
  store.setLogoLocal(id, '', false);
  const url = await resolveBest(Object.assign({}, c, { logo: '' }));
  store.setLogoLocal(id, url, false);
  if (L.onChange) L.onChange();
  await store.saveLogo(id, url, false).catch(() => {});
  return url;
}

/* 画像ファイルから。96px の正方形に縮めて、この端末にだけ置く（シートには大きすぎて入らない） */
export function fromFile(file, id) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('画像ファイルを選んでください。'));
    if (!/^image\//.test(file.type)) return reject(new Error('画像ファイルを選んでください。'));
    if (file.size > 8 * 1024 * 1024) return reject(new Error('画像が大きすぎます（8MBまで）。'));
    const fr = new window.FileReader();
    fr.onerror = () => reject(new Error('画像を読み込めませんでした。'));
    fr.onload = () => {
      const img = new window.Image();
      img.onerror = () => reject(new Error('画像を読み込めませんでした。'));
      img.onload = () => {
        try {
          const N = 96;
          const cv = document.createElement('canvas');
          cv.width = N; cv.height = N;
          const r = Math.min(N / img.naturalWidth, N / img.naturalHeight);
          const w = Math.round(img.naturalWidth * r), h = Math.round(img.naturalHeight * r);
          cv.getContext('2d').drawImage(img, Math.round((N - w) / 2), Math.round((N - h) / 2), w, h);
          L.files[id] = cv.toDataURL('image/png');
          storage.setJson('file_logos', L.files);
          L.tried.add(id);
          if (L.onChange) L.onChange();
          resolve();
        } catch (e) {
          reject(new Error('画像を変換できませんでした。'));
        }
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

/**
 * 旧版の画面で手で入れたロゴ（旧版の端末保存 sk_manual_logos。会社名 → 画像）を、一度だけ新版へ写す。
 * 旧版は会社名で、新版は id で覚えるので、会社の一覧が届いてから名前で対応させる（両方の区分に入れる）。
 * 画像ファイル（data URL）はシートに入らない大きさなので、この端末の保存にだけ写す。手動の扱いになる。
 * https の URL はシートにも手動として保存する。旧版の保存は消さない。
 */
export function importLegacyManual(list) {
  if (storage.get('legacy_logos_done', '') === '1' || !list.length) return;
  let src = null;
  try { src = JSON.parse(storage.getLegacy('sk_manual_logos') || 'null'); } catch (e) { src = null; }
  storage.set('legacy_logos_done', '1');
  if (!src || typeof src !== 'object') return;
  Object.keys(src).forEach((name) => {
    const v = String(src[name] || '');
    list.filter((c) => c.name === name).forEach((c) => {
      if (/^data:image\//i.test(v)) {
        L.files[c.id] = v;
        L.tried.add(c.id);
      } else if (/^https:\/\//i.test(v)) {
        L.tried.add(c.id);
        store.setLogoLocal(c.id, v, true);
        store.saveLogo(c.id, v, true).catch(() => {});
      }
    });
  });
  storage.setJson('file_logos', L.files);
}

export function forgetLogo(id) {
  if (L.files[id]) { delete L.files[id]; storage.setJson('file_logos', L.files); }
}
