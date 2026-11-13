# Claude Office 画面の「見た目」契約書（UI Contract）

この資料だけ読めば、`static/style.css` とキャラクターの SVG を作れるようにまとめています。
画面の動き（`static/app.js`）と HTML の骨組みは別の担当が作っています。**このあと説明する class / id / data- 属性が「約束」で、JS はこれ以外の目印を使いません。**

## 1. 変えてよいもの・変えてはいけないもの

| 対象 | 変えてよいか |
|---|---|
| `static/style.css` | **全部変えてよい**（全面書き換え OK） |
| `static/index.html` の template 部分（`<!-- ===== キャラクター（ChatGPT が差し替える範囲 ここから） ===== -->` から `（ここまで）` まで）の **template の中身** | 変えてよい（SVG を差し替える）。template の `id` は変えない |
| 上記の範囲に template を **追加** する（`cat-<agent_type>` の形） | してよい（「6. キャラクター」） |
| `static/index.html` のほかの部分 | **変えない** |
| `static/app.js` | **変えない** |
| class / id / data- 属性の名前と値の種類 | **変えない**（JS が使っている） |
| 新しいファイル（画像・フォントなど） | **自分では足さない**。必要なら依頼する（「8. CSP の制約」） |

## 2. 画面の全体構造

```
body[data-mode="live"|"mock"]
├─ header.page-header
│   ├─ h1                                  タイトル
│   └─ p#connection-status[data-connection]  接続状態
├─ main
│   ├─ section.office                       デスクの並ぶ床
│   │   └─ section.desk[data-role][data-count]  × 6（固定の順）
│   │       ├─ h2.desk-label                役割名（固定の文字）
│   │       └─ div.desk-seats
│   │           └─ div.seat[data-state …]   × 0人以上（JS が出し入れ）
│   │               ├─ div.cat              キャラクター（template の複製）
│   │               └─ div.nameplate        名札（absent には無い）
│   └─ section.activity
│       ├─ h2
│       └─ ol#activity-log
│           └─ li.log-entry[data-kind]      × 最大50件（新しい順）
└─ template#cat-…                           キャラクターの型（表示されない）
```

## 3. 部品ごとの目印一覧

### body

| 目印 | 値 | 意味 |
|---|---|---|
| `data-mode` | `live` / `mock` | 本番表示か、偽データのモック表示か |

### 接続状態 `p#connection-status`

| 目印 | 値 | 表示される文字 |
|---|---|---|
| `data-connection` | `connecting` | 接続中… |
| | `open` | 接続済み（モック時は「モック表示中」） |
| | `reconnecting` | 再接続中 |
| | `closed` | 切断（再読み込みしてください） |

### デスク `section.desk`

固定の順で6つ並びます。

| `data-role` | 見出し `.desk-label` の文字 |
|---|---|
| `researcher` | 調査担当 |
| `coder` | コーディング担当 |
| `test-runner` | テスト担当 |
| `code-reviewer` | レビュー担当 |
| `code-explainer` | 解説担当 |
| `other` | その他（上の5つ以外の agent_type はすべてここ。例 `Explore`, `general-purpose`） |

| 目印 | 値 | 意味 |
|---|---|---|
| `data-role` | 上の表の6つ | デスクの役割 |
| `data-count` | `"0"`, `"1"`, `"2"` … | 在席人数（`entering` と `present` の数。`leaving` は数えない） |

- 中の `div.desk-seats` に席が並びます。同じ役割の人が同時に複数いれば、席も複数になります。並べ方（横並び・折り返しなど）は CSS で自由に決めてください。

### 席 `div.seat`

| 目印 | 値 | 意味 |
|---|---|---|
| `data-state` | `entering` / `present` / `leaving` / `absent` | 状態（「4. 状態の切り替え」） |
| `data-role` | デスクの `data-role` と同じ | どのデスクの席か（absent の席には付かない） |
| `data-agent-type` | agent_type そのまま（例 `researcher`, `Explore`, `general-purpose`） | 役割の英名（absent には付かない） |
| `data-model` | モデル名そのまま（例 `haiku`, `sonnet`, `opus`, `不明`, `claude-xxx`） | モデル（absent には付かない） |
| `data-agent-id` | 英数字17文字前後 | エージェントの ID（見た目には使わないこと） |

### 名札 `div.nameplate` の中身（この順で並ぶ）

