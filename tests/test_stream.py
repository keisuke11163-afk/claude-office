"""
SSE 配信（GET /stream）のテスト。実行: python -m unittest discover -s tests -v

観点：正常系・境界値・異常系。
- サーバーはポート0（自動割り当て）で起動するので、本物のサーバー(8765)には送らない
- 読み取りは http.client で行い、すべての読み取りに 5 秒のタイムアウトを付ける（読み取りスレッドは作らない）
- 本物のサーバーの画面用ログ(log)は mock で止めて、テスト結果に混ぜない
"""
import http.client
import json
import os
import re
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

# 親フォルダ（claude-office）と tests フォルダを import できるようにする
PROJECT_ROOT = Path(__file__).resolve().parent.parent
TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(TESTS_DIR))

import server  # noqa: E402
from test_server import HttpTestCase, ServerStateTestCase  # noqa: E402

# キューが溢れるテストで使う、大きめのモデル名（本文の上限 1MB に収まる大きさ）
LARGE_MODEL_NAME = "x" * 500_000
# 溢れるまで送る最大回数（これを超えても溢れなければテスト失敗）
MAX_OVERFLOW_POSTS = 200
# 「あとで〇〇になるはず」を待つときの上限（秒）。これを超えたらテスト失敗にする
WAIT_LIMIT_SECONDS = 5
# 画面用ファイルに付くはずの CSP の全文（server.py と同じ文字列を、期待値としてここにも書く）
EXPECTED_CONTENT_SECURITY_POLICY = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"


def read_sse_message(response):
    """SSE の1件分を読んで {"id", "event", "data"} を返す。
    ":" で始まる行（ping）は飛ばす。接続が閉じられていたら None を返す"""
    fields = {}
    while True:
        raw_line = response.readline()
        if raw_line == b"":
            # 相手が接続を閉じた
            return None
        line = raw_line.decode("utf-8").rstrip("\r\n")
        if line == "":
            # 空行で1件の区切り（ping だけの区切りは中身が空なので読み飛ばす）
            if fields:
                return {"id": int(fields["id"]), "event": fields["event"], "data": json.loads(fields["data"])}
            continue
        if line.startswith(":"):
            # コメント行（ping）は無視
            continue
        field_name, _, field_value = line.partition(":")
        fields[field_name] = field_value.lstrip(" ")


def make_start_payload(agent_id, agent_type="researcher"):
    """SubagentStart のフック本文"""
    return {"hook_event_name": "SubagentStart", "agent_type": agent_type, "agent_id": agent_id}


def make_stop_payload(agent_id, agent_type="researcher"):
    """SubagentStop のフック本文"""
    return {"hook_event_name": "SubagentStop", "agent_type": agent_type, "agent_id": agent_id}


def make_post_tool_use_payload(agent_id, resolved_model="claude-haiku-5-5"):
    """PostToolUse（Agent ツールの結果）のフック本文"""
    return {
        "hook_event_name": "PostToolUse",
        "tool_name": "Agent",
        "tool_response": {"agentId": agent_id, "resolvedModel": resolved_model},
    }


