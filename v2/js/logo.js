/*
 * 会社ロゴ。
 *
 * 優先順：この端末で選んだ画像ファイル → シートの logo 列（手動の URL か、自動で見つけたもの）→ ドメインのファビコン。
 * logo 列が空の会社は、裏で次の順に探して保存する。どれも無ければ頭文字にする。
 *   Wikidata の公式ロゴ → サイト直下の favicon.ico → Wikipedia のロゴらしい画像
 * DuckDuckGo と Google のアイコンは、アイコンの無いサイトにも代わりの絵（地球儀など）を返し、
 * 本物かどうかを画面から見分けられないので、探すときには使わない
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
  L.pool = new Map();       // URL → 読み終わった img（描き直しで使い回す）
  L.tried = new Set();      // 探しに行った会社
  L.queue = [];
  L.running = 0;
  L.files = storage.getJson('file_logos', {});   // id → 端末で選んだ画像（data URL）
  L.onChange = null;
  wmNext = 0;
  wmPause = 0;
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
  /* 探して見つからなかった会社は頭文字。ドメインのアイコンは、無くても代わりの絵が出てしまうので使わない */
  if (c.logo === 'none') return null;
  if (c.logo) return c.logo;
  /* 探し終わるまでのつなぎ */
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

/* 画像は描くのを止めずに読み解く（async）。sync にすると、切り替えのたびに最大60枚を読み解き終えるまで描けず、iPhone では重い。
   一度読めた画像は keepLogos で使い回すので、描き直しで白く飛ぶことはない */
function imgBox(c, s, u) {
  return html`<div class="logo${L.ok.has(u) ? ' rdy' : ''}" style="width:${s}px;height:${s}px;border-radius:${s / 2}px" data-id="${c.id}" data-sz="${s}" data-doms="${logoDomains(c).join(',')}"><img decoding="async" referrerpolicy="no-referrer" src="${safeUrl(u)}"></div>`;
}

export function logo(c, size) {
  const s = size || 28;
  const u = logoUrl(c);
  return u ? imgBox(c, s, u) : mono(c, s);
}

/* 読み終わったロゴの画像を取っておく数。1つの URL に、一覧と詳細などで同時に出る分があれば足りる */
const POOL_PER_URL = 3;

/**
 * root の中を render で描き直すとき、読み終わっているロゴの画像は作り直さずに使い回す。
 * 作り直すと、長く開いたあとなどはブラウザが画像を捨てていて読み直しになり、その間は白い丸だけが見える（白飛び）。
 * 記録タブのようにロゴの無い画面を挟んでも使い回せるよう、画面から外れた画像も取っておく
 */
export function keepLogos(root, render) {
  if (root) {
    root.querySelectorAll('.logo img').forEach((img) => {
      if (!img.complete || !img.naturalWidth) return;
      const k = img.getAttribute('src');
      const list = L.pool.get(k) || [];
      if (!list.includes(img)) list.push(img);
      L.pool.set(k, list.slice(-POOL_PER_URL));
    });
  }
  render();
  if (!root) return;
  root.querySelectorAll('.logo img').forEach((img) => {
    const list = L.pool.get(img.getAttribute('src'));
    const spare = list && list.find((x) => !x.isConnected);
    if (!spare) return;
    const box = img.parentNode;
    img.replaceWith(spare);
    if (box && box.classList) box.classList.add('rdy');
  });
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

/* 画像が読めたら true。1×1 の透明な画像を返すサービスがあるので、小さすぎるものは失敗とみなす */
function probe(url, ms) {
  return new Promise((resolve) => {
    if (!url) return resolve(false);
    const img = new window.Image();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(t); resolve(ok); };
    const t = setTimeout(() => { img.src = ''; finish(false); }, ms || 3500);
    img.onload = () => finish(img.naturalWidth > 2 && img.naturalHeight > 2);
    img.onerror = () => finish(false);
    img.referrerPolicy = 'no-referrer';
    img.src = url;
  });
}

/* Wikidata・Wikipedia に断られた（多すぎる・落ちている・圏外）ときの印。
   「見つからなかった」とは分けて、見つからなかったと保存しないようにする */
const FAIL = { failed: true };
/* 続けて問い合わせるときの間。一度に投げると「多すぎる」と断られ、そのあとの会社が全部見つからなくなる */
const WM_GAP_MS = 600;
/* 断られたら、しばらく問い合わせを止める */
const WM_PAUSE_MS = 60000;
let wmNext = 0;
let wmPause = 0;

/* soon は、追加の画面の候補のように人が待っているもの。間を空けずに送る（止めている間は送らない） */
async function getJson(url, soon) {
  const now = Date.now();
  if (wmPause > now) return FAIL;
  if (!soon) {
    const at = Math.max(now, wmNext);
    wmNext = at + WM_GAP_MS;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
    if (wmPause > Date.now()) return FAIL;
  }
  try {
    const res = await window.fetch(url);
    if (res.status === 429 || res.status >= 500) { wmPause = Date.now() + WM_PAUSE_MS; return FAIL; }
    if (res.ok === false) return FAIL;
    return await res.json();
  } catch (e) { return FAIL; }
}

/* ロゴを探すときの社名。カッコ書き（「（One to One Career）」のようなコース名や「(株)」）は外す。
   付いたままだと Wikidata でも Wikipedia でも見つからず、同じ会社の別コースだけロゴが出なくなる */
