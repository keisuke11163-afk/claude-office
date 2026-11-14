# Claude Factory 画面の「見た目」契約書（UI Contract）

この資料だけ読めば、`static/style.css` と画像を作り直せるようにまとめています。
画面の動き（`static/app.js`）は別の担当が作っています。**このあと説明する id / class / data- 属性が「約束」で、JS はこれ以外の目印を使いません。**

> 2026-11-14：猫のデスク（`section.desk` / `div.seat` / `template#cat-…`）から、
> タコの工房（ジオラマ背景 + `div.slot` + `button.worker-actor`）に作り直しました。
> 旧版の約束は git の履歴（`feature/office-ui` の 5a878c6 まで）にあります。
>
> 2026-11-15：照明（昼・夕・夜）とタコのモーションを追加しました（「6. 照明レイヤー・モーションのしくみ」）。

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
        │   └─ button#light-toggle                 照明の切り替え（昼→夕→夜→昼。文字と aria-label に今と次のモード）
        └─ main
            ├─ section.workshop#workshop
            │   ├─ #scene-population               "N WORKERS"
            │   └─ div.scene#scene[data-light="day"|"dusk"|"night"][.night]
            │       ├─ img.background-art            ジオラマの背景
            │       ├─ div.light-layer#light-layer   照明レイヤー（aria-hidden。「6. 照明レイヤー・モーションのしくみ」）
            │       │   ├─ div.light-tint[data-tint="dusk"|"night"]   色かぶり（multiply）
            │       │   ├─ div.light-moon                              月明かり（screen）
            │       │   └─ span.light-spot[data-light-kind][data-spot] × 9  窓・ランタン・ろうそく・入口の光（screen）
            │       ├─ div.slot[data-role] × 6       作業場所（CSS で背景の上の位置を決める）
            │       │   ├─ button.worker-actor × 0人以上（JS が出し入れ）
            │       │   └─ span.bubble.overflow-badge   「ほか○匹」（5人目から）
            │       ├─ div.scene-fx#scene-fx         見た目専用のレイヤー（退室の影武者 div.octo-ghost を JS が出し入れ）
            │       └─ div#scene-empty[.visible]     誰もいないときの案内
            ├─ aside.right-panels#crew
            │   ├─ #crew-total                     "N 在室"
            │   ├─ div#worker-list                 役割ごとの button.crew-row × 6（JS が毎回作り直す。hover / focus で工房を強調）
            │   └─ #manager-quote / button#next-quote  工場長のひとこと
            ├─ div.summary-strip                 #summary-present / #summary-enter / #summary-leave
            └─ div.bottom-grid
                ├─ ol#activity-log               業務日誌（li.log-entry、新しい順、最大50件）
                └─ div#worker-detail             選んだタコの詳細（JS が毎回作り直す。「動き」の欄は .detail-motion）
                    └─ div#mock-controls[hidden]   モックのときだけ出る
                        （#mock-enter / #mock-leave / #mock-light / #mock-work / #mock-react / #mock-walk）
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
        data-motion="idle" data-facing="right" data-frame="0"
        aria-label="コーディング担当、モデル sonnet、詳細を表示">
  <div class="octo-rig">                          <!-- 向き（左右反転）と歩きの揺れ -->
    <div class="octo-body" data-sprite="image">   <!-- 呼吸。シートがあるときは data-sprite="sheet" -->
      <img class="octo-sprite" src="/assets/octopus/coder.png" alt="">
      <span class="octo-lids" aria-hidden="true"></span>   <!-- まばたき（::before / ::after が左右のまぶた） -->
    </div>
    <span class="octo-prop" aria-hidden="true"></span>     <!-- 役割の小物（CSS で描く） -->
  </div>
  <span class="octo-mark" aria-hidden="true"></span>       <!-- 記号（! ♪ 汗 ✓ ? …）。反転しないよう枠の外 -->
  <span class="bubble">コーディング担当</span>