class SseTestCase(HttpTestCase):
    """SSE のテストの基底：ログを止め、ping を短くして、閉じた接続のスレッドが早く終わるようにする"""

    def setUp(self):
        super().setUp()
        # コンソールへのログ出力を止める
        log_patcher = mock.patch.object(server, "log")
        log_patcher.start()
        self.addCleanup(log_patcher.stop)
        # 送るものが無いとき 0.1 秒ごとに ping を送る（本番は 15 秒）
        ping_patcher = mock.patch.object(server, "PING_INTERVAL_SECONDS", 0.1)
        ping_patcher.start()
        self.addCleanup(ping_patcher.stop)
        # 開いた接続と応答を覚えておく（tearDown で閉じて、配信スレッドが終わるのを待つため）
        self.open_connections = []
        self.open_responses = []

    def tearDown(self):
        # 先に接続を閉じる（応答も閉じないと、本当の接続は切れない）
        for response in self.open_responses:
            response.close()
        for connection in self.open_connections:
            connection.close()
        # 配信スレッドが登録解除して終わるまで待つ。
        # ping を元に戻す処理(addCleanup)は tearDown のあとに動くので、待つ間は 0.1 秒のまま
        all_stopped = self.wait_until(lambda: self.count_stream_queues() == 0)
        super().tearDown()
        self.assertTrue(all_stopped, "接続を閉じたのに配信スレッドが残っています")

    def count_stream_queues(self):
        """いま登録されている SSE クライアントの数"""
        with server.state_lock:
            return len(server.stream_queues)

    def wait_until(self, condition, limit_seconds=WAIT_LIMIT_SECONDS):
        """condition() が True になるまで待つ。上限時間までに True にならなければ False を返す"""
        deadline = time.monotonic() + limit_seconds
        while time.monotonic() < deadline:
            if condition():
                return True
            time.sleep(0.05)
        return condition()

    def request_stream(self, extra_headers=None):
        """GET /stream に接続して応答を返す（ステータスは確認しない）。閉じる処理は tearDown で行う"""
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        self.open_connections.append(connection)
        connection.request("GET", "/stream", headers=extra_headers or {})
        response = connection.getresponse()
        self.open_responses.append(response)
        return response

    def open_stream(self):
        """GET /stream に接続して応答（ヘッダー）を受け取る。200 でなければ失敗にする"""
        response = self.request_stream()
        self.assertEqual(response.status, 200)
        return response

    def post_expect_204(self, payload):
        """POST して、204（受け付けた）になることを確かめる"""
        self.assertEqual(self.post_json(payload), 204)


class SseOrderTest(SseTestCase):
    """接続直後の snapshot と、イベントの順番・seq・id"""

    def test_正常系_接続直後に_snapshot_が届き_在席中のエージェントが入っている(self):
        # 接続する前に入室させておく
        self.post_expect_204(make_start_payload("pre-1"))

        response = self.open_stream()
        snapshot = read_sse_message(response)

        self.assertEqual(snapshot["event"], "snapshot")
        # SSE の id と data の seq は同じ番号
        self.assertEqual(snapshot["id"], snapshot["data"]["seq"])
        self.assertEqual([agent["agent_id"] for agent in snapshot["data"]["agents"]], ["pre-1"])
        self.assertEqual(snapshot["data"]["agents"][0]["role_label"], "調査担当")
        # 経過時間の計算用の値は送らない
        self.assertNotIn("started_monotonic", snapshot["data"]["agents"][0])

    def test_境界値_誰も入室していなければ_snapshot_の_agents_は空(self):
        response = self.open_stream()
        snapshot = read_sse_message(response)
        self.assertEqual(snapshot["event"], "snapshot")
        self.assertEqual(snapshot["data"]["agents"], [])

    def test_正常系_Start_PostToolUse_Stop_が_enter_update_leave_の順に届き_seq_が連番(self):
        self.post_expect_204(make_start_payload("pre-2"))
        response = self.open_stream()
        snapshot = read_sse_message(response)
        base_seq = snapshot["data"]["seq"]

        # 接続したあとに、順番に3つ送る
        self.post_expect_204(make_start_payload("sse-1"))
        self.post_expect_204(make_post_tool_use_payload("sse-1"))
        self.post_expect_204(make_stop_payload("sse-1"))

        enter_message = read_sse_message(response)
        update_message = read_sse_message(response)
        leave_message = read_sse_message(response)

        # イベント名：内部の "model" は SSE では "update" になる（data の kind は "model" のまま）
        self.assertEqual(enter_message["event"], "enter")
        self.assertEqual(update_message["event"], "update")
        self.assertEqual(update_message["data"]["kind"], "model")
        self.assertEqual(leave_message["event"], "leave")

        # seq は snapshot の seq + 1, +2, +3
        self.assertEqual(enter_message["id"], base_seq + 1)
        self.assertEqual(update_message["id"], base_seq + 2)
        self.assertEqual(leave_message["id"], base_seq + 3)
        # 各メッセージの id と data 内の seq が一致する
        for message in (enter_message, update_message, leave_message):
            self.assertEqual(message["id"], message["data"]["seq"])

        self.assertEqual(enter_message["data"]["agent_id"], "sse-1")
        self.assertEqual(update_message["data"]["model"], "haiku")
        self.assertEqual(leave_message["data"]["reason"], "stop")


