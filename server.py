"""
Claudeのオフィス：フックのイベントを受け取り、在席中のエージェントを管理するサーバー。

起動方法: python server.py [--verbose] [--stale-minutes 30]
受け取り: POST http://127.0.0.1:8765/events（ポートは環境変数 CLAUDE_OFFICE_PORT で変更できる）
画面:     GET  http://127.0.0.1:8765/        （ブラウザで開く）
配信:     GET  http://127.0.0.1:8765/stream  （SSE：サーバーからブラウザへ順に送り続ける仕組み）
"""
import argparse
import json
import math
import os
import queue
import re
import threading
import time
from collections import OrderedDict
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# 待ち受け設定：自分のPC(127.0.0.1)からの通信だけ受け付ける
HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_BODY_BYTES = 1_000_000  # これより大きいデータは受け付けない

# 読み込むファイルの場所
ROLES_FILE = Path(__file__).resolve().parent / "config" / "roles.json"
AGENT_DEFINITION_DIR = Path.home() / ".claude" / "agents"
STATIC_DIR = Path(__file__).resolve().parent / "static"

# GET で返す画面用ファイル： URLのパス -> (static フォルダ内のファイル名, Content-Type)
# ここに無いパスは返さない（フォルダの外のファイルを読まれないよう、決め打ちの一覧にしている）
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    # 工房の背景とタコの絵（画像を足すときは、ここに1枚ずつ登録する）
    "/assets/workshop_background.png": ("assets/workshop_background.png", "image/png"),
    "/assets/octopus/researcher.png": ("assets/octopus/researcher.png", "image/png"),
    "/assets/octopus/coder.png": ("assets/octopus/coder.png", "image/png"),
    "/assets/octopus/test-runner.png": ("assets/octopus/test-runner.png", "image/png"),
    "/assets/octopus/code-reviewer.png": ("assets/octopus/code-reviewer.png", "image/png"),
    "/assets/octopus/code-explainer.png": ("assets/octopus/code-explainer.png", "image/png"),
    "/assets/octopus/general.png": ("assets/octopus/general.png", "image/png"),
    "/assets/octopus/manager.png": ("assets/octopus/manager.png", "image/png"),
    "/assets/octopus/absent.png": ("assets/octopus/absent.png", "image/png"),
}

# 画面に付けるセキュリティ設定（CSP）：自分自身(このサーバー)から読み込んだものだけ使える。
# HTML の中に直接書いた <script> や <style> も動かないので、JS と CSS は別ファイルにしている。
# 外部のフォントや画像を使いたくなったら、ここに種類ごとの許可を足す。例：
#   "default-src 'self'; font-src 'self' https://fonts.gstatic.com; style-src 'self' https://fonts.googleapis.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
# （img-src = 画像、font-src = フォント、style-src = CSS、script-src = JavaScript）
# 後ろの3つは守りの設定なので残す：frame-ancestors 'none' = ほかのページの <iframe> に画面を埋め込ませない、
# base-uri 'none' = <base> タグでリンク先を書き換えさせない、form-action 'none' = フォームを送らせない
CONTENT_SECURITY_POLICY = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

# モデル名の短縮表示に使う種類
MODEL_FAMILIES = ("haiku", "sonnet", "opus")

# SSE 配信の設定
STREAM_QUEUE_SIZE = 1000        # 1クライアントあたり、送れずにためておけるイベント数
PING_INTERVAL_SECONDS = 15      # 何も送るものが無いとき、この秒数ごとに ": ping" を送る
# 内部のイベント種別 -> SSE のイベント名（"model" はブラウザ側では "update" として受け取る）
SSE_EVENT_NAMES = {"enter": "enter", "leave": "leave", "model": "update"}

# 自動掃除（入室したまま Stop が来ないエージェントを退室させる）の設定
DEFAULT_STALE_MINUTES = 30      # 入室からこの分数たったら退室させる（既定値）
CLEANUP_INTERVAL_SECONDS = 15   # 掃除をする間隔

