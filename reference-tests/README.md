# 旧版の検証に使ったテスト

チャットで旧版（リニューアル前）を検証したときのテスト。リニューアル版のテストを作るときの土台にする。

- `gas_mock.js`：スプレッドシート・カレンダー・ロック・キャッシュなどの模擬環境
- `gas_test.js`：GAS の API を一通り動かすテスト（54項目）
- `fe_test.js`：jsdom で画面を動かすテスト（21項目）
- `sw_test.js`：sw.js のテスト（20項目）

読み込み先は、このリポジトリの旧版（`legacy-gas/`、`index.html`、`sw.js`）に合わせてある。リポジトリの一番上で動かす。

```
node reference-tests/gas_test.js
node reference-tests/sw_test.js
node reference-tests/fe_test.js
```

`fe_test.js` だけは jsdom が要る（`npm i -D jsdom`）。