| 要素 | 中身の例 | 長さの目安 |
|---|---|---|
| `span[data-field="role_label"]` | `調査担当` / `Explore` | 日本語なら8文字程度。roles.json に無い役割は英名がそのまま入り、20文字程度のこともある |
| `span[data-field="agent_type"]` | `researcher` / `general-purpose` | 英数字とハイフン。15〜20文字程度 |
| `span[data-field="model"]` | `haiku` / `sonnet` / `opus` / `不明` / `claude-xxx` | 普通は5〜6文字だが、上の3つ以外の長い名前（20文字程度）も来る |
| `time[data-field="started_at"]` | `03:48:22`（`datetime="2026-11-14T03:48:22"`） | 8文字固定 |
| `span[data-field="elapsed"]` | `0:05`, `12:34`, `1:02:03` | 入室からの経過時間。1時間未満は `m:ss`、1時間以上は `h:mm:ss`。1秒ごとに書き換わる。時刻が読めないときは `-:--` |

- 表示する項目は、API から届くものだけです。名札に新しい項目は増やせません（CSS の `::before` / `::after` で「モデル:」のような飾りの文字を足すのは OK）。
- 長い文字ではみ出さないよう、`overflow-wrap: anywhere` や `text-overflow: ellipsis` を使ってください。
- 経過時間は1秒ごとに文字数が変わるので、`font-variant-numeric: tabular-nums` を付けると表示がガタつきません。

### キャラクター `div.cat`

- template（「6. キャラクター」）を複製した `svg.cat-svg` が1つ入ります。
- 大きさは `.cat` と `.cat-svg` の CSS で決めてください（SVG 側に width/height は書かない）。

### 入退室ログ `ol#activity-log`

`li.log-entry` が新しい順に最大50件並びます。

| 目印 | 値 | いつ |
|---|---|---|
| `data-kind` | `enter` | 入室 |
| | `leave` | 退室 |
| | `update` | 在席中の人のモデル名が変わった（入室時と同じモデルなら出ない） |
| | `system` | 接続が切れた・再接続した・モックを開始した など |
| `data-reason` | `timeout`（leave のときだけ付くことがある） | 時間切れで自動退室させた |

中身（この順）：
- `time[data-field="time"]`：`03:48:22`（`datetime="2026-11-14T03:48:22.871"`）
- `span[data-field="message"]`：文章。40文字程度まで。例：
  - enter：`調査担当 が入室しました（haiku）`
  - leave：`調査担当 が退室しました` / `調査担当 が退室しました（時間切れで自動退室）`
  - update：`解説担当 のモデル: sonnet`
  - system：`再接続（この間の履歴は抜けている可能性あり）`

## 4. 状態の切り替え（席の data-state）

| 状態 | いつ | 次の状態 |
|---|---|---|
| `entering` | 入室を受け取った直後 | **ENTER_MS = 600ms** 後に `present` |
| `present` | 在席中。画面を開いた時点ですでにいた人は、最初からこの状態（アニメなし） | 退室を受け取ると `leaving` |
| `leaving` | 退室を受け取った直後 | **LEAVE_MS = 600ms** 後に席が DOM から消える |
| `absent` | デスクに1人もいない（席が1つも無い）ときに置かれる「不在」の席。中は `.cat` だけで、名札は無い | 誰か入室すると消える |

- `entering` のまま `leaving` になることもあります（入ってすぐ出た場合）。
- 不在の席は、`leaving` の席が消えたあとに置かれます（`leaving` 中はまだ置かれません）。
- 再接続したときは全部の席を作り直します。この場合はアニメなしで、すぐ `present` / `absent` になります。
- **JS は CSS のアニメ終了を待たずに、時間で切り替えます。** そのため次を守ってください。
  - `entering` / `leaving` のアニメーション・トランジションは **600ms 以下**（おすすめ 500ms 以下）にする
  - `leaving` のアニメは `animation-fill-mode: forwards` などで、終わった見た目を保つ（600ms で消えるまでに、元の見た目へ戻ってチラつかないように）
  - `present` / `absent` には無限ループのアニメ（まばたき・しっぽ振りなど）を付けてよい
  - `@media (prefers-reduced-motion: reduce)` のときはアニメを止める

CSS の例：
```css
.seat[data-state="entering"] { animation: seat-enter 0.5s ease-out; }
.seat[data-state="leaving"]  { animation: seat-leave 0.5s ease-in forwards; }
.seat[data-state="absent"]   { opacity: 0.4; }
@keyframes seat-enter { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes seat-leave { from { opacity: 1; } to { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .seat { animation: none !important; }
}
```

## 5. data- 属性で見た目を変える例

次の属性は、見た目を変える条件として自由に使ってかまいません。

