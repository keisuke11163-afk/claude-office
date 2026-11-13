# Claudeのオフィス 画面づくりのための API 資料

この資料だけ読めば、ブラウザ画面（`static/` の中）を作れるようにまとめています。
サーバー（`server.py`）は変更せず、`static/` のファイルだけで画面を作る前提です。

## 1. 全体の流れ

```
Claude Code のフック ──POST /events──▶ server.py ──GET /stream (SSE)──▶ ブラウザ画面
（サブエージェントの開始・終了）        （在席を管理）    （入室・退室などを順に送る）
```

- サブエージェント1人 ＝ 画面のキャラ1人。`agent_id` で区別します
- 画面は `GET /stream` を **`EventSource` で受け取るだけ**です。画面からサーバーへ送るものはありません
- 画面の URL：`http://127.0.0.1:8765/`（`http://localhost:8765/` も可）

## 2. 画面のファイル

### 3つのファイルの役割

- `static/index.html`：画面の骨組み（見出し・表・リストなどの置き場所）。`/style.css` と `/app.js` を読み込むだけで、中に JS や CSS は書かない
- `static/app.js`：`/stream` に接続し、届いたイベントで入室中の一覧と履歴を書き換える（画面の動きはすべてここ）
- `static/style.css`：見た目（色・余白・表の線など）

### 画面から使えるファイル（URL 一覧）

| URL | 中身 | Content-Type |
|---|---|---|
| `/` | `static/index.html` | `text/html; charset=utf-8` |
| `/app.js` | `static/app.js` | `text/javascript; charset=utf-8` |
| `/style.css` | `static/style.css` | `text/css; charset=utf-8` |
| `/stream` | SSE（下の「4. /stream」） | `text/event-stream; charset=utf-8` |

- **この表に無い URL は 404** です。画像やフォントなどのファイルを足すには、サーバーへの登録が必要です（「7. ファイルを足す方法」）
- URL は**完全一致**です。`/app.js?v=2` のようなクエリ付きや、`/static/app.js` のような書き方は 404 になります
- 3つのファイル（`/`, `/app.js`, `/style.css`）には、次のヘッダーが付きます
  - `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
  - `X-Content-Type-Options: nosniff`

## 3. 守る決まり（必ず守る）

1. **JS は `static/app.js`、CSS は `static/style.css` に書く。`index.html` に `<script>…</script>` や `<style>…</style>`、`style="…"`、`onclick="…"` を直接書かない**
   CSP（上のヘッダー）により、HTML に直接書いた JS や CSS はブラウザが実行しません。
2. **`innerHTML` を使わない**
   受け取ったデータは必ず `textContent` で入れ、要素は `document.createElement` で作ります。
   `agent_type` などは外から届く値なので、`innerHTML` に入れると仕込まれたスクリプトが動きます（XSS）。
3. **外部のファイルを読み込まない**
   CDN のライブラリ、外部フォント、外部画像は使いません（CSP でブロックされます）。必要なものは `static/` に置き、サーバーに登録します。
4. **CORS ヘッダーを付けない・ほかのサイトから読ませない**
   画面は同じサーバーから配っているので、CORS は不要です。

## 4. `/stream`（SSE）

### 受け取り方

```js
const eventSource = new EventSource("/stream");
eventSource.addEventListener("snapshot", (message) => { const data = JSON.parse(message.data); /* ... */ });
eventSource.addEventListener("enter",    (message) => { const data = JSON.parse(message.data); /* ... */ });
eventSource.addEventListener("leave",    (message) => { const data = JSON.parse(message.data); /* ... */ });
eventSource.addEventListener("update",   (message) => { const data = JSON.parse(message.data); /* ... */ });
```

- イベントは **`snapshot` / `enter` / `leave` / `update` の4種類だけ**です
- 1件は次の形で届きます。`id` はそのイベントの `seq` と同じ数です（`message.lastEventId` でも読めます）

```
id: 5
event: enter
data: {"kind": "enter", ... , "seq": 5}