class EarlyStopTest(ServerStateTestCase):
    """Start より先に Stop が来た場合の扱い（60秒の保持）。実際に待たず、記録時刻を過去にずらして確かめる"""

    def shift_early_stop_record(self, agent_id, seconds_ago):
        """先に Stop を記録した時刻を、seconds_ago 秒前にずらす（time.monotonic の値を引く）"""
        server.early_stopped_ids[agent_id] -= seconds_ago

    def test_正常系_Stop_が先に来た_id_の_60秒以内の_Start_は入室しない(self):
        stop_event = server.handle_event(make_stop_payload("early-1"))
        self.assertEqual(stop_event["kind"], "ignored")
        self.assertTrue(stop_event["show_by_default"])
        self.assertIn("early-1", server.early_stopped_ids)

        start_event = server.handle_event(make_start_payload("early-1"))
        self.assertEqual(start_event["kind"], "ignored")
        self.assertTrue(start_event["show_by_default"])
        self.assertIn("先に Stop", start_event["reason"])
        self.assertNotIn("early-1", server.present_agents)

        # 入室しなかったあとの PostToolUse も無視される
        model_event = server.handle_event(make_post_tool_use_payload("early-1"))
        self.assertEqual(model_event["kind"], "ignored")
        self.assertNotIn("early-1", server.known_models)

    def test_境界値_59秒前に記録された_Stop_はまだ有効(self):
        server.handle_event(make_stop_payload("early-2"))
        self.shift_early_stop_record("early-2", seconds_ago=59)

        start_event = server.handle_event(make_start_payload("early-2"))
        self.assertEqual(start_event["kind"], "ignored")
        self.assertNotIn("early-2", server.present_agents)

    def test_境界値_61秒前に記録された_Stop_は期限切れで_Start_が入室する(self):
        server.handle_event(make_stop_payload("early-3"))
        self.shift_early_stop_record("early-3", seconds_ago=61)

        start_event = server.handle_event(make_start_payload("early-3"))
        self.assertEqual(start_event["kind"], "enter")
        self.assertIn("early-3", server.present_agents)
        self.assertNotIn("early-3", server.early_stopped_ids)


class StaleCleanupTest(SseTestCase):
    """自動掃除で退室させたあとに、本物の Stop や PostToolUse が来た場合"""

    def test_異常系_自動掃除のあとの_本物の_Stop_は_退室済みで無視され_退室は二重に届かない(self):
        response = self.open_stream()
        read_sse_message(response)  # snapshot を読み飛ばす

        # 入室を配信まで確かめる
        self.post_expect_204(make_start_payload("stale-1"))
        enter_message = read_sse_message(response)
        self.assertEqual(enter_message["event"], "enter")

        # 自動掃除（0分＝すべて対象）で退室させる
        timeout_events = server.remove_stale_agents(0)
        self.assertEqual(len(timeout_events), 1)
        leave_message = read_sse_message(response)
        self.assertEqual(leave_message["event"], "leave")
        self.assertEqual(leave_message["data"]["reason"], "timeout")
        self.assertEqual(leave_message["data"]["agent_id"], "stale-1")

        # あとから本物の Stop が届く：退室済みとして無視される（「Start が来ていない」扱いにはならない）
        stop_event = server.handle_event(make_stop_payload("stale-1"))
        self.assertEqual(stop_event["kind"], "ignored")
        self.assertTrue(stop_event["show_by_default"])
        self.assertIn("退室済み", stop_event["reason"])
        self.assertNotIn("stale-1", server.early_stopped_ids)

        # PostToolUse も無視される
        model_event = server.handle_event(make_post_tool_use_payload("stale-1"))
        self.assertEqual(model_event["kind"], "ignored")

        # 目印として別のエージェントを入室させる。次に届くのがこの enter なら、
        # 途中に二重の leave や stale-1 のイベントは届いていない
        self.post_expect_204(make_start_payload("after-1"))
        sentinel_message = read_sse_message(response)
        self.assertEqual(sentinel_message["event"], "enter")
        self.assertEqual(sentinel_message["data"]["agent_id"], "after-1")
        # 無視されたイベントは seq を使わないので、leave の次の番号になる
        self.assertEqual(sentinel_message["id"], leave_message["id"] + 1)