```css
/* モデルごとに名札の色を変える（3つ以外のモデルも来るので、既定の色も決めておく） */
.seat [data-field="model"] { background: #ddd; }
.seat[data-model="haiku"]  [data-field="model"] { background: #cde8e2; }
.seat[data-model="sonnet"] [data-field="model"] { background: #d6e0f7; }
.seat[data-model="opus"]   [data-field="model"] { background: #f2d6d6; }

/* 役割ごとのデスクの色 */
.desk[data-role="coder"] { border-color: #8ca8e8; }

/* 誰もいないデスクを薄くする */
.desk[data-count="0"] .desk-label { opacity: 0.6; }

/* 接続状態 */
#connection-status[data-connection="reconnecting"] { color: #b45f06; }

/* ログの種類・時間切れ */
.log-entry[data-kind="system"] { font-style: italic; }
.log-entry[data-reason="timeout"] [data-field="message"] { color: #b00020; }

/* モック表示中だけ目印を出す */
body[data-mode="mock"] #connection-status::after { content: "（偽データ）"; }
```

## 6. キャラクター（template）

### id 一覧（`index.html` の決められた範囲にある）

| id | 使われる席 |
|---|---|
| `cat-researcher` | agent_type が researcher |
| `cat-coder` | coder |
| `cat-test-runner` | test-runner |
| `cat-code-reviewer` | code-reviewer |
| `cat-code-explainer` | code-explainer |
| `cat-generic` | 上のどれにも当てはまらない agent_type（other デスクの人など） |
| `cat-absent` | 不在の席 |

- JS は agent_type を小文字にしてから `cat-<agent_type>` を探し、見つからなければ `cat-generic` を使います。
- **追加してもよい**：例えば `<template id="cat-explore">` や `<template id="cat-general-purpose">` を足すと、その agent_type の人は自動でそのキャラになります（デスクは other のまま）。id には英小文字・数字・ハイフンだけを使ってください。

### SVG の書き方の決まり

各 template の中は、SVG 1つだけにします：
```html
<template id="cat-researcher">
  <svg viewBox="0 0 64 64" class="cat-svg" aria-hidden="true" focusable="false">
    …図形…
  </svg>
</template>
```

- `class="cat-svg"` と `aria-hidden="true"` は必ず付ける
- `viewBox="0 0 64 64"` を推奨（ほかの値でもよいが、全部そろえる）。`width` / `height` は書かない
- **禁止**（CSP で動かない、または危険なため）：
  - `style="…"` 属性
  - SVG の中の `<style>` 要素
  - `<script>`、`onload` などの `on…` 属性
  - 外部の参照（`href="http…"`、外部の `<image>`、`<use href="外部ファイル">`）
  - **`id` 属性**（席の数だけ複製されて id が重複するため）。そのため `url(#…)` を使うグラデーション・マスク・クリップ・`<use href="#…">` も使えない
  - `<foreignObject>`
- 色は `fill` / `stroke` などの属性で書くか、図形に class を付けて `style.css` で指定する（例 `class="cat-body"` → `.seat[data-model="opus"] .cat-body { fill: … }`）
  - CSS の指定は `fill` 属性より優先されます。属性は「既定の色」として書いておくと安全です
- 状態で動かしたい部分には class を付けておき、`style.css` で動かす（例 `.seat[data-state="present"] .cat-tail { animation: … }`）。`transform-origin` を使うときは、`transform-box: fill-box` も一緒に指定すると扱いやすい
- 図形は `<circle>` `<ellipse>` `<rect>` `<path>` `<polygon>` `<line>` `<g>` などの基本的なものだけで描く

## 7. 各状態の DOM の例

### デスク全体（誰もいない＝不在）
```html
<section class="desk" data-role="researcher" data-count="0">
  <h2 class="desk-label">調査担当</h2>
  <div class="desk-seats">
    <div class="seat" data-state="absent" aria-label="不在">
      <div class="cat"><svg viewBox="0 0 64 64" class="cat-svg" aria-hidden="true">…cat-absent の中身…</svg></div>
    </div>
  </div>
</section>
```

### entering の席
```html
<div class="seat" data-state="entering" data-role="researcher" data-agent-id="a9e3ac8774e52f507" data-agent-type="researcher" data-model="haiku">
  <div class="cat"><svg viewBox="0 0 64 64" class="cat-svg" aria-hidden="true">…cat-researcher の中身…</svg></div>
  <div class="nameplate">
    <span data-field="role_label">調査担当</span>
    <span data-field="agent_type">researcher</span>
    <span data-field="model">haiku</span>
    <time data-field="started_at" datetime="2026-11-14T03:48:22">03:48:22</time>
    <span data-field="elapsed">0:00</span>
  </div>
</div>
```