```

- 15秒間送るものが無いと `: ping` という行が届きますが、ブラウザが自動で無視するので何もしなくてよいです

### ⚠ イベント名 `update` の data は `kind: "model"`

`update` イベントの data の中の `kind` は **`"update"` ではなく `"model"`** です。
サーバー内部の種別名が `"model"` のままで、ブラウザに送るときにイベント名だけ `update` に変えているためです。
**画面では `kind` ではなく、イベント名（`addEventListener` の第1引数）で種類を判定してください。**

| SSE のイベント名 | data の `kind` |
|---|---|
| `snapshot` | （`kind` なし） |
| `enter` | `"enter"` |
| `leave` | `"leave"` |
| `update` | `"model"` |

### 4-1. `snapshot`：接続した直後に必ず1回

いま入室中のエージェント全員です。**再接続のたびにも届く**ので、受け取ったら一覧（キャラ）を**丸ごと置き換え**ます。

実際に受け取った例（1人入室中。`sample_events.jsonl` の8行目）：
```json
{"seq": 8, "agents": [{"agent_id": "ac798f755f5232cbb", "agent_type": "code-explainer", "role_label": "解説担当", "model": "sonnet", "started_at": "2026-11-14T03:48:46"}]}
```

実際に受け取った例（誰もいない）：
```json
{"seq": 3, "agents": []}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `seq` | number（整数, 0以上） | スナップショットを取った時点の最後の通し番号。このあと届くイベントの `seq` はこれより大きい |
| `agents` | array | 入室中のエージェント。空なら誰もいない。並び順に意味はない |
| `agents[].agent_id` | string | エージェントの ID（キャラを区別するキー） |
| `agents[].agent_type` | string | 役割の英名（例 `researcher`） |
| `agents[].role_label` | string | 表示用の役割名（例 `調査担当`。「6. 役割名とモデル名」） |
| `agents[].model` | string | モデル名（例 `haiku`） |
| `agents[].started_at` | string | 入室時刻（秒まで。「5. 時刻の形式」） |

### 4-2. `enter`：入室

実際に受け取った例：
```json
{"kind": "enter", "time": "2026-11-14T03:48:22.871", "agent_id": "a9e3ac8774e52f507", "agent_type": "researcher", "role_label": "調査担当", "model": "haiku", "started_at": "2026-11-14T03:48:22", "seq": 5}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `kind` | string | 常に `"enter"` |
| `time` | string | イベントが起きた時刻（ミリ秒まで） |
| `agent_id` | string | エージェントの ID |
| `agent_type` | string | 役割の英名 |
| `role_label` | string | 表示用の役割名 |
| `model` | string | モデル名 |
| `started_at` | string | 入室時刻（秒まで）。snapshot の `started_at` と同じ形 |
| `seq` | number | 通し番号 |

### 4-3. `leave`：退室

実際に受け取った例：
```json
{"kind": "leave", "time": "2026-11-14T03:48:26.472", "agent_id": "a9e3ac8774e52f507", "agent_type": "researcher", "role_label": "調査担当", "model": "haiku", "reason": "stop", "seq": 6}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `kind` | string | 常に `"leave"` |
| `time` | string | イベントが起きた時刻（ミリ秒まで） |
| `agent_id` | string | 退室したエージェントの ID |
| `agent_type` | string | 役割の英名 |
| `role_label` | string | 表示用の役割名 |
| `model` | string | モデル名 |
| `reason` | string | `"stop"`（作業が終わった）または `"timeout"`（入室から30分たって自動で退室させた） |
| `seq` | number | 通し番号 |

- `started_at` は入りません

### 4-4. `update`：モデル名が分かった（data の `kind` は `"model"`）