class HttpAccessRuleTest(HttpTestCase):
    """Host / Origin の確認、パスごとの振り分け、CSP ヘッダー"""

    def setUp(self):
        super().setUp()
        # 拒否したときのログ出力を止める
        log_patcher = mock.patch.object(server, "log")
        log_patcher.start()
        self.addCleanup(log_patcher.stop)

    def send_raw(self, method, path, headers, body=None):
        """ヘッダーを自分で全部決めて送る。(ステータス, ヘッダー, 本文) を返す"""
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            # Host も自分で付けるので、自動で付けさせない
            connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            for name, value in headers.items():
                connection.putheader(name, value)
            connection.endheaders(body)
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def json_post_headers(self, host, origin=None):
        """POST /events 用のヘッダー（Host と任意の Origin）"""
        headers = {"Host": host, "Content-Type": "application/json", "Content-Length": "0"}
        if origin is not None:
            headers["Origin"] = origin
        return headers

    def start_body(self, agent_id):
        """SubagentStart の本文（バイト列）と、その長さを入れたヘッダーを作る"""
        return json.dumps(make_start_payload(agent_id)).encode("utf-8")

    def test_異常系_Host_が_外部の名前なら_GET_は_403(self):
        status, _, _ = self.send_raw("GET", "/", {"Host": f"evil.example:{self.port}"})
        self.assertEqual(status, 403)

    def test_異常系_Host_が_外部の名前なら_GET_stream_も_403(self):
        # 接続を開いたままにならないよう、403 はすぐ返る
        status, _, _ = self.send_raw("GET", "/stream", {"Host": f"evil.example:{self.port}"})
        self.assertEqual(status, 403)

    def test_異常系_Host_が_外部の名前なら_POST_は_403_で_状態も変わらない(self):
        body = self.start_body("host-1")
        headers = {"Host": f"evil.example:{self.port}", "Content-Type": "application/json",
                   "Content-Length": str(len(body))}
        status, _, _ = self.send_raw("POST", "/events", headers, body)
        self.assertEqual(status, 403)
        self.assertNotIn("host-1", server.present_agents)

    def test_境界値_Host_のポート番号が違えば_403(self):
        # 待ち受けと違う番号（1）を書いた Host は拒否する
        status, _, _ = self.send_raw("GET", "/", {"Host": "127.0.0.1:1"})
        self.assertEqual(status, 403)

    def test_正常系_Host_が_127_0_0_1_と_localhost_なら_GET_は_200(self):
        status_ip, _, _ = self.send_raw("GET", "/", {"Host": f"127.0.0.1:{self.port}"})
        status_name, _, _ = self.send_raw("GET", "/", {"Host": f"localhost:{self.port}"})
        self.assertEqual(status_ip, 200)
        self.assertEqual(status_name, 200)

    def test_境界値_Host_は大文字小文字を区別しない(self):
        status, _, _ = self.send_raw("GET", "/", {"Host": f"LOCALHOST:{self.port}"})
        self.assertEqual(status, 200)

    def test_異常系_Origin_が外部なら_POST_は_403_で_状態も変わらない(self):
        body = self.start_body("origin-1")
        headers = self.json_post_headers(f"127.0.0.1:{self.port}", origin="http://evil.example")
        headers["Content-Length"] = str(len(body))
        status, _, _ = self.send_raw("POST", "/events", headers, body)
        self.assertEqual(status, 403)
        self.assertNotIn("origin-1", server.present_agents)

    def test_異常系_Origin_が_null_なら_POST_は_403(self):
        # 「null」は、サンドボックスの iframe などから送られる値。自分自身ではないので拒否
        body = self.start_body("origin-2")
        headers = self.json_post_headers(f"127.0.0.1:{self.port}", origin="null")
        headers["Content-Length"] = str(len(body))
        status, _, _ = self.send_raw("POST", "/events", headers, body)
        self.assertEqual(status, 403)

    def test_境界値_Origin_のポート番号が違えば_403(self):
        body = self.start_body("origin-3")
        headers = self.json_post_headers(f"127.0.0.1:{self.port}", origin="http://127.0.0.1:1")
        headers["Content-Length"] = str(len(body))
        status, _, _ = self.send_raw("POST", "/events", headers, body)
        self.assertEqual(status, 403)

    def test_正常系_Origin_が自分自身なら_POST_は_204_で入室する(self):
        body = self.start_body("origin-4")
        headers = self.json_post_headers(f"127.0.0.1:{self.port}", origin=f"http://127.0.0.1:{self.port}")
        headers["Content-Length"] = str(len(body))
        status, _, _ = self.send_raw("POST", "/events", headers, body)
        self.assertEqual(status, 204)
        self.assertIn("origin-4", server.present_agents)

    def test_正常系_Origin_が_localhost_の自分自身でも_POST_は_204(self):
        body = self.start_body("origin-5")
        headers = self.json_post_headers(f"localhost:{self.port}", origin=f"http://localhost:{self.port}")
        headers["Content-Length"] = str(len(body))
        status, _, _ = self.send_raw("POST", "/events", headers, body)
        self.assertEqual(status, 204)

    def test_異常系_GET_の別パスは_404(self):
        host = {"Host": f"127.0.0.1:{self.port}"}
        for path in ("/nope", "/events", "/stream/extra", "/app.js.map"):
            with self.subTest(path=path):
                status, _, _ = self.send_raw("GET", path, host)
                self.assertEqual(status, 404)

    def test_正常系_GET_の_画面は_CSP_ヘッダー_付きで_200(self):
        status, headers, body = self.send_raw("GET", "/", {"Host": f"127.0.0.1:{self.port}"})
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Security-Policy"), EXPECTED_CONTENT_SECURITY_POLICY)
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
        self.assertTrue(headers.get("Content-Type", "").startswith("text/html"))
        self.assertGreater(len(body), 0)

    def test_正常系_app_js_と_style_css_は_200_で_CSP_ヘッダー_付き(self):
        host = {"Host": f"127.0.0.1:{self.port}"}
        expected_types = {"/app.js": "text/javascript", "/style.css": "text/css"}
        for path, content_type_start in expected_types.items():
            with self.subTest(path=path):
                status, headers, body = self.send_raw("GET", path, host)
                self.assertEqual(status, 200)
                self.assertEqual(headers.get("Content-Security-Policy"), EXPECTED_CONTENT_SECURITY_POLICY)
                self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
                self.assertTrue(headers.get("Content-Type", "").startswith(content_type_start))
                self.assertGreater(len(body), 0)


