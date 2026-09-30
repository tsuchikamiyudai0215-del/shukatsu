/*
 * 選考ルートの行の指の動き。≡をつかんで上下に動かすと並べ替え、行を左右にスワイプすると削除。
 * 決まったら onMove(from, to) か onRemove(i) を呼ぶだけで、保存や確かめは呼んだ側が行う。
 * 行は .rrow[data-i]、つかむところは .rgrip。行の間に「つなぐ／切る」の段があるので、
 * すき間を空けるときは「となりの行の位置」まで動かす（行の高さ分だけ動かすと、段の分ずれる）。
 */

/* これより横に動いたらスワイプとみなす。縦のスクロールと取り違えないよう、横の方が大きいときだけ */
const SWIPE_START = 10;
/* これより横に払ったら削除する */
const SWIPE_REMOVE = 96;

export function bindReorder(list, { onMove, onRemove }) {
  if (!list || list.dataset.bound) return;
  list.dataset.bound = '1';
  const rows = () => Array.from(list.querySelectorAll('.rrow[data-i]'));

  // ------------------------------------------------------------
  // ≡ をつかんで並べ替え
  // ------------------------------------------------------------
  let drag = null;

  list.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest && e.target.closest('.rgrip');
    if (!grip || drag) return;
    const row = grip.closest('.rrow');
    const all = rows();
    const from = all.indexOf(row);
    if (from < 0) return;
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch (err) { /* 取れなくても動く */ }
    drag = { id: e.pointerId, grip, row, all, from, to: from, y0: e.clientY,
      tops: all.map((r) => r.getBoundingClientRect().top), h: row.getBoundingClientRect().height };
    row.classList.add('lift');
    /* 動かしている間は、裏の再取得で描き直さない（入力中と同じ扱い） */
    document.body.classList.add('route-dragging');
  });

  list.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    const { all, from, tops, h } = drag;
    drag.row.style.transform = 'translate3d(0,' + dy + 'px,0)';
    /* つかんだ行の真ん中が、どの行の真ん中を越えたかで行き先を決める */
    const mid = tops[from] + dy + h / 2;
    let to = from;
    for (let k = 0; k < all.length; k++) {
      if (k === from) continue;
      const c = tops[k] + h / 2;
      if (k > from && mid > c) to = k;
      if (k < from && mid < c && to === from) to = k;
    }
    drag.to = to;
    all.forEach((r, k) => {
      if (k === from) return;
      let shift = 0;
      if (to > from && k > from && k <= to) shift = tops[k - 1] - tops[k];
      if (to < from && k >= to && k < from) shift = tops[k + 1] - tops[k];
      r.style.transform = shift ? 'translate3d(0,' + shift + 'px,0)' : '';
    });
  });

  const endDrag = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const { all, from, to } = drag;
    drag = null;
    all.forEach((r) => { r.style.transform = ''; r.classList.remove('lift'); });
    document.body.classList.remove('route-dragging');
    if (to !== from) onMove(from, to);
  };
  list.addEventListener('pointerup', endDrag);
  list.addEventListener('pointercancel', endDrag);

  // ------------------------------------------------------------
  // 行を左右にスワイプして削除
  // ------------------------------------------------------------
  let sw = null;

  list.addEventListener('pointerdown', (e) => {
    if (drag || sw) return;
    if (e.target.closest && e.target.closest('.rgrip, .rminus')) return;
    const row = e.target.closest && e.target.closest('.rrow[data-i]');
    if (!row) return;
    sw = { id: e.pointerId, row, x0: e.clientX, y0: e.clientY, on: false, dx: 0 };
  });

  list.addEventListener('pointermove', (e) => {
    if (!sw || e.pointerId !== sw.id) return;
    const dx = e.clientX - sw.x0, dy = e.clientY - sw.y0;
    if (!sw.on) {
      if (Math.abs(dy) > SWIPE_START && Math.abs(dy) >= Math.abs(dx)) { sw = null; return; }   // 縦のスクロール
      if (Math.abs(dx) < SWIPE_START) return;
      sw.on = true;
      sw.row.classList.add('swipe');
    }
    sw.dx = dx;
    sw.row.style.transform = 'translate3d(' + dx + 'px,0,0)';
    sw.row.classList.toggle('far', Math.abs(dx) > SWIPE_REMOVE);
  });

  const endSwipe = (e) => {
    if (!sw || (e && e.pointerId !== sw.id)) return;
    const { row, on, dx } = sw;
    sw = null;
    if (!on) return;
    row.classList.remove('swipe', 'far');
    row.style.transform = '';
    /* スワイプのあとに来る click で、現在地が変わらないようにする */
    row.dataset.swiped = '1';
    setTimeout(() => { delete row.dataset.swiped; }, 350);
    if (Math.abs(dx) > SWIPE_REMOVE) onRemove(rows().indexOf(row));
  };
  list.addEventListener('pointerup', endSwipe);
  list.addEventListener('pointercancel', endSwipe);
}
