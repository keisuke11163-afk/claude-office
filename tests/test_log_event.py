"""
hooks/log_event.py のテスト（標準 unittest）

本物の logs/events.jsonl を汚さないよう、LOG_FILE は一時フォルダに差し替える。
"""
import importlib.util
import io
import json
import os
import socket
import sys
import tempfile
import threading
import time
import types
import unittest
from contextlib import redirect_stdout
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

# 親フォルダ（claude-office）を import できるようにする
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import server  # noqa: E402

# hooks フォルダには __init__.py が無いので、ファイルの場所を直接指定して読み込む
LOG_EVENT_PATH = PROJECT_ROOT / "hooks" / "log_event.py"
_spec = importlib.util.spec_from_file_location("log_event", LOG_EVENT_PATH)
log_event = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(log_event)


def find_unused_port():
    """使われていないポート番号を1つ見つける（すぐ閉じるので、そのポートでは何も待ち受けていない）"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class LogEventTestCase(unittest.TestCase):
    """各テストの前に、ログの保存先・ポート環境変数を安全な値にする基底クラス"""

    def setUp(self):
        # ログファイルを一時フォルダに差し替える
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_log_file = Path(self.temp_dir.name) / "events.jsonl"
        self.original_log_file = log_event.LOG_FILE
        log_event.LOG_FILE = self.temp_log_file
        # 環境変数を保存し、使われていないポートに向ける
        self.original_port_env = os.environ.get("CLAUDE_OFFICE_PORT")
        os.environ["CLAUDE_OFFICE_PORT"] = str(find_unused_port())

    def tearDown(self):
        log_event.LOG_FILE = self.original_log_file
        self.temp_dir.cleanup()
        if self.original_port_env is None:
            os.environ.pop("CLAUDE_OFFICE_PORT", None)
        else:
            os.environ["CLAUDE_OFFICE_PORT"] = self.original_port_env

    def run_main_with_stdin(self, raw_bytes):
        """標準入力に raw_bytes を流して main() を実行する（サーバーへの出力は捨てる）"""
        fake_stdin = types.SimpleNamespace(buffer=io.BytesIO(raw_bytes))
        with mock.patch.object(sys, "stdin", fake_stdin), redirect_stdout(io.StringIO()):
            log_event.main()

    def read_log_records(self):
        """一時ログファイルを読んで、1行ずつの JSON を返す"""
        if not self.temp_log_file.exists():
            return []
        lines = self.temp_log_file.read_text(encoding="utf-8").splitlines()
        return [json.loads(line) for line in lines]


class SendToServerTest(LogEventTestCase):
    """表示サーバーへの送信（サーバーが止まっている場合を含む）"""

    def test_正常系_サーバーが止まっていても_例外を出さず_制限時間内に戻る(self):
        started_at = time.monotonic()
        # 例外が出れば、このテスト自体が失敗する
        log_event.send_to_server('{"hook_event_name":"SubagentStart","agent_type":"researcher","agent_id":"x"}')
        elapsed_seconds = time.monotonic() - started_at
        # 制限時間は0.2秒。Windows では接続拒否でもタイムアウトまで待つことがあるので、余裕を見て 1秒未満で確認
        self.assertLess(elapsed_seconds, 1.0)

    def test_異常系_CLAUDE_OFFICE_PORT_が数字でなければ既定値_8765_に送る(self):
        os.environ["CLAUDE_OFFICE_PORT"] = "not-a-number"
        with mock.patch.object(log_event.urllib.request, "urlopen", side_effect=OSError("拒否")) as fake_open:
            log_event.send_to_server("{}")
        sent_request = fake_open.call_args.args[0]
        self.assertEqual(sent_request.full_url, "http://127.0.0.1:8765/events")

    def test_正常系_CLAUDE_OFFICE_PORT_の値で送信先が決まる(self):
        os.environ["CLAUDE_OFFICE_PORT"] = "9123"
        with mock.patch.object(log_event.urllib.request, "urlopen", side_effect=OSError("拒否")) as fake_open:
            log_event.send_to_server("{}")
        sent_request = fake_open.call_args.args[0]
        self.assertEqual(sent_request.full_url, "http://127.0.0.1:9123/events")

    def test_正常系_送信リクエストに_Content_Type_application_json_が付く(self):
        with mock.patch.object(log_event.urllib.request, "urlopen", side_effect=OSError("拒否")) as fake_open:
            log_event.send_to_server("{}")
        sent_request = fake_open.call_args.args[0]
        self.assertEqual(sent_request.get_header("Content-type"), "application/json")

    def test_正常系_送信の制限時間は_0_2_秒(self):
        # 時間の計測ではなく、urlopen に渡す timeout の値そのものを確かめる（揺れにくい）
        with mock.patch.object(log_event.urllib.request, "urlopen", side_effect=OSError("拒否")) as fake_open:
            log_event.send_to_server("{}")
        self.assertEqual(fake_open.call_args.kwargs["timeout"], 0.2)

    def test_異常系_応答しないサーバーでも_1秒未満で戻る(self):
        # 接続は受け付けるが、返事を返さないサーバーを用意する
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as silent_server:
            silent_server.bind(("127.0.0.1", 0))
            silent_server.listen(1)
            os.environ["CLAUDE_OFFICE_PORT"] = str(silent_server.getsockname()[1])
            started_at = time.monotonic()
            log_event.send_to_server('{"hook_event_name":"SubagentStart"}')
            elapsed_seconds = time.monotonic() - started_at
        # timeout=0.2 秒で諦めるので、余裕を見ても 1秒はかからない（timeout の値自体は別テストで確認済み）
        self.assertLess(elapsed_seconds, 1.0)


class MainTest(LogEventTestCase):
    """main()：ログ追記とサーバーへの転送"""

    def test_正常系_JSON_オブジェクトは_ログに追記され_サーバーにも送られる(self):
        raw_text = '{"hook_event_name":"PreToolUse","tool_name":"Bash"}'
        with mock.patch.object(log_event, "send_to_server") as fake_send:
            self.run_main_with_stdin(raw_text.encode("utf-8"))
        records = self.read_log_records()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["payload"], {"hook_event_name": "PreToolUse", "tool_name": "Bash"})
        self.assertIn("received_at", records[0])
        fake_send.assert_called_once_with(raw_text)

    def test_正常系_日本語を含む本文も_UTF8_で正しく記録される(self):
        raw_text = '{"hook_event_name":"SubagentStart","agent_type":"調査担当"}'
        with mock.patch.object(log_event, "send_to_server"):
            self.run_main_with_stdin(raw_text.encode("utf-8"))
        records = self.read_log_records()
        self.assertEqual(records[0]["payload"]["agent_type"], "調査担当")
        # ensure_ascii=False なので、ファイルには日本語がそのまま入る
        self.assertIn("調査担当", self.temp_log_file.read_text(encoding="utf-8"))

    def test_異常系_JSON_として読めない本文は_unparsed_として記録し_サーバーには送らない(self):
        with mock.patch.object(log_event, "send_to_server") as fake_send:
            self.run_main_with_stdin(b"this is not json")
        records = self.read_log_records()
        self.assertEqual(records[0]["payload"], {"unparsed": "this is not json"})
        fake_send.assert_not_called()

    def test_異常系_UTF8_で読めないバイトは_置き換えて_記録する(self):
        with mock.patch.object(log_event, "send_to_server") as fake_send:
            self.run_main_with_stdin(b"\xff\xfe broken")
        records = self.read_log_records()
        self.assertIn("unparsed", records[0]["payload"])
        self.assertIn("broken", records[0]["payload"]["unparsed"])
        fake_send.assert_not_called()

    def test_異常系_JSON_配列は_オブジェクトではないので_サーバーには送らない(self):
        with mock.patch.object(log_event, "send_to_server") as fake_send:
            self.run_main_with_stdin(b'[1, 2, 3]')
        records = self.read_log_records()
        self.assertEqual(records[0]["payload"], [1, 2, 3])
        fake_send.assert_not_called()

    def test_境界値_空の入力でも_例外を出さず_unparsed_として記録する(self):
        with mock.patch.object(log_event, "send_to_server") as fake_send:
            self.run_main_with_stdin(b"")
        records = self.read_log_records()
        self.assertEqual(records[0]["payload"], {"unparsed": ""})
        fake_send.assert_not_called()

    def test_正常系_ログを追記する形式なので_2回実行すると_2行になる(self):
        with mock.patch.object(log_event, "send_to_server"):
            self.run_main_with_stdin(b'{"hook_event_name":"A"}')
            self.run_main_with_stdin(b'{"hook_event_name":"B"}')
        records = self.read_log_records()
        self.assertEqual([record["payload"]["hook_event_name"] for record in records], ["A", "B"])

    def test_正常系_ログの保存先フォルダが無くても作られる(self):
        nested_log_file = Path(self.temp_dir.name) / "nested" / "deeper" / "events.jsonl"
        log_event.LOG_FILE = nested_log_file
        with mock.patch.object(log_event, "send_to_server"):
            self.run_main_with_stdin(b'{"hook_event_name":"A"}')
        self.assertTrue(nested_log_file.exists())

    def test_異常系_ログを書けなくても_サーバーへの送信は行われ_例外も出ない(self):
        # 保存先フォルダの場所に「ファイル」を置いて、フォルダを作れない状態にする
        blocking_file = Path(self.temp_dir.name) / "not_a_folder"
        blocking_file.write_text("x", encoding="utf-8")
        log_event.LOG_FILE = blocking_file / "events.jsonl"
        raw_text = '{"hook_event_name":"PreToolUse"}'
        with mock.patch.object(log_event, "send_to_server") as fake_send:
            # 例外が出れば、このテスト自体が失敗する
            self.run_main_with_stdin(raw_text.encode("utf-8"))
        fake_send.assert_called_once_with(raw_text)


class EndToEndTest(LogEventTestCase):
    """実際の server.py（別スレッド）に、log_event.main() からイベントを届けて状態が変わるか確認する"""

    def setUp(self):
        super().setUp()
        server.present_agents.clear()
        server.known_models.clear()
        server.left_agent_ids.clear()
        server.early_stopped_ids.clear()
        server.stream_queues.clear()
        self.original_verbose_mode = server.verbose_mode
        server.verbose_mode = False
        # 空いているポートでサーバーを起動する
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.EventRequestHandler)
        os.environ["CLAUDE_OFFICE_PORT"] = str(self.httpd.server_address[1])
        self.server_thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.server_thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.server_thread.join(timeout=5)
        server.verbose_mode = self.original_verbose_mode
        server.present_agents.clear()
        server.known_models.clear()
        server.left_agent_ids.clear()
        server.early_stopped_ids.clear()
        server.stream_queues.clear()
        super().tearDown()

    def test_正常系_SubagentStart_がサーバーに届いて_在席に入る(self):
        raw_text = '{"hook_event_name":"SubagentStart","agent_type":"researcher","agent_id":"e2e-1"}'
        self.run_main_with_stdin(raw_text.encode("utf-8"))
        self.assertIn("e2e-1", server.present_agents)
        self.assertEqual(server.present_agents["e2e-1"]["role_label"], "調査担当")

    def test_正常系_フックが送ったリクエストは_本物のサーバーで_415_にならず_204_で受け付けられる(self):
        # send_to_server は応答を捨てるので、urlopen を包んで本物のサーバーの応答コードを記録する
        real_urlopen = log_event.urllib.request.urlopen
        response_statuses = []

        def recording_urlopen(request, timeout):
            response = real_urlopen(request, timeout=timeout)
            response_statuses.append(response.status)
            return response

        raw_text = '{"hook_event_name":"SubagentStart","agent_type":"researcher","agent_id":"e2e-ct"}'
        with mock.patch.object(log_event.urllib.request, "urlopen", side_effect=recording_urlopen), \
             redirect_stdout(io.StringIO()):
            log_event.send_to_server(raw_text)

        # 415 ではなく 204 が返り、在席にも入っている
        self.assertEqual(response_statuses, [204])
        self.assertIn("e2e-ct", server.present_agents)


if __name__ == "__main__":
    unittest.main()