class StreamOverflowTest(SseTestCase):
    """受け取りが追いつかないクライアントの扱い（キューが溢れたら接続を切る）"""

    def test_異常系_読まない間にキューが溢れると_接続が切られ_登録も外れる(self):
        # キューの大きさを 3 にして、少し送っただけで溢れるようにする
        with mock.patch.object(server, "STREAM_QUEUE_SIZE", 3):
            response = self.open_stream()
            snapshot = read_sse_message(response)
            self.assertEqual(snapshot["event"], "snapshot")

            # 接続した1クライアントのキューを見つける（この時点で登録されているのは1つだけのはず）
            with server.state_lock:
                registered_queues = list(server.stream_queues)
            self.assertEqual(len(registered_queues), 1)
            client_queue = registered_queues[0]

            # 読まずに大きなイベントを送り続ける。送信が詰まると、キューが溢れて登録が外れる
            posted_count = 0
            while True:
                self.post_expect_204(make_post_tool_use_payload("overflow-1", resolved_model=LARGE_MODEL_NAME))
                posted_count += 1
                with server.state_lock:
                    still_registered = client_queue in server.stream_queues
                if not still_registered:
                    break
                self.assertLess(posted_count, MAX_OVERFLOW_POSTS, "キューが溢れないまま上限まで送ってしまった")

            # 登録は外れている（これ以上イベントは溜まらない）
            with server.state_lock:
                self.assertNotIn(client_queue, server.stream_queues)

            # 読み始めると、すでに届いていた分を読んだあと接続が閉じられている（タイムアウトせず終わる）
            remaining_bytes = response.read()

        # 届いた id をすべて集める（行の先頭が "id: " の行）
        delivered_ids = [int(number) for number in re.findall(rb"(?m)^id: (\d+)$", remaining_bytes)]
        self.assertGreater(len(delivered_ids), 0)
        # 途中で切られたので、サーバーが最後に付けた番号までは届いていない
        with server.state_lock:
            latest_sequence = server.event_sequence
        self.assertLess(delivered_ids[-1], latest_sequence)
        # 切られる前に送られたイベントは、番号が飛ばず順番どおり
        self.assertEqual(delivered_ids, sorted(delivered_ids))
        self.assertEqual(len(set(delivered_ids)), len(delivered_ids))


