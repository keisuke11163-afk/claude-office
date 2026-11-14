# Claude Factory 画面の「見た目」契約書（UI Contract）

この資料だけ読めば、`static/style.css` と画像を作り直せるようにまとめています。
画面の動き（`static/app.js`）は別の担当が作っています。**このあと説明する id / class / data- 属性が「約束」で、JS はこれ以外の目印を使いません。**

> 2026-11-14：猫のデスク（`section.desk` / `div.seat` / `template#cat-…`）から、
> タコの工房（ジオラマ背景 + `div.slot` + `button.worker-actor`）に作り直しました。
> 旧版の約束は git の履歴（`feature/office-ui` の 5a878c6 まで）にあります。

## 1. 変えてよいもの・変えてはいけないもの

| 対象 | 変えてよいか |
|---|---|
| `static/style.css` | **全部変えてよい**（全面書き換え OK） |
| `static/assets/` の画像 | 同じファイル名・同じ大きさの比率なら差し替えてよい |
| `static/index.html` の文字・飾り・並び | 変えてよい。ただし「3. 部品ごとの目印」の id / class / data- 属性は残す |
| `static/app.js` | **変えない**（直したいときは依頼する） |
| id / class / data- 属性の名前と値の種類 | **変えない**（JS が使っている） |
| 新しいファイル（画像・フォントなど） | 足してよいが、`server.py` の `STATIC_FILES` への登録が必要（`docs/api.md` の「7. ファイルを足す方法」） |

`index.html` を変えたら、`tests/js/app_test.html` の「ここから」〜「ここまで」も同じ中身にします（テストが確かめます）。

## 2. 画面の全体構造

```
body[data-mode="live"|"mock"]
└─ div.layout#app
    ├─ aside.rail                       左のメニュー
    │   ├─ button.nav-item[data-scroll]   押すと #workshop / #crew / #journal へ移動
    │   └─ #side-crew / #side-events      人数・件数（JS が文字を入れる）
    └─ div.stage-column
        ├─ header.topbar
        │   ├─ #connection-status[data-connection]  接続状態
        │   └─ button#light-toggle                 昼夜の切り替え（#scene に .night を付け外し）
        └─ main
            ├─ section.workshop#workshop
            │   ├─ #scene-population               "N WORKERS"
            │   └─ div.scene#scene[.night]
            │       ├─ img.background-art            ジオラマの背景
            │       ├─ div.slot[data-role] × 6       作業場所（CSS で背景の上の位置を決める）
            │       │   ├─ button.worker-actor × 0人以上（JS が出し入れ）
            │       │   └─ span.bubble.overflow-badge   「ほか○匹」（5人目から）
            │       └─ div#scene-empty[.visible]     誰もいないときの案内
            ├─ aside.right-panels#crew
            │   ├─ #crew-total                     "N 在室"
            │   ├─ div#worker-list                 役割ごとの button.crew-row × 6（JS が毎回作り直す）
            │   └─ #manager-quote / button#next-quote  工場長のひとこと
            ├─ div.summary-strip                 #summary-present / #summary-enter / #summary-leave
            └─ div.bottom-grid
                ├─ ol#activity-log               業務日誌（li.log-entry、新しい順、最大50件）
                └─ div#worker-detail             選んだタコの詳細（JS が毎回作り直す）
                    └─ div#mock-controls[hidden]   モックのときだけ出る（#mock-enter / #mock-leave）
```

## 3. 部品ごとの目印

### 作業場所 `div.slot[data-role]`

| `data-role` | 入る agent_type |
|---|---|
| `researcher` / `coder` / `test-runner` / `code-reviewer` / `code-explainer` | 同じ名前の agent_type |
| `other` | 上のどれでもない agent_type（`Explore`、`general-purpose` など） |

- 6つとも `index.html` に必要です（check_static が確かめます）
- 位置は CSS の `.slot[data-role="…"] { left: …%; top: …% }` で、背景の上に置きます
- 1つの作業場所に絵を出すのは **4匹まで**。5匹目からは `hidden` が付き、`.overflow-badge` に「ほか○匹」が出ます

### タコ `button.worker-actor`

```html
<button class="worker-actor" type="button" data-agent-id="…" data-state="present"
        data-role="coder" data-agent-type="coder" data-model="sonnet"
        aria-label="コーディング担当、モデル sonnet、詳細を表示">
  <img src="/assets/octopus/coder.png" alt="">
  <span class="bubble">コーディング担当</span>
</button>
```

| 属性・class | 値 |
|---|---|
| `data-state` | `entering` / `present` / `leaving`（「4. 状態の切り替え」） |
| `data-role` | 入っている作業場所の役割 |
| `data-agent-type` / `data-model` | サーバーから届いた値そのまま（`不明` や `claude-xxx` も来る） |
| `.selected` | 詳細に表示中のタコ |
| `hidden` | 5匹目以降で絵を出さない（CSS で `display: none` にする） |

- 絵は役割で決まります：`/assets/octopus/<役割>.png`（`other` は `general.png`）
- 不在の役割の一覧には `/assets/octopus/absent.png`、工場長の欄には `manager.png` を使います

### 業務日誌 `li.log-entry`

```html
<li class="log-entry" data-kind="leave" data-reason="timeout">
  <time datetime="2026-11-14T10:10:00.000">10:10:00</time>
  <span class="log-sign">↰</span>
  <span class="log-msg">コーディング担当 が退室しました（時間切れで自動退室）</span>
</li>
```

- `data-kind`：`enter` / `leave` / `update` / `system`
- `data-reason="timeout"`：時間切れの退室だけに付く
- ログが空のときは `#activity-log:empty::before` で案内を出す

### 接続状態 `#connection-status[data-connection]`

`connecting` / `open` / `reconnecting` / `closed` の4つ。モックのときは `open` で「モック表示中」。

## 4. 状態の切り替え（タコの data-state）

| 状態 | いつ | 長さ |
|---|---|---|
| `entering` | enter が届いた直後 | 500ms 後に `present` へ（CSS の `enter` アニメも 0.5s） |
| `present` | 在席中・snapshot で置いたとき | — |
| `leaving` | leave が届いた直後 | 500ms 後に DOM から消える（CSS の `leave` アニメも 0.5s、`forwards`） |

- `leaving` のタコは人数に数えず、一覧からも外れますが、アニメが終わるまでは画面に残ります
- タコの要素は1人1個を使い回し、ほかのイベントが届いても作り直しません（アニメが途中で止まらない）
- `prefers-reduced-motion: reduce` のときはアニメを止め、`leaving` は薄く表示します

## 5. CSP（セキュリティ設定）の制約

- `<style>`、`style="…"`、`<script>…</script>`、`onclick="…"` は使えません
- 外部のフォント・画像・CDN は使えません。画像は `static/assets/` に置いて `STATIC_FILES` に登録します
- URL は `/` で始めて書きます（相対パスは不可）。CSS の `url()`、HTML の `src` / `href`、JS の `"/assets/…png"` も check_static が登録を確かめます

## 6. 確認のしかた

```
python tools/check_static.py static      # 決まりを守っているか
python -m unittest discover -s tests     # app.js の動き（Chrome / Edge があれば）も含めた全テスト
python server.py                         # http://localhost:8765/#mock でモック、/ で本番
```