</button>
```

| 属性・class | 値 |
|---|---|
| `data-state` | `entering` / `present` / `leaving`（「4. 状態の切り替え」） |
| `data-role` | 入っている作業場所の役割 |
| `data-agent-type` / `data-model` | サーバーから届いた値そのまま（`不明` や `claude-xxx` も来る） |
| `data-motion` | 見た目の動き：`idle`（待機）/ `walk`（歩行）/ `work`（作業）/ `react`（リアクション） |
| `data-pose` | `work` のときだけ。役割ごとのポーズ（下の表） |
| `data-react` | `react` のときだけ。`surprise`（!）/ `joy`（♪）/ `trouble`（汗） |
| `data-facing` | `right`（絵のまま）/ `left`（左右反転） |
| `data-frame` | スプライトシートの行（モーションごと）。1枚絵のときは常に `"0"` |
| `data-visual` | 見た目専用：`walk-in`（入口から歩いてくる途中）/ `ghosted`（退室中で、影武者が代わりに歩いている）/ `measure`（位置を測る一瞬）。無いのが普通 |
| style の `--walk-from-x` / `--walk-from-y` / `--walk-ms` / `--blink-ms` / `--blink-delay` | JS が CSSOM で入れる CSS 変数（歩き始めのずれ・まばたきの間隔） |
| `.selected` | 詳細に表示中のタコ |
| `.is-highlighted` | 一覧の行に hover / focus している役割のタコ（作業場所 `.slot` にも付く） |
| `hidden` | 5匹目以降で絵を出さない（CSS で `display: none` にする） |

- 絵は役割で決まります：`/assets/octopus/<役割>.png`（`other` は `general.png`）。button の中の**最初の img** が本体の絵です
- 不在の役割の一覧には `/assets/octopus/absent.png`、工場長の欄には `manager.png` を使います

仕事のポーズ（`data-pose`。進捗や成否は表さない、役割の演出です）：

| 役割 | `data-pose` |
|---|---|
| `researcher` | `magnify`（虫眼鏡のきらめき）/ `book`（本をめくる） |
| `coder` | `type`（キーを打つ・キーの粒）/ `monitor`（モニターを見る） |
| `test-runner` | `check`（✓ を付ける）/ `cheer`（喜ぶ） |
| `code-reviewer` | `redpen`（赤ペンで線を引く）/ `tilt`（首をかしげる・?） |
| `code-explainer` | `point`（指し棒で図を示す） |
| `other` | `sort`（書類を整理する）/ `think`（考える・…） |

### 照明 `div.light-layer` と `span.light-spot`

| 目印 | 値 |
|---|---|
| `#scene[data-light]` | `day` / `dusk` / `night`（JS が書く。`night` のときは互換のため `.night` も付く） |
| `.light-tint[data-tint]` | `dusk` / `night`（どちらか1つが見える） |
| `.light-spot[data-light-kind]` | `window` / `lantern` / `candle` / `door` |
| `.light-spot[data-spot]` | 光の場所の名前（`window-left-1` など）。位置は style.css の「★」の CSS 変数で決める |

### 退室の影武者 `div.octo-ghost`（`#scene-fx` の中）

```html
<div class="octo-ghost" aria-hidden="true" data-agent-id="…" data-role="coder" data-motion="walk" data-facing="left">
  <div class="octo-rig">…（タコの .octo-rig の複製。id・button・名札は無い）</div>
</div>
```

- style の `--ghost-x` / `--ghost-y` / `--ghost-w`（出発点と幅）、`--walk-to-x` / `--walk-to-y`（入口までのずれ）、`--walk-ms` を JS が入れます

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
- 歩いて入退室する見た目（1.4 秒）は `data-state` とは別に動きます（「6. 照明レイヤー・モーションのしくみ」）

## 5. CSP（セキュリティ設定）の制約

- `<style>`、`style="…"`、`<script>…</script>`、`onclick="…"` は使えません
- JS が位置などを渡すときは `element.style.setProperty("--名前", 値)`（CSSOM）で CSS 変数を入れます。これは CSP で止められません
- 外部のフォント・画像・CDN は使えません。画像は `static/assets/` に置いて `STATIC_FILES` に登録します
- URL は `/` で始めて書きます（相対パスは不可）。CSS の `url()`、HTML の `src` / `href`、JS の `"/assets/…png"` も check_static が登録を確かめます

## 6. 照明レイヤー・モーションのしくみ

> 2026-11-15：照明（昼・夕・夜）とタコのモーションを追加しました。
> これまでは「CSS とテンプレートで見た目を全部決め、JS は data-state を付け外すだけ」でしたが、
> 次の点が変わりました。
>
> - 夜は背景に `filter: brightness(…)` をかける方式をやめ、**背景・照明レイヤー・タコ・UI を別々の層**にしました（画面全体を暗くする filter は使わない）
> - タコの中身が `img` 1枚から `div.octo-rig > div.octo-body > img + まぶた` と小物・記号に増えました（`img` と `.bubble` はそのまま残っています）
> - **在席状態（`data-state`）と見た目（`data-motion` / `data-visual`）を分けました**。JS が見た目用の data- 属性と CSS 変数も書きます
> - 退室の歩き去りは、本物のタコとは別の「影武者」を `#scene-fx` に置いて見せます