export function cleanName(name) {
  return String(name || '')
    .replace(/[\(（][^\(\)（）]*[\)）]/g, '')
    .replace(/株式会社|有限会社|合同会社|合資会社|合名会社/g, '')
    .replace(/グループ|ホールディングス|HD/ig, '')
    .trim();
}

/* 会社名の候補。追加フォームで使う。人が待っているので、間を空けずに引く */
export async function wdSuggest(q) {
  const j = await getJson('https://www.wikidata.org/w/api.php?action=wbsearchentities&search=' +
    encodeURIComponent(q) + '&language=ja&uselang=ja&type=item&limit=6&format=json&origin=*', true);
  return ((j && j.search) || []).map((x) => ({ id: x.id, label: x.label || '', desc: x.description || '' }))
    .filter((x) => x.label);
}

/* 何件かの項目の公式ロゴ（P154）と公式サイト（P856）を、1回の問い合わせでまとめて引く。断られたら FAIL。
   wbgetclaims は1回に1つの性質しか引けず、2つ並べると何も返らないので使わない */
async function wdEntities(ids, soon) {
  const j = await getJson('https://www.wikidata.org/w/api.php?action=wbgetentities&ids=' +
    ids.map(encodeURIComponent).join('|') + '&props=claims&format=json&origin=*', soon);
  if (j === FAIL) return FAIL;
  const ents = (j && j.entities) || {};
  return ids.map((id) => {
    const claims = (ents[id] && ents[id].claims) || {};
    const val = (p) => {
      const c = claims[p] && claims[p][0];
      return c && c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value;
    };
    const file = val('P154');
    return {
      logoUrl: file ? 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(file) + '?width=240' : null,
      domain: hostOf(val('P856'))
    };
  });
}

/* 追加の画面で選んだ項目の公式ロゴと公式サイト */
export async function wdClaims(id, soon) {
  const list = await wdEntities([id], soon);
  return list === FAIL ? FAIL : list[0];
}

/* 社名で Wikidata を引き、公式ロゴを持つ項目を優先する。
   「NTT」で最初にインドネシアの州が出るように、会社でない項目が先に来ることがあるため。
   ロゴがどれにも無ければ、公式サイトを持つ最初の項目のドメインを使う */
export async function wdLogoAndSite(name) {
  const queries = [cleanName(name)];
  if (queries[0] !== name) queries.push(name);
  const out = { logoUrl: null, domain: null, failed: false };
  for (const q of queries) {
    const j = await getJson('https://www.wikidata.org/w/api.php?action=wbsearchentities&search=' +
      encodeURIComponent(q) + '&language=ja&uselang=ja&type=item&limit=3&format=json&origin=*');
    if (j === FAIL) { out.failed = true; return out; }
    const ids = ((j && j.search) || []).map((x) => x.id).filter(Boolean);
    if (!ids.length) continue;
    const list = await wdEntities(ids);
    if (list === FAIL) { out.failed = true; return out; }
    const withLogo = list.find((x) => x.logoUrl);
    if (withLogo) return Object.assign(out, { logoUrl: withLogo.logoUrl, domain: withLogo.domain });
    const withSite = list.find((x) => x.domain);
    if (withSite) return Object.assign(out, { domain: withSite.domain });
  }
  return out;
}

/* Wikipedia の記事の画像。ロゴらしいファイル名のものだけ（建物の写真などは使わない） */
async function wpThumb(name) {
  const j = await getJson('https://ja.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=' +
    encodeURIComponent(cleanName(name)) + '&gsrlimit=1&prop=pageimages&piprop=thumbnail&pithumbsize=200&format=json&origin=*');
  if (j === FAIL) return FAIL;
  const pages = j && j.query && j.query.pages;
  if (pages) {
    for (const k in pages) {
      const src = pages[k].thumbnail && pages[k].thumbnail.source;
      if (src && !Domain.isWikipediaPhoto(src)) return src;
    }
  }
  return null;
}

/**
 * いちばん良さそうなロゴの URL を探す。何も無ければ 'none'。
 * 途中で断られて探し切れなかったときは null（見つからなかったと保存せず、次に開いたときに探し直す）
 */
export async function resolveBest(c) {
  let doms = logoDomains(c);
  const wd = await wdLogoAndSite(c.name);
  if (wd.logoUrl && await probe(wd.logoUrl, 3000)) return wd.logoUrl;
  if (wd.domain) doms = pushDomain(doms, wd.domain);
  /* サイト直下の favicon.ico は、無ければ読み込みに失敗するので、あるかどうかを確かめられる */
  for (const d of doms) if (await probe(siteIcon(d), 2500)) return siteIcon(d);
  const wt = wd.failed ? FAIL : await wpThumb(c.name);
  if (wt && wt !== FAIL && await probe(wt, 3000)) return wt;
  if (wd.failed || wt === FAIL) return null;
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
      /* 断られて探し切れなかった。この起動の間はもう探さず、次に開いたときにやり直す */
      if (url == null) return;
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
  /* 探し切れなかったときは、前のロゴに戻して保存しない */
  if (url == null) {
    store.setLogoLocal(id, c.logo, !!c.logoManual);
    if (L.onChange) L.onChange();
    return null;
  }
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
  if (!list.length) return;
  if (storage.get('legacy_logos_done', '') === '1') {
    /* 写した画像の会社が、今の一覧に1つも無い。シートを移し直して id が変わったので、写し直す */
    const keys = Object.keys(L.files);
    const ids = new Set(list.map((c) => c.id));
    if (!keys.length || keys.some((k) => ids.has(k))) return;
    L.files = {};
  }
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