# 在席中のエージェント： agent_id -> {agent_type, role_label, model, started_at, started_monotonic}
# started_at は表示用の時刻、started_monotonic は経過時間の計算用（時計合わせの影響を受けない）
present_agents = {}
# PostToolUse で分かったモデル名： agent_id -> "haiku" など（SubagentStart より先に届く場合に備えて保持）
# 古い順に並べ、増えすぎないよう上限つき
MAX_KNOWN_MODELS = 200
known_models = OrderedDict()
# 退室済みの agent_id（古い順）。前景実行では Stop のあとに PostToolUse が届くので、
# 「もう退室した人」の PostToolUse を無視するために覚えておく。増えすぎないよう上限つき
MAX_LEFT_AGENT_IDS = 200
left_agent_ids = OrderedDict()
# Start より先に Stop が届いた agent_id： agent_id -> 記録した時刻(time.monotonic())（古い順）
# あとから同じ id の Start が届いても入室させない（幽霊エージェント対策）
MAX_EARLY_STOPPED_IDS = 200
EARLY_STOP_KEEP_SECONDS = 60
early_stopped_ids = OrderedDict()
# 配信するイベントの通し番号（最後に付けた番号）
event_sequence = 0
# SSE で接続中のクライアントごとのキュー（イベントを順番にためておく入れ物）
stream_queues = set()
# 上の辞書・番号・キュー一覧を複数スレッドから触るので、操作中は鍵(Lock)をかける
state_lock = threading.Lock()

# True のとき、対象外で無視したイベントもすべてコンソールに出す（--verbose で切り替え）
verbose_mode = False


def log(message):
    """時刻つきで1行ログを出す"""
    print(f"[{datetime.now():%H:%M:%S}] {message}", flush=True)


def load_role_names():
    """roles.json を読む（読めなければ空の辞書）"""
    try:
        with ROLES_FILE.open(encoding="utf-8") as roles_file:
            role_names = json.load(roles_file)
    except (OSError, ValueError):
        return {}
    return role_names if isinstance(role_names, dict) else {}


def shorten_model_name(model_name):
    """'claude-haiku-5-5' -> 'haiku' のように短くする。該当なしならそのまま返す"""
    lowered_name = model_name.lower()
    for family in MODEL_FAMILIES:
        if family in lowered_name:
            return family
    return model_name


def read_model_from_definition(agent_type):
    """エージェント定義(.md)の先頭部分(frontmatter)から model: の値を探す。無ければ None"""
    # ファイル名に使える文字だけ許可する（../ などでフォルダの外を読まないため）
    if not re.fullmatch(r"[A-Za-z0-9_-]+", agent_type):
        return None
    try:
        text = (AGENT_DEFINITION_DIR / f"{agent_type}.md").read_text(encoding="utf-8-sig")
    except OSError:
        return None

    # frontmatter は "---" ではさまれた部分
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if line.startswith("model:"):
            model_value = line.split(":", 1)[1].strip().strip("\"'")
            # 空の値や "inherit"（親と同じモデルを使う指定）は、モデルを決める手がかりにならない
            if not model_value or model_value.lower() == "inherit":
                return None
            return shorten_model_name(model_value)
    return None


def decide_model(known_model, definition_model):
    """モデル名を決める： (1) resolvedModel (2) 定義ファイル (3) 不明。辞書やファイルには触らない"""
    return known_model or definition_model or "不明"


def make_event(event_kind, **details):
    """正規化したイベント(辞書)を作る。時刻はミリ秒つき（例 2026-11-14T01:17:41.242）"""
    event = {"kind": event_kind, "time": datetime.now().isoformat(timespec="milliseconds")}
    event.update(details)
    return event


def make_ignored_event(reason, show_by_default=False):
    """無視したイベントを作る。show_by_default=True のものだけ通常時も表示する"""
    return make_event("ignored", reason=reason, show_by_default=show_by_default)


def make_agent_view(agent_id, agent):
    """ブラウザに送る用の在席情報を作る（経過時間計算用の started_monotonic は送らない）"""
    return {
        "agent_id": agent_id,
        "agent_type": agent["agent_type"],
        "role_label": agent["role_label"],
        "model": agent["model"],
        "started_at": agent["started_at"],
    }