### present の席（other デスクで、長い名前・知らないモデル）
```html
<section class="desk" data-role="other" data-count="1">
  <h2 class="desk-label">その他</h2>
  <div class="desk-seats">
    <div class="seat" data-state="present" data-role="other" data-agent-id="mock-7" data-agent-type="general-purpose" data-model="claude-xxx">
      <div class="cat"><svg viewBox="0 0 64 64" class="cat-svg" aria-hidden="true">…cat-generic の中身…</svg></div>
      <div class="nameplate">
        <span data-field="role_label">general-purpose</span>
        <span data-field="agent_type">general-purpose</span>
        <span data-field="model">claude-xxx</span>
        <time data-field="started_at" datetime="2026-11-14T02:40:00">02:40:00</time>
        <span data-field="elapsed">1:08:22</span>
      </div>
    </div>
  </div>
</section>
```

### leaving の席
`data-state="leaving"` になるだけで、中身は present と同じです。600ms 後に要素ごと消えます。
```html
<div class="seat" data-state="leaving" data-role="coder" data-agent-id="…" data-agent-type="coder" data-model="sonnet">…present と同じ中身…</div>
```

### ログ
```html
<ol id="activity-log">
  <li class="log-entry" data-kind="system"><time data-field="time" datetime="2026-11-14T03:50:10.002">03:50:10</time><span data-field="message">再接続（この間の履歴は抜けている可能性あり）</span></li>
  <li class="log-entry" data-kind="leave" data-reason="timeout"><time data-field="time" datetime="2026-11-14T03:49:30.100">03:49:30</time><span data-field="message">テスト担当 が退室しました（時間切れで自動退室）</span></li>
  <li class="log-entry" data-kind="leave"><time data-field="time" datetime="2026-11-14T03:49:01.464">03:49:01</time><span data-field="message">解説担当 が退室しました</span></li>
  <li class="log-entry" data-kind="update"><time data-field="time" datetime="2026-11-14T03:48:46.594">03:48:46</time><span data-field="message">解説担当 のモデル: sonnet</span></li>
  <li class="log-entry" data-kind="enter"><time data-field="time" datetime="2026-11-14T03:48:46.593">03:48:46</time><span data-field="message">解説担当 が入室しました（sonnet）</span></li>
</ol>
```

### 接続状態（4つ）
```html
<p id="connection-status" data-connection="connecting" role="status" aria-live="polite">接続中…</p>
<p id="connection-status" data-connection="open" role="status" aria-live="polite">接続済み</p>
<p id="connection-status" data-connection="reconnecting" role="status" aria-live="polite">再接続中</p>
<p id="connection-status" data-connection="closed" role="status" aria-live="polite">切断（再読み込みしてください）</p>
```
（モック時は `data-connection="open"` で、文字は `モック表示中`）

## 8. CSP（セキュリティ設定）の制約

画面には `Content-Security-Policy: default-src 'self'; …` が付いています。この設定では、同じサーバーから読み込んだものしか使えません。

- 外部の URL は使えません（CDN の CSS、Google Fonts などの外部フォント、外部画像、`@import url(https://…)`）
- インラインの style（`style="…"` 属性、`<style>` 要素）は動きません。CSS は全部 `style.css` に書いてください
- `url(data:…)` の画像（data URI）も `default-src 'self'` によりブロックされるので使えません
- フォントは、OS に入っているものを `font-family` で指定してください（例 `system-ui, "Hiragino Sans", "Yu Gothic UI", sans-serif`）
- **画像やフォントのファイルを足したいとき**は、`static/` に置くだけでは読めません（サーバーの `STATIC_FILES` への登録が必要で、登録の無い URL は 404 になります）。ファイル名と用途をそえて、こちらに依頼してください

## 9. 確認のしかた

1. サーバーを起動：`python server.py`
2. ブラウザで **http://127.0.0.1:8765/#mock** を開く
   - 偽のイベントが数秒おきに流れます（全デスク・その他デスク・同じ役割の複数在席・時間切れの退室・知らないモデル名・1時間以上の経過時間を含む。同時に最大6人程度）
   - サーバーには接続しません。`#mock` を付けたり外したりしたら、ページを再読み込みしてください
3. 本番表示は **http://127.0.0.1:8765/**
4. ブラウザの開発者ツールの Console に CSP の赤いエラーが出ていないか確認してください（出ていたら禁止事項に当たっています）
5. OS の「視差効果を減らす」や「アニメーションを減らす」設定をオンにして、アニメが止まるかも確認してください
