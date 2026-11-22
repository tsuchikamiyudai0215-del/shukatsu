/*
 * 下のタブバーと、区分の切り替えのつまみ。
 * 押したままにすると、つまみが持ち上がって指に付いてくる。離した所に一番近いボタンを選ぶ。
 */

export function attachLiquid(host, ids, onPick, isActive) {
  if (!host || host.dataset.liquid) return;
  host.dataset.liquid = '1';
  const pill = host.querySelector('.pill');
  if (!pill) return;

  let press = 0, lifted = false, startX = 0, lastX = 0, lastT = 0, vx = 0;
  let startVisualX = 0, rafId = 0, settleTimer = 0, moved = false, geo = null, swallow = false;

  const btns = () => ids.map((id) => document.getElementById(id)).filter(Boolean);
  const activeIndex = () => {
    const L = btns();
    for (let i = 0; i < L.length; i++) if (isActive(i)) return i;
    return 0;
  };
  const targets = () => {
    const originLeft = pill.offsetLeft || 4;
    return btns().map((b) => b.offsetLeft - originLeft);
  };

  /* 位置は、クラスを変える前に読む。変えたあとに読むと、その場で見た目の計算をさせてしまい、持ち上がる最初のコマが遅れる */
  function lift() {
    const t = targets(), i = activeIndex();
    lifted = true;
    lastT = Date.now(); vx = 0;
    startVisualX = t[i] !== undefined ? t[i] : 0;
    geo = { t, min: t[0], max: t[t.length - 1] };
    host.classList.add('lifted', 'grabbing');
    if (window.navigator.vibrate) try { window.navigator.vibrate(11); } catch (e) { /* 何もしない */ }
  }
  function renderMove() {
    rafId = 0;
    if (!lifted || !geo) return;
    const x = Math.max(geo.min, Math.min(geo.max, startVisualX + (lastX - startX)));
    const stretch = Math.max(-0.16, Math.min(0.16, vx * 0.06));
    pill.style.transform = 'translate3d(' + x + 'px,0,0) scaleX(' + (1 + Math.abs(stretch)).toFixed(3) +
      ') scaleY(' + (1 - Math.abs(stretch) * 0.55).toFixed(3) + ')';
  }
  function indexUnder(x) {
    const L = btns();
    for (let i = 0; i < L.length; i++) {
      const r = L[i].getBoundingClientRect();
      if (x >= r.left && x <= r.right) return i;
    }
    return -1;
  }
  function drop() {
    clearTimeout(press);
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (!lifted) { host.classList.remove('lifted', 'grabbing'); return; }
    lifted = false;
    /* どのボタンの上で離したかは、クラスを外す前に調べる（理由は lift と同じ） */
    let best;
    if (!moved) {
      best = indexUnder(lastX);
      if (best < 0) best = activeIndex();
    } else {
      const t = geo ? geo.t : targets(), x = startVisualX + (lastX - startX);
      best = 0;
      let bd = 1e9;
      t.forEach((tx, i) => { const d = Math.abs(tx - x); if (d < bd) { bd = d; best = i; } });
    }
    geo = null;
    host.classList.remove('lifted', 'grabbing');
    clearTimeout(settleTimer);
    host.classList.add('settling');
    pill.style.transform = '';
    settleTimer = setTimeout(() => host.classList.remove('settling'), 600);
    if (!isActive(best)) onPick(best);
    /* 指を滑らせて選んだあとの click は、別のボタンを押したことにしない */
    if (moved) { swallow = true; setTimeout(() => { swallow = false; }, 350); }
  }

  host.addEventListener('contextmenu', (e) => e.preventDefault());
  host.addEventListener('selectstart', (e) => e.preventDefault());
  host.addEventListener('click', (e) => {
    if (swallow) { e.preventDefault(); e.stopPropagation(); swallow = false; }
  }, true);
  host.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    startX = lastX = e.clientX; lastT = Date.now(); vx = 0; moved = false;
    clearTimeout(press);
    press = setTimeout(lift, 150);
  });
  host.addEventListener('pointermove', (e) => {
    /* 持ち上がる前は、長押しをやめるかどうかだけ見る。速さの計算は持ち上がってからでよい */
    if (!lifted) {
      if (Math.abs(e.clientX - startX) > 9) clearTimeout(press);
      return;
    }
    const t = Date.now(), dt = Math.max(1, t - lastT);
    vx = vx * 0.65 + ((e.clientX - lastX) / dt * 10) * 0.35;
    lastX = e.clientX; lastT = t;
    if (Math.abs(e.clientX - startX) > 8) moved = true;
    e.preventDefault();
    if (!rafId) rafId = requestAnimationFrame(renderMove);
  });
  host.addEventListener('pointerup', drop);
  host.addEventListener('pointercancel', drop);
  host.addEventListener('pointerleave', () => { if (lifted) drop(); else clearTimeout(press); });
}