def publish_locked(event):
    """【state_lock の中で呼ぶ】通し番号(seq)を付けて、接続中の全クライアントのキューに入れる"""
    global event_sequence
    event_sequence += 1
    event["seq"] = event_sequence
    # set を回しながら中身を消すとエラーになるので、コピー(list)を回す
    for client_queue in list(stream_queues):
        try:
            client_queue.put_nowait(event)
        except queue.Full:
            # 受け取りが追いつかないクライアントは登録解除する（配信側が気づいて接続を切る）
            stream_queues.discard(client_queue)


def remember_left_agent_locked(agent_id):
    """【state_lock の中で呼ぶ】退室済みとして覚える（上限を超えたら古いものから消す）"""
    left_agent_ids[agent_id] = True
    left_agent_ids.move_to_end(agent_id)
    while len(left_agent_ids) > MAX_LEFT_AGENT_IDS:
        left_agent_ids.popitem(last=False)


def remember_model_locked(agent_id, model):
    """【state_lock の中で呼ぶ】モデル名を覚える（上限を超えたら古いものから消す）"""
    known_models[agent_id] = model
    # 同じ id を書き直したときも「いちばん新しい」扱いにする
    known_models.move_to_end(agent_id)
    while len(known_models) > MAX_KNOWN_MODELS:
        known_models.popitem(last=False)


def remove_expired_early_stops_locked(now):
    """【state_lock の中で呼ぶ】保持時間(60秒)を過ぎた「先に Stop」の記録を古い順に消す"""
    while early_stopped_ids:
        oldest_agent_id, recorded_at = next(iter(early_stopped_ids.items()))
        if now - recorded_at <= EARLY_STOP_KEEP_SECONDS:
            break
        del early_stopped_ids[oldest_agent_id]


def remember_early_stop_locked(agent_id):
    """【state_lock の中で呼ぶ】Start より先に Stop が来た agent_id を記録する"""
    now = time.monotonic()
    remove_expired_early_stops_locked(now)
    early_stopped_ids[agent_id] = now
    early_stopped_ids.move_to_end(agent_id)
    # 上限を超えたら古いものから消す
    while len(early_stopped_ids) > MAX_EARLY_STOPPED_IDS:
        early_stopped_ids.popitem(last=False)


def take_early_stop_locked(agent_id):
    """【state_lock の中で呼ぶ】60秒以内に「先に Stop」が記録されていれば、記録を消して True"""
    remove_expired_early_stops_locked(time.monotonic())
    return early_stopped_ids.pop(agent_id, None) is not None


def handle_start(agent_id, agent_type):
    """SubagentStart：在席辞書に追加する"""
    # ファイル読み込みは時間がかかるので、鍵(Lock)の外で先に済ませる
    definition_model = read_model_from_definition(agent_type)
    role_label = load_role_names().get(agent_type, agent_type)

    # 鍵の中では辞書の操作と配信だけを行う
    with state_lock:
        # 先に Stop が届いていた id は入室させない（ファイル読み込み中に Stop が来た場合もここで防ぐ）
        if take_early_stop_locked(agent_id):
            # あとから届く PostToolUse も無視できるよう、退室済みとして覚えておく
            remember_left_agent_locked(agent_id)
            known_models.pop(agent_id, None)
            return make_ignored_event(f"先に Stop 済みの {agent_id[:8]} の Start", show_by_default=True)

        model = decide_model(known_models.get(agent_id), definition_model)
        started_at = datetime.now().isoformat(timespec="seconds")
        present_agents[agent_id] = {
            "agent_type": agent_type,
            "role_label": role_label,
            "model": model,
            "started_at": started_at,
            "started_monotonic": time.monotonic(),
        }
        # 入室し直した agent_id は「退室済み」の記録から外す
        left_agent_ids.pop(agent_id, None)
        event = make_event(
            "enter", agent_id=agent_id, agent_type=agent_type, role_label=role_label,
            model=model, started_at=started_at,
        )
        publish_locked(event)
    return event