### 層の重なり（下から）

1. `img.background-art`（背景の絵。filter はかけない）
2. `.light-layer` の中身（`z-index: 1`）：色かぶり（`mix-blend-mode: multiply`）→ 月明かり・光スポット（`screen`）。`.light-layer` 自体には z-index / opacity を付けない（付けると背景と混ざらなくなる）
3. `.slot`（`z-index: 2`）：`::before` がデスクライトの光だまり（タコの後ろ）、`::after` がタコを照らす薄い光（`soft-light`）
4. `#scene-fx`（`z-index: 3`）：退室の影武者
5. `#scene-empty`（`z-index: 4`）

- 照明・影武者はすべて `pointer-events: none`。UI（パネル・ボタン・文字）は暗くなりません
- 切り替えは各層の `opacity` を `transition`（`--light-fade`、既定 1 秒）で変えます。昼はほぼ透明、夕は斜めのオレンジの色かぶりと弱い窓明かり、夜は青い色かぶり + 月明かりと、窓・ランタン・ろうそく・デスクライトの暖色
- 光の位置・大きさ、入口の位置（`--door-x` / `--door-y`）は style.css の「★ 位置と色の調整はここだけ」にまとめています。入口の位置は JS も読みます（歩く先）
- 選んだ照明は `localStorage` の `claude-factory-light` に保存します（使えなくても動きます）

### モーションと在席状態

| | 在席状態 `data-state` | 見た目 `data-motion` / `data-visual` |
|---|---|---|
| 入室 | `entering` → 500ms で `present`（今までどおり） | `walk` + `walk-in`：入口から席まで 1.4 秒かけて歩き、着いたら `idle` |
| 在席中 | `present` | モーション指揮役が `idle` / `work` / `react` を切り替える |
| 退室 | `leaving` → 500ms で DOM から消える（今までどおり） | 本物は `ghosted`（見えない）。`#scene-fx` の影武者が入口まで歩き、1.4 秒ほどで消える |
| snapshot | 全員を `present` で置き直す | `#scene-fx` を空にし、見た目用のタイマーも止めてから置き直す（歩きなし） |

- **モーション指揮役**：`setInterval` 1本（1.7 秒ごと）で、`present`・`hidden` でない・歩いていないタコのうち一部（約 35%）だけ、重み付きランダムで動きを変えます。DOM は作り直さず data- 属性を書くだけです。タブが非表示（`document.hidden`）のときは止まります
- 動きはすべて CSS アニメーション（transform / opacity 中心）。`requestAnimationFrame` で毎フレーム DOM を書くことはしません
- SSE には進捗や成否が無いので、仕事モーションは**役割を表す演出**です。「成功」「完了」などの文字は出しません（記号だけ）
- 5匹目以降（`hidden`）は歩かず、指揮の対象にもなりません。退室するときは見えるようになってから歩き去ります

### スプライトシート（将来）

- `app.js` の `SPRITE_SHEETS` に役割ごとの `{ url, frameCount, fps, rowByMotion }` を書くと、その役割は `.octo-body[data-sprite="sheet"]` になり、1行 = 1モーションのシートを `steps()` で再生します（`data-frame` はシートの行）
- 設定が無い役割は、今の1枚絵 + CSS の仮アニメ（呼吸・まばたき・足もとの揺れ・よちよち）のままです。シートの画像は `STATIC_FILES` への登録が必要です

### 動きを減らす設定（`prefers-reduced-motion: reduce`）

- すべてのアニメと transition を止め（4行目の `!important` のルール）、歩き・影武者・モーション指揮もしません
- 照明の点灯そのものは静止した状態で残ります。タコは役割の小物が見える仕事のポーズで止まり、`leaving` は薄く表示します

## 7. 確認のしかた

```
python tools/check_static.py static      # 決まりを守っているか
python -m unittest discover -s tests     # app.js の動き（Chrome / Edge があれば）も含めた全テスト
python server.py                         # http://localhost:8765/#mock でモック、/ で本番
```