class PingTest(SseTestCase):
    """何も送るものが無いときの ping（コメント行）"""

    def test_正常系_何も送るものが無いと_ping_の行が届く(self):
        response = self.open_stream()
        read_sse_message(response)  # snapshot を読み飛ばす

        # snapshot のあとは、ping（": ping" の1行と空行）が届く
        ping_line = response.readline()
        self.assertEqual(ping_line, b": ping\n")


class StreamDisconnectTest(SseTestCase):
    """ブラウザ（SSE クライアント）が接続を閉じたときの後始末"""

    def test_正常系_クライアントが接続を閉じると_数秒以内に_stream_queues_から外れる(self):
        response = self.open_stream()
        read_sse_message(response)  # snapshot を読み飛ばす
        self.assertEqual(self.count_stream_queues(), 1)

        # ブラウザが閉じたのと同じ状況にする（ping は 0.1 秒ごとなので、書き込みの失敗にすぐ気づく）
        response.close()

        self.assertTrue(
            self.wait_until(lambda: self.count_stream_queues() == 0),
            "接続を閉じても stream_queues に残っている",
        )


class StreamOriginTest(SseTestCase):
    """GET /stream の Origin の確認（Origin が無ければ通す）"""

    def test_異常系_外部の_Origin_つきの_GET_stream_は_403_で登録されない(self):
        response = self.request_stream({"Origin": "http://evil.example"})
        self.assertEqual(response.status, 403)
        self.assertEqual(self.count_stream_queues(), 0)

    def test_正常系_自分自身の_Origin_つきの_GET_stream_は_200(self):
        response = self.request_stream({"Origin": f"http://127.0.0.1:{self.port}"})
        self.assertEqual(response.status, 200)
        self.assertEqual(read_sse_message(response)["event"], "snapshot")

    def test_正常系_Origin_なしの_GET_stream_は_200_で_snapshot_が届く(self):
        # 同じサイトの EventSource は普通 Origin を付けない（今のブラウザ画面はこの形）
        response = self.request_stream()
        self.assertEqual(response.status, 200)
        self.assertEqual(read_sse_message(response)["event"], "snapshot")


class StopDuringFileReadTest(ServerStateTestCase):
    """定義ファイルを読んでいる最中に Stop が届いた場合（幽霊エージェントを作らない）"""

    def test_異常系_読み込み中に_Stop_が来たら_Start_は無視され_あとの_PostToolUse_も無視される(self):
        def read_model_while_stop_arrives(agent_type):
            # ファイルを読んでいる最中に、同じ id の Stop が届いた状況を作る
            server.handle_stop("race-1")
            return None

        with mock.patch.object(server, "read_model_from_definition", side_effect=read_model_while_stop_arrives):
            start_event = server.handle_start("race-1", "researcher")

        self.assertEqual(start_event["kind"], "ignored")
        self.assertTrue(start_event["show_by_default"])
        self.assertNotIn("race-1", server.present_agents)

        # あとから届く PostToolUse も無視され、モデル名は残らない
        model_event = server.handle_event(make_post_tool_use_payload("race-1"))
        self.assertEqual(model_event["kind"], "ignored")
        self.assertNotIn("race-1", server.known_models)