def handle_stop(agent_id):
    """SubagentStop：在席辞書から削除する"""
    with state_lock:
        # 自動掃除などですでに退室させた id の Stop は無視する（「Start が来ていない」扱いにしない）
        if agent_id in left_agent_ids:
            return make_ignored_event(f"退室済みの {agent_id[:8]} の Stop", show_by_default=True)

        left_agent = present_agents.pop(agent_id, None)
        known_models.pop(agent_id, None)
        # フィルタb：SubagentStart が来ていない agent_id の Stop は無視（あとの Start に備えて記録する）
        if left_agent is None:
            remember_early_stop_locked(agent_id)
            return make_ignored_event(f"SubagentStart が来ていない {agent_id[:8]} の Stop", show_by_default=True)

        # 本当に退室した agent_id を覚えて、退室を配信する
        remember_left_agent_locked(agent_id)
        event = make_event(
            "leave", agent_id=agent_id, agent_type=left_agent["agent_type"],
            role_label=left_agent["role_label"], model=left_agent["model"], reason="stop",
        )
        publish_locked(event)
    return event


def handle_model_report(payload):
    """PostToolUse：resolvedModel を記録し、在席中ならモデル名を更新する"""
    if payload.get("tool_name") not in ("Agent", "Task"):
        return make_ignored_event("Agent/Task 以外の PostToolUse")
    tool_response = payload.get("tool_response")
    if not isinstance(tool_response, dict):
        return make_ignored_event("tool_response が無い PostToolUse")
    agent_id = tool_response.get("agentId")
    resolved_model = tool_response.get("resolvedModel")
    if not isinstance(agent_id, str) or not isinstance(resolved_model, str):
        return make_ignored_event("agentId か resolvedModel が無い PostToolUse")

    # 先に届いた場合に備えて保持し、在席中ならモデル名も更新する
    model = shorten_model_name(resolved_model)
    with state_lock:
        # 退室済みの agent_id は何も記録しない（known_models に残り続けるのを防ぐ）
        if agent_id in left_agent_ids:
            return make_ignored_event(f"退室済みの {agent_id[:8]} の PostToolUse")
        remember_model_locked(agent_id, model)
        agent = present_agents.get(agent_id)
        if agent is not None:
            agent["model"] = model
        agent_type = agent["agent_type"] if agent else None
        role_label = agent["role_label"] if agent else None
        event = make_event("model", agent_id=agent_id, agent_type=agent_type, role_label=role_label, model=model)
        publish_locked(event)
    return event


def handle_event(payload):
    """フックの生データを正規化したイベントにする（フィルタもここ）"""
    event_name = payload.get("hook_event_name")
    if event_name == "PostToolUse":
        return handle_model_report(payload)
    if event_name not in ("SubagentStart", "SubagentStop"):
        return make_ignored_event(f"対象外のイベント {event_name}")

    # フィルタで弾いたもののうち、SubagentStop だけは通常時も表示する
    is_stop = event_name == "SubagentStop"

    # フィルタa：agent_type が空のイベントは無視
    agent_type = payload.get("agent_type")
    if not isinstance(agent_type, str) or not agent_type.strip():
        return make_ignored_event(f"agent_type が空の {event_name}", show_by_default=is_stop)
    agent_id = payload.get("agent_id")
    if not isinstance(agent_id, str) or not agent_id:
        return make_ignored_event(f"agent_id が無い {event_name}", show_by_default=is_stop)

    if event_name == "SubagentStart":
        return handle_start(agent_id, agent_type)
    return handle_stop(agent_id)


def remove_stale_agents(stale_seconds):
    """入室から stale_seconds 秒以上たったエージェントを退室させ、退室イベントのリストを返す"""
    now = time.monotonic()
    timeout_events = []
    with state_lock:
        # 辞書を回しながら消すとエラーになるので、コピー(list)を回す
        for agent_id, agent in list(present_agents.items()):
            if now - agent["started_monotonic"] < stale_seconds:
                continue
            del present_agents[agent_id]
            known_models.pop(agent_id, None)
            # あとから届く本物の Stop や PostToolUse を「退室済み」として無視するために覚える
            remember_left_agent_locked(agent_id)
            event = make_event(
                "leave", agent_id=agent_id, agent_type=agent["agent_type"],
                role_label=agent["role_label"], model=agent["model"], reason="timeout",
            )
            publish_locked(event)
            timeout_events.append(event)
    return timeout_events


