/* 画面の部品（js）が読み込めずにアプリが始まらないと、読み込みの画面のまま止まる。
   部品が無くても動くよう、これだけは module にせず、ほかの部品を頼らずに書く。10秒たっても始まっていなければ「再読み込み」を出す。
   ページに直接書かずにファイルにしているのは、読み込みの制限（CSP）でページの中に書いたスクリプトを全部止めているため */
setTimeout(function () {
  if (window.__started) return;
  var more = document.getElementById('splashMore');
  if (!more) return;
  var t = document.createElement('div');
  t.textContent = '画面を読み込めませんでした。';
  var b = document.createElement('button');
  b.className = 'gh';
  b.textContent = '再読み込み';
  b.addEventListener('click', function () { location.reload(); });
  more.textContent = '';
  more.appendChild(t);
  more.appendChild(b);
}, 10000);