class StaleBoundaryTest(ServerStateTestCase):
    """自動掃除の境界：stale_seconds 未満は残り、以上は退室する（実際には待たず、入室時刻をずらす）"""

    def test_境界値_経過が_stale_seconds_未満なら残り_以上なら退室する(self):
        stale_seconds = 600
        for agent_id in ("before-limit", "at-limit", "over-limit"):
            server.handle_event(make_start_payload(agent_id))
        # 入室時刻を過去にずらして、経過時間を作る
        server.present_agents["before-limit"]["started_monotonic"] -= stale_seconds - 1
        server.present_agents["at-limit"]["started_monotonic"] -= stale_seconds
        server.present_agents["over-limit"]["started_monotonic"] -= stale_seconds + 1

        timeout_events = server.remove_stale_agents(stale_seconds)

        self.assertEqual(sorted(event["agent_id"] for event in timeout_events), ["at-limit", "over-limit"])
        self.assertEqual(list(server.present_agents), ["before-limit"])
        self.assertIn("at-limit", server.left_agent_ids)


class StaleMinutesSettingTest(unittest.TestCase):
    """自動掃除の分数の決め方（引数 > 環境変数 > 既定値）と、分数として使える値かの判定"""

    def decide_with_env(self, argument_minutes, env_text):
        """環境変数を env_text にして decide_stale_minutes を呼ぶ（None なら未設定）。終わったら環境変数は元に戻る"""
        with mock.patch.dict(os.environ), mock.patch.object(server, "log"):
            os.environ.pop("CLAUDE_OFFICE_STALE_MINUTES", None)
            if env_text is not None:
                os.environ["CLAUDE_OFFICE_STALE_MINUTES"] = env_text
            return server.decide_stale_minutes(argument_minutes)

    def test_正常系_引数は環境変数より優先される(self):
        self.assertEqual(self.decide_with_env(5.0, "10"), 5.0)

    def test_正常系_正しい環境変数は採用される(self):
        self.assertEqual(self.decide_with_env(None, "10"), 10.0)

    def test_正常系_未設定なら既定値30(self):
        self.assertEqual(self.decide_with_env(None, None), 30)

    def test_異常系_不正な環境変数は既定値30(self):
        for env_text in ("abc", "nan", "inf", "0", "-5"):
            with self.subTest(env_text=env_text):
                self.assertEqual(self.decide_with_env(None, env_text), 30)

    def test_境界値_is_valid_minutes_は_0より大きい有限の数だけ_True(self):
        for minutes in (float("nan"), float("inf"), float("-inf"), 0, -1):
            with self.subTest(minutes=minutes):
                self.assertFalse(server.is_valid_minutes(minutes))
        for minutes in (0.1, 1, 30):
            with self.subTest(minutes=minutes):
                self.assertTrue(server.is_valid_minutes(minutes))


class KnownModelLimitTest(ServerStateTestCase):
    """known_models の上限（MAX_KNOWN_MODELS）"""

    def report_models(self, agent_ids):
        """指定した agent_id の PostToolUse（モデル判明）を順に送る"""
        for agent_id in agent_ids:
            server.handle_event(make_post_tool_use_payload(agent_id))

    def test_境界値_上限ちょうど200件までは_1件目も残る(self):
        self.report_models([f"known-{number}" for number in range(server.MAX_KNOWN_MODELS)])
        self.assertEqual(len(server.known_models), 200)
        self.assertIn("known-0", server.known_models)

    def test_境界値_201件目で_最古の1件が消える(self):
        self.report_models([f"known-{number}" for number in range(server.MAX_KNOWN_MODELS + 1)])
        self.assertEqual(len(server.known_models), 200)
        self.assertNotIn("known-0", server.known_models)
        self.assertIn("known-1", server.known_models)
        self.assertIn("known-200", server.known_models)

    def test_正常系_同じ_id_を書き直すと新しい扱いになり_先に消えない(self):
        self.report_models([f"known-{number}" for number in range(server.MAX_KNOWN_MODELS)])
        self.report_models(["known-0"])  # いちばん古い id を書き直す
        self.report_models(["known-new"])  # 上限を超える
        self.assertIn("known-0", server.known_models)
        self.assertNotIn("known-1", server.known_models)


if __name__ == "__main__":
    unittest.main()