def run_cleanup_loop(stale_seconds):
    """（専用スレッドで動かす）15秒ごとに自動掃除をする。ブラウザがつながっていなくても動く"""
    while True:
        time.sleep(CLEANUP_INTERVAL_SECONDS)
        try:
            for event in remove_stale_agents(stale_seconds):
                log(f"{format_event(event)}（時間切れ）")
        except Exception as error:
            # 掃除に失敗してもスレッドは止めない
            log(f"自動掃除のエラー: {error}")


def format_event(event):
    """コンソール用の1行文字列にする"""
    if event["kind"] == "ignored":
        return f"無視: {event['reason']}"
    kind_labels = {"enter": "入室", "leave": "退室", "model": "モデル判明"}
    if event["agent_type"]:
        who = f"{event['role_label']}({event['agent_type']})"
    else:
        who = "(まだ入室していない)"
    return f"{kind_labels[event['kind']]} {event['agent_id'][:8]} {who} / {event['model']}"


def should_print(event):
    """コンソールに出すかどうかを決める"""
    if event["kind"] != "ignored":
        return True
    return verbose_mode or event["show_by_default"]


class EventRequestHandler(BaseHTTPRequestHandler):
    # 本文を送ってこないクライアントにスレッドを占有されないよう、5秒で通信を打ち切る
    timeout = 5

    def allowed_hosts(self):
        """許可する Host ヘッダーの値。実際に待ち受けているポート番号から毎回作る"""
        listening_port = self.server.server_address[1]
        return (f"127.0.0.1:{listening_port}", f"localhost:{listening_port}")

    def is_allowed_host(self):
        """Host ヘッダーが自分自身(127.0.0.1 / localhost)宛てかどうか（DNSリバインディング対策）"""
        host_value = self.headers.get("Host", "").strip().lower()
        return host_value in self.allowed_hosts()

    def is_allowed_origin(self):
        """Origin ヘッダーが無いか、自分自身のページからなら True（外部サイトからの送信を防ぐ）"""
        origin_value = self.headers.get("Origin")
        if origin_value is None:
            return True
        allowed_origins = [f"http://{host}" for host in self.allowed_hosts()]
        return origin_value.strip().lower() in allowed_origins

    def read_body(self):
        """本文を読んで返す。Content-Length が不正・大きすぎるときは 400 を返して None"""
        # Content-Length は 0 以上の半角数字だけ許可する（負数や文字は不正）
        length_text = self.headers.get("Content-Length", "0").strip()
        if not (length_text.isascii() and length_text.isdigit()):
            log(f"不正なリクエスト: Content-Length が数字ではありません ({length_text})")
            self.reply(400)
            return None
        body_size = int(length_text)

        # 上限を超える本文は読み捨てずに断る（読むと上限の意味がなくなるため）
        if body_size > MAX_BODY_BYTES:
            log(f"不正なリクエスト: 本文が大きすぎます ({body_size})")
            self.reply(400)
            return None

        # 0 なら読むものが無い。それ以外は宣言された長さだけ読む
        if body_size == 0:
            return b""
        return self.rfile.read(body_size)

    def do_GET(self):
        # 自分自身宛て以外の Host は拒否する
        if not self.is_allowed_host():
            log(f"拒否: 許可していない Host です ({self.headers.get('Host')})")
            self.reply(403)
            return

        # パスごとに振り分ける（それ以外は 404）
        if self.path in STATIC_FILES:
            self.send_static_file(self.path)
        elif self.path == "/stream":
            # 外部サイトのページから読まれないよう Origin も確認する
            # （同じサイトの EventSource は普通 Origin を付けないので、Origin が無ければ通す）
            if not self.is_allowed_origin():
                log(f"拒否: 許可していない Origin です ({self.headers.get('Origin')})")
                self.reply(403)
                return
            self.send_event_stream()
        else:
            self.reply(404)

    def do_POST(self):
        # 本文を先に読む（読まずに応答すると、Windows で接続がリセット(RST)されることがあるため）
        body_bytes = self.read_body()
        if body_bytes is None:
            return

        # 本文を読んだあとで、Host と Origin を確認する（自分自身宛て・自分自身から以外は 403）
        if not self.is_allowed_host():
            log(f"拒否: 許可していない Host です ({self.headers.get('Host')})")
            self.reply(403)
            return
        if not self.is_allowed_origin():
            log(f"拒否: 許可していない Origin です ({self.headers.get('Origin')})")
            self.reply(403)
            return

        # 宛先は /events だけ
        if self.path != "/events":
            self.reply(404)
            return

        # Content-Type が application/json 以外は拒否する（CSRF対策：
        # 外部サイトのフォームが送れる text/plain などを弾く。"; charset=utf-8" 付きは許可）
        content_type = self.headers.get("Content-Type", "")
        media_type = content_type.split(";", 1)[0].strip().lower()
        if media_type != "application/json":
            log("不正なリクエスト: Content-Type が application/json ではありません")
            self.reply(415)
            return

        # 本文が空なら不正扱い
        if not body_bytes:
            log("不正なリクエスト: 本文が空です")
            self.reply(400)
            return

        # JSON として読む（辞書でなければ不正扱い）
        try:
            payload = json.loads(body_bytes.decode("utf-8"))
        except ValueError as error:
            log(f"不正なJSON: {error}")
            self.reply(400)
            return
        if not isinstance(payload, dict):
            log("不正なJSON: オブジェクトではありません")
            self.reply(400)
            return

        # 正規化してログに出す（配信は handle_event の中で、状態の変更と同時に行われる）
        try:
            event = handle_event(payload)
        except Exception as error:
            log(f"処理エラー: {error}")
            self.reply(500)
            return
        # 対象外で無視したものは --verbose のときだけ表示する
        if should_print(event):
            log(format_event(event))
        self.reply(204)

    def send_static_file(self, url_path):
        """STATIC_FILES に登録された画面用ファイル（HTML / JS / CSS）を返す"""
        file_name, content_type = STATIC_FILES[url_path]
        try:
            file_bytes = (STATIC_DIR / file_name).read_bytes()
        except OSError as error:
            log(f"画面ファイルを読めません: {error}")
            self.reply(500)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(file_bytes)))
        # 自分自身から読み込んだものだけ使えるようにする（外部スクリプトの読み込みを防ぐ）
        self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        # ブラウザが Content-Type を勝手に推測して別の種類として扱わないようにする
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(file_bytes)

    def write_sse_message(self, event_name, data, message_id):
        """SSE の1件分（id / event / data）を書き込む"""
        # json.dumps は改行を \n という文字に置き換えるので、data は必ず1行になる
        data_text = json.dumps(data, ensure_ascii=False)
        message_text = f"id: {message_id}\nevent: {event_name}\ndata: {data_text}\n\n"
        self.wfile.write(message_text.encode("utf-8"))
        self.wfile.flush()

    def send_event_stream(self):
        """GET /stream：最初にスナップショット、そのあとはイベントを順に送り続ける"""
        client_queue = queue.Queue(maxsize=STREAM_QUEUE_SIZE)
        # キューの登録とスナップショットの取得を同じ鍵の中で行う（間のイベントの取りこぼし・重複を防ぐ）
        with state_lock:
            stream_queues.add(client_queue)
            snapshot = {
                "seq": event_sequence,
                "agents": [make_agent_view(agent_id, agent) for agent_id, agent in present_agents.items()],
            }

        try:
            # 応答ヘッダー（このあと接続を開いたまま送り続ける）
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()

            # 最初にスナップショット（今の在席一覧）を送る
            last_sent_seq = snapshot["seq"]
            self.write_sse_message("snapshot", snapshot, last_sent_seq)

            # 以降はキューに届いたイベントを順に送る
            while True:
                try:
                    event = client_queue.get(timeout=PING_INTERVAL_SECONDS)
                except queue.Empty:
                    # しばらく何も無ければ ping（":" で始まる行はブラウザに無視されるコメント）
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue

                # キューが満杯になって登録解除されていたら、接続を切る（ブラウザが再接続してくる）
                with state_lock:
                    still_registered = client_queue in stream_queues
                if not still_registered:
                    log("配信: 受け取りが追いつかないクライアントを切断しました")
                    break

                # スナップショットより新しいものだけ送る
                if event["seq"] <= last_sent_seq:
                    continue
                self.write_sse_message(SSE_EVENT_NAMES[event["kind"]], event, event["seq"])
                last_sent_seq = event["seq"]
        except OSError:
            # ブラウザが閉じられた・書き込みがタイムアウトした など
            pass
        finally:
            # どんな終わり方でも登録解除する
            with state_lock:
                stream_queues.discard(client_queue)
            self.close_connection = True

    def reply(self, status_code):
        """本文なしで応答する"""
        self.send_response(status_code)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, format, *args):
        """標準のアクセスログは出さない（自前のログだけにする）"""
        pass