実際に受け取った例（**入室より先に届いた**ため `agent_type` と `role_label` が `null`）：
```json
{"kind": "model", "time": "2026-11-14T03:48:22.869", "agent_id": "a9e3ac8774e52f507", "agent_type": null, "role_label": null, "model": "haiku", "seq": 4}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `kind` | string | 常に `"model"`（イベント名は `update`） |
| `time` | string | イベントが起きた時刻（ミリ秒まで） |
| `agent_id` | string | エージェントの ID |
| `agent_type` | string または `null` | 入室中なら役割の英名。まだ入室していなければ `null` |
| `role_label` | string または `null` | 入室中なら表示用の役割名。まだ入室していなければ `null` |
| `model` | string | 分かったモデル名 |
| `seq` | number | 通し番号 |

画面での扱い：
- その `agent_id` が入室中なら、キャラのモデル名表示を書き換える
- 入室中でなければ（`agent_type` が `null`）、**キャラは作らない**。このあと届く `enter` に正しいモデル名が入っています

### 4-5. 順番・番号・再接続

- `seq` は1ずつ増える通し番号で、**届いた順＝サーバーで状態が変わった順**です。同じ `seq` が2回届くことはありません
- `snapshot` の直後のイベントは `seq` が `snapshot.seq + 1` から始まります（例：snapshot が 3 なら次は 4）
- **1人のエージェントで `update` と `enter` のどちらが先に届くかは決まっていません**。`docs/sample_events.jsonl` の実例では、
  - `researcher`：`update`（seq 4）→ `enter`（seq 5）→ `leave`（seq 6）… `update` が先（`agent_type` が `null`）
  - `code-explainer`：`enter`（seq 7）→ `update`（seq 8）→ `leave`（seq 9）… `enter` が先（`update` にも `agent_type` が入る）
- `update` が1人につき1回届くとは限りません（届かないこともあります）。`enter` の `model` だけで表示が成り立つようにしてください
- `leave` は `enter` の後にしか届きません（入室していない人の退室は送られません）
- 接続が切れると、ブラウザ（`EventSource`）が自動で再接続し、**新しい `snapshot` から始め直します**。切れていた間のイベントは送り直されません（`Last-Event-ID` は使いません）
- 受け取りが遅れてサーバー側のキュー（1000件）が溢れたとき、またはブラウザへの書き込みが5秒詰まったときは、サーバーが接続を切ります。ブラウザが自動で再接続します
- 接続状態は `eventSource.readyState`（`0`＝接続中/再接続中、`1`＝接続済み、`2`＝閉じた）と、`open` / `error` イベントで分かります。`2`（`EventSource.CLOSED`）になったら自動では再接続しないので、ページの再読み込みを促してください

## 5. 時刻の形式

| フィールド | 例 | 形式 |
|---|---|---|
| `time` | `2026-11-14T03:48:22.871` | `YYYY-MM-DDTHH:MM:SS.mmm`（ミリ秒まで） |
| `started_at` | `2026-11-14T03:48:22` | `YYYY-MM-DDTHH:MM:SS`（秒まで） |

- どちらも **サーバーを動かしている PC の現地時刻**で、`Z` や `+09:00` のようなタイムゾーンは付きません
- JavaScript の `new Date("2026-11-14T03:48:22")` は、タイムゾーンの無い形を**ブラウザの現地時刻**として読むので、同じ PC で見る限りずれません
- 表示だけなら文字列の `T` の後ろ8文字（`03:48:22`）を切り出すのが簡単です

## 6. 役割名とモデル名

### `role_label`（`config/roles.json` の中身）

```json
{
  "test-runner": "テスト担当",
  "code-reviewer": "レビュー担当",
  "coder": "コーディング担当",
  "researcher": "調査担当",
  "code-explainer": "解説担当"
}
```

- `agent_type` がこの表にあれば `role_label` は日本語名、**無ければ `agent_type` と同じ文字列**になります（例：組み込みの `Explore` や `general-purpose` は `role_label` も `"Explore"`, `"general-purpose"`）
- 画面は `role_label` をそのまま表示すればよく、`roles.json` を読む必要はありません（`roles.json` は画面からは取得できません）

### `model`

- 通常は `"haiku"` / `"sonnet"` / `"opus"` のどれか
- 分からないときは `"不明"`
- 上の3つ以外の名前のモデルは、元の文字列がそのまま入ることがあります（例 `"claude-xxx"`）。**決まった3つ以外も表示できる作り**にしてください

### 文字数の目安

- `agent_id`：英数字 17文字前後（例 `a9e3ac8774e52f507`）。長いので表示するなら先頭8文字程度で十分
- `agent_type`：英数字とハイフン。`general-purpose` など15文字程度のこともある

## 7. ファイルを足す方法（`STATIC_FILES`）

画像・フォント・JS ファイルなどを増やすときは、**ファイルを `static/` に置き、`server.py` の `STATIC_FILES` に1行足します**。
変更はこの辞書だけで、ほかの場所は触りません。変更後はサーバーの再起動が必要です。

`server.py` の上のほう（`STATIC_DIR` のすぐ下）：
```python
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    # ↓ 例：static/images/desk.png を /images/desk.png で配る
    "/images/desk.png": ("images/desk.png", "image/png"),
}
```

- キー：ブラウザから使う URL（`/` で始める。完全一致）
- 値の1つ目：`static/` フォルダからの相対パス
- 値の2つ目：Content-Type。よく使うもの：

| 種類 | Content-Type |
|---|---|
| PNG 画像 | `image/png` |
| GIF 画像 | `image/gif` |
| SVG 画像 | `image/svg+xml` |
| WOFF2 フォント | `font/woff2` |
| JSON | `application/json; charset=utf-8` |
| JavaScript | `text/javascript; charset=utf-8` |

- 自分のサーバーから配るファイルは CSP の `'self'` に含まれるので、**CSP の変更は不要**です
- ファイルが多くなっても、1つずつ登録します（フォルダごと公開する仕組みは、フォルダの外のファイルを読まれる危険があるので入れていません）
- 外部サイトのフォントなどをどうしても使う場合だけ、`server.py` の `CONTENT_SECURITY_POLICY` に種類ごとの許可（`font-src` など）を足します。`default-src 'self'` と後ろの3つ（`frame-ancestors` / `base-uri` / `form-action`）は残してください

## 8. エラーの返し方（参考）

| コード | いつ |
|---|---|
| 400 | （POST）Content-Length が不正・1MB 超え、本文が空、JSON として読めない／オブジェクトでない |
| 403 | `Host` が `127.0.0.1:<port>` / `localhost:<port>` 以外（GET・POST とも）。POST と `GET /stream` で `Origin` が自分自身以外（`Origin` が無ければ通す） |
| 404 | 「2. 画面のファイル」の表に無いパス |
| 415 | （POST）`Content-Type` が `application/json` 以外 |
| 500 | サーバー内部の処理エラー |
| 501 | GET・POST 以外のメソッド |

`<port>` は実際に待ち受けているポート番号（既定 8765、環境変数 `CLAUDE_OFFICE_PORT` で変更）です。

## 9. 画面の動作確認のしかた

### サーバーの起動

```
python server.py            # 既定
python server.py --verbose  # 無視したイベントもコンソールに表示
python server.py --stale-minutes 10   # 自動退室を10分に（既定30分。環境変数 CLAUDE_OFFICE_STALE_MINUTES でも可）
```

### Claude を動かさずにイベントを起こす

フックと同じ形の JSON を `POST /events` に送ると、画面にイベントが流れます（`Content-Type: application/json` が必須）。

```bash
# 入室（agent_id は好きな文字列）
curl -X POST http://127.0.0.1:8765/events -H "Content-Type: application/json" -d '{"hook_event_name":"SubagentStart","agent_type":"researcher","agent_id":"demo-1"}'
# モデル名が分かった（→ update）
curl -X POST http://127.0.0.1:8765/events -H "Content-Type: application/json" -d '{"hook_event_name":"PostToolUse","tool_name":"Agent","tool_response":{"agentId":"demo-1","resolvedModel":"claude-haiku-5-5"}}'
# 退室
curl -X POST http://127.0.0.1:8765/events -H "Content-Type: application/json" -d '{"hook_event_name":"SubagentStop","agent_type":"researcher","agent_id":"demo-1"}'
```

- 入室 → 退室のあと、同じ `agent_id` でもう一度入室させることはできます
- ただし、**入室していない `agent_id` に先に退室を送ると、その `agent_id` の入室は60秒間無視されます**（Start より先に Stop が届いたときの対策）。順番を間違えたら、別の `agent_id` で試してください

### サンプルのイベント

`docs/sample_events.jsonl` に、実際にサーバーから受け取ったイベントを1行1件で保存しています。形式：

```json
{"event": "enter", "id": 5, "data": {"kind": "enter", "...": "..."}}
```

- `event`：SSE のイベント名、`id`：SSE の id、`data`：`JSON.parse(message.data)` で得られるもの
- 1〜7行目：1本の接続で受け取った順（誰もいない snapshot → researcher の update・enter・leave → code-explainer の enter・update・leave）
- 8行目：**別の接続**で、code-explainer の入室中に取った snapshot（在席者ありの例）。1〜7行目の続きではないので、再現するときは単独で使ってください
- 画面のロジックをサーバー無しで試すときは、1〜7行目の `data` を順に処理関数へ渡すと再現できます