def get_port():
    """環境変数 CLAUDE_OFFICE_PORT からポート番号を決める"""
    # 注意：hooks/log_event.py の send_to_server と同じ決め方にすること（もう一方と揃える。DEFAULT_PORT も同じ）
    try:
        return int(os.environ.get("CLAUDE_OFFICE_PORT", DEFAULT_PORT))
    except ValueError:
        return DEFAULT_PORT


def is_valid_minutes(minutes):
    """分数として使える値か（0より大きい普通の数。nan や inf はだめ）"""
    return math.isfinite(minutes) and minutes > 0


def decide_stale_minutes(argument_minutes):
    """自動掃除の分数を決める： (1) 引数 --stale-minutes (2) 環境変数 (3) 既定値30"""
    # 1. コマンドライン引数があれば最優先（正しい値かどうかは main で確認済み）
    if argument_minutes is not None:
        return argument_minutes

    # 2. 環境変数 CLAUDE_OFFICE_STALE_MINUTES（不正なら既定値）
    env_text = os.environ.get("CLAUDE_OFFICE_STALE_MINUTES")
    if env_text:
        try:
            env_minutes = float(env_text)
        except ValueError:
            env_minutes = None
        if env_minutes is not None and is_valid_minutes(env_minutes):
            return env_minutes
        log(f"CLAUDE_OFFICE_STALE_MINUTES が不正なので既定値 {DEFAULT_STALE_MINUTES} 分を使います ({env_text})")

    # 3. 既定値
    return DEFAULT_STALE_MINUTES


def main():
    global verbose_mode
    # コマンドライン引数：--verbose で無視したイベントもすべて表示、--stale-minutes で自動掃除の分数
    parser = argparse.ArgumentParser(description="Claudeのオフィス イベント受信サーバー")
    parser.add_argument("--verbose", action="store_true", help="対象外で無視したイベントもすべて表示する")
    parser.add_argument(
        "--stale-minutes", type=float, default=None,
        help=f"入室からこの分数たったエージェントを自動で退室させる（既定 {DEFAULT_STALE_MINUTES}。"
             "環境変数 CLAUDE_OFFICE_STALE_MINUTES でも指定可、引数が優先）",
    )
    arguments = parser.parse_args()
    verbose_mode = arguments.verbose
    if arguments.stale_minutes is not None and not is_valid_minutes(arguments.stale_minutes):
        parser.error("--stale-minutes は 0 より大きい数にしてください")
    stale_minutes = decide_stale_minutes(arguments.stale_minutes)

    # 自動掃除のスレッドを起動する（daemon=True：サーバー停止時に一緒に終わる）
    cleanup_thread = threading.Thread(target=run_cleanup_loop, args=(stale_minutes * 60,), daemon=True)
    cleanup_thread.start()

    port = get_port()
    server = ThreadingHTTPServer((HOST, port), EventRequestHandler)
    # 配信中の接続(スレッド)が残っていても、Ctrl+C でサーバーを止められるようにする
    server.daemon_threads = True
    mode_text = "（詳細表示モード）" if verbose_mode else ""
    log(f"サーバー起動 http://{HOST}:{port}/ {mode_text}（自動退室 {stale_minutes:g} 分。止めるには Ctrl+C）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("サーバー停止")
    finally:
        # 待ち受けをやめて、ポートを解放する
        server.server_close()


if __name__ == "__main__":
    main()
