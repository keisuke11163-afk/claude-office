"""
server.py のテスト（標準 unittest。実行: python -m unittest discover -s tests -v）

観点：正常系・境界値・異常系、そして HTTP 経由の動作。
"""
import http.client
import io
import json
import socket
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from contextlib import contextmanager, redirect_stdout
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

# 親フォルダ（claude-office）を import できるようにする
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import server  # noqa: E402


class ServerStateTestCase(unittest.TestCase):
    """各テストの前に共有状態を空にし、終わったら元に戻す基底クラス"""

    def setUp(self):
        # 在席・モデル情報をリセットする
        server.present_agents.clear()
        server.known_models.clear()
        server.left_agent_ids.clear()
        server.early_stopped_ids.clear()
        server.stream_queues.clear()
        # 定義ファイルの場所を一時フォルダに差し替える（本物の ~/.claude/agents を読まないため）
        self.temp_dir = tempfile.TemporaryDirectory()
        self.agent_dir = Path(self.temp_dir.name)
        self.original_definition_dir = server.AGENT_DEFINITION_DIR
        server.AGENT_DEFINITION_DIR = self.agent_dir
        # verbose_mode を保存して、テスト後に戻す
        self.original_verbose_mode = server.verbose_mode
        server.verbose_mode = False

    def tearDown(self):
        server.verbose_mode = self.original_verbose_mode
        server.AGENT_DEFINITION_DIR = self.original_definition_dir
        self.temp_dir.cleanup()
        server.present_agents.clear()
        server.known_models.clear()
        server.left_agent_ids.clear()
        server.early_stopped_ids.clear()
        server.stream_queues.clear()

    def write_definition(self, agent_type, text):
        """一時フォルダにエージェント定義ファイル(.md)を作る"""
        (self.agent_dir / f"{agent_type}.md").write_text(text, encoding="utf-8")


class ShortenModelNameTest(unittest.TestCase):
    """モデル名の短縮"""

    def test_正常系_claude_opus_は_opus_になる(self):
        self.assertEqual(server.shorten_model_name("claude-opus-5-5"), "opus")

    def test_正常系_大文字小文字は区別しない(self):
        self.assertEqual(server.shorten_model_name("Claude-Sonnet-4"), "sonnet")

    def test_異常系_知らないモデル名はそのまま返す(self):
        self.assertEqual(server.shorten_model_name("gpt-4"), "gpt-4")


class ConfigTest(unittest.TestCase):
    """設定の読み込み（ポート番号・roles.json）"""

    @contextmanager
    def use_temp_roles_file(self, text):
        """roles.json の場所を、text を書いた一時ファイルに差し替える（with の間だけ）"""
        with tempfile.TemporaryDirectory() as temp_dir_name:
            temp_roles_file = Path(temp_dir_name) / "roles.json"
            temp_roles_file.write_text(text, encoding="utf-8")
            original_roles_file = server.ROLES_FILE
            server.ROLES_FILE = temp_roles_file
            try:
                yield
            finally:
                server.ROLES_FILE = original_roles_file

    def test_正常系_roles_json_から_表示名を読める(self):
        # 本物の roles.json の中身に頼らないよう、一時ファイルに差し替える
        with self.use_temp_roles_file('{"researcher": "調査担当"}'):
            self.assertEqual(server.load_role_names()["researcher"], "調査担当")

    def test_異常系_roles_json_が辞書でなければ空の辞書(self):
        with self.use_temp_roles_file('["researcher", "調査担当"]'):
            self.assertEqual(server.load_role_names(), {})

    def test_異常系_roles_json_が無ければ空の辞書(self):
        original_roles_file = server.ROLES_FILE
        server.ROLES_FILE = Path(tempfile.gettempdir()) / "claude_office_not_exists_roles.json"
        try:
            self.assertEqual(server.load_role_names(), {})
        finally:
            server.ROLES_FILE = original_roles_file

    def test_境界値_ポート番号は環境変数で決まり_不正なら既定値(self):
        import os
        original_value = os.environ.get("CLAUDE_OFFICE_PORT")
        try:
            os.environ["CLAUDE_OFFICE_PORT"] = "9000"
            self.assertEqual(server.get_port(), 9000)
            os.environ["CLAUDE_OFFICE_PORT"] = "abc"
            self.assertEqual(server.get_port(), server.DEFAULT_PORT)
            os.environ.pop("CLAUDE_OFFICE_PORT", None)
            self.assertEqual(server.get_port(), server.DEFAULT_PORT)
        finally:
            if original_value is None:
                os.environ.pop("CLAUDE_OFFICE_PORT", None)
            else:
                os.environ["CLAUDE_OFFICE_PORT"] = original_value


class StartStopTest(ServerStateTestCase):
    """SubagentStart（入室）と SubagentStop（退室）"""

    def test_正常系_Start_で入室し_role_label_が_roles_json_から付く(self):
        # 入室イベントを作る
        event = server.handle_event({
            "hook_event_name": "SubagentStart",
            "agent_type": "researcher",
            "agent_id": "abcdef123456",
        })
        self.assertEqual(event["kind"], "enter")
        self.assertEqual(event["role_label"], "調査担当")
        self.assertIn("abcdef123456", server.present_agents)
        self.assertEqual(server.present_agents["abcdef123456"]["role_label"], "調査担当")

    def test_正常系_Stop_で退室し_present_agents_から消える(self):
        server.handle_event({"hook_event_name": "SubagentStart", "agent_type": "researcher", "agent_id": "id1"})
        event = server.handle_event({"hook_event_name": "SubagentStop", "agent_type": "researcher", "agent_id": "id1"})
        self.assertEqual(event["kind"], "leave")
        self.assertEqual(event["role_label"], "調査担当")
        self.assertNotIn("id1", server.present_agents)

    def test_正常系_roles_json_に無い_agent_type_は_agent_type_がそのまま表示名になる(self):
        event = server.handle_event({"hook_event_name": "SubagentStart", "agent_type": "unknown-type", "agent_id": "id2"})
        self.assertEqual(event["role_label"], "unknown-type")

    def test_正常系_Start_Stop_PostToolUse_の順に届いても_状態が残らず_PostToolUse_は無視される(self):
        # 前景実行では Stop のあとに PostToolUse が届く
        server.handle_event({"hook_event_name": "SubagentStart", "agent_type": "researcher", "agent_id": "fg-1"})
        server.handle_event({"hook_event_name": "SubagentStop", "agent_type": "researcher", "agent_id": "fg-1"})
        event = server.handle_event({
            "hook_event_name": "PostToolUse",
            "tool_name": "Agent",
            "tool_response": {"agentId": "fg-1", "resolvedModel": "claude-haiku-5-5"},
        })
        self.assertEqual(event["kind"], "ignored")
        self.assertFalse(event["show_by_default"])
        self.assertEqual(server.known_models, {})
        self.assertEqual(server.present_agents, {})

    def test_正常系_handle_start_のファイル読み込みは鍵の外で行われる(self):
        lock_states = []

        def fake_read_model(agent_type):
            lock_states.append(("定義ファイル", server.state_lock.locked()))
            return None

        def fake_load_role_names():
            lock_states.append(("roles.json", server.state_lock.locked()))
            return {}

        with mock.patch.object(server, "read_model_from_definition", side_effect=fake_read_model), \
             mock.patch.object(server, "load_role_names", side_effect=fake_load_role_names):
            server.handle_start("lock-1", "researcher")

        # 2か所とも呼ばれ、呼ばれた瞬間は鍵がかかっていない
        self.assertEqual(lock_states, [("定義ファイル", False), ("roles.json", False)])

    def test_並行_20スレッドで_Start_PostToolUse_Stop_を同時に送っても状態が残らない(self):
        thread_count = 20
        errors = []

        def run_one_agent(agent_number):
            """1人分の Start -> PostToolUse -> Stop を順に送る"""
            agent_id = f"thread-{agent_number}"
            try:
                server.handle_event({"hook_event_name": "SubagentStart", "agent_type": "researcher", "agent_id": agent_id})
                server.handle_event({
                    "hook_event_name": "PostToolUse",
                    "tool_name": "Agent",
                    "tool_response": {"agentId": agent_id, "resolvedModel": "claude-haiku-5-5"},
                })
                server.handle_event({"hook_event_name": "SubagentStop", "agent_type": "researcher", "agent_id": agent_id})
            except Exception as error:  # スレッドの中の失敗は、あとで集めて確認する
                errors.append(error)

        threads = [threading.Thread(target=run_one_agent, args=(number,)) for number in range(thread_count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertEqual(errors, [])
        self.assertEqual(server.present_agents, {})
        self.assertEqual(server.known_models, {})


class ModelResolutionTest(ServerStateTestCase):
    """モデル名の決め方：resolvedModel → 定義ファイル → 不明"""

    def test_正常系_PostToolUse_が_Start_より前に来ても_haiku_になる(self):
        # 先に PostToolUse（モデル判明）が届く
        server.handle_event({
            "hook_event_name": "PostToolUse",
            "tool_name": "Agent",
            "tool_response": {"agentId": "id3", "resolvedModel": "claude-haiku-5-5"},
        })
        # あとから Start が届く
        event = server.handle_event({"hook_event_name": "SubagentStart", "agent_type": "researcher", "agent_id": "id3"})
        self.assertEqual(event["model"], "haiku")
        self.assertEqual(server.present_agents["id3"]["model"], "haiku")

    def test_正常系_PostToolUse_が_Start_より後に来ると_在席中のモデル名が更新される(self):
        server.handle_event({"hook_event_name": "SubagentStart", "agent_type": "researcher", "agent_id": "id4"})
        # Start の時点では定義ファイルも無いので「不明」
        self.assertEqual(server.present_agents["id4"]["model"], "不明")
        event = server.handle_event({
            "hook_event_name": "PostToolUse",
            "tool_name": "Task",
            "tool_response": {"agentId": "id4", "resolvedModel": "claude-haiku-5-5"},
        })
        self.assertEqual(event["kind"], "model")
        self.assertEqual(event["model"], "haiku")
        self.assertEqual(server.present_agents["id4"]["model"], "haiku")

    def test_正常系_モデル名が無いとき_定義ファイルの_model_を使う(self):
        self.write_definition("coder", "---\nname: coder\nmodel: sonnet\n---\n本文\n")
        event = server.handle_event({"hook_event_name": "SubagentStart", "agent_type": "coder", "agent_id": "id5"})
        self.assertEqual(event["model"], "sonnet")

    def test_正常系_定義ファイルの_model_は_引用符があっても外せる(self):
        self.write_definition("coder", "---\nmodel: \"opus\"\n---\n")
        self.assertEqual(server.read_model_from_definition("coder"), "opus")

    def test_異常系_モデル名も定義ファイルも無ければ_不明(self):
        event = server.handle_event({"hook_event_name": "SubagentStart", "agent_type": "nothing", "agent_id": "id6"})
        self.assertEqual(event["model"], "不明")

    def test_異常系_frontmatter_の外にある_model_行は読まない(self):
        self.write_definition("coder", "本文の前置き\nmodel: opus\n")
        self.assertIsNone(server.read_model_from_definition("coder"))

    def test_異常系_frontmatter_が閉じられる前に_model_が無ければ_None(self):
        self.write_definition("coder", "---\nname: coder\n---\nmodel: opus\n")
        self.assertIsNone(server.read_model_from_definition("coder"))

    def test_異常系_model_の値が空なら_None(self):
        self.write_definition("coder", "---\nmodel:\n---\n")
        self.assertIsNone(server.read_model_from_definition("coder"))

    def test_異常系_model_が_inherit_なら_None_大文字小文字は問わない(self):
        for inherit_text in ("inherit", "Inherit", "INHERIT"):
            self.write_definition("coder", f"---\nmodel: {inherit_text}\n---\n")
            self.assertIsNone(server.read_model_from_definition("coder"))

    def test_正常系_BOM_付きの定義ファイルでも_model_を読める(self):
        # Windows のメモ帳などが付ける BOM（ファイル先頭の目印）つきで保存する
        (self.agent_dir / "coder.md").write_text("---\nmodel: opus\n---\n", encoding="utf-8-sig")
        self.assertEqual(server.read_model_from_definition("coder"), "opus")

    def test_異常系_agent_type_に_パス区切りがあれば定義ファイルを読まない(self):
        # 一時フォルダの1つ上に定義ファイルを置き、../ で読めないことを確かめる
        outside_file = self.agent_dir.parent / "outside_agent_test.md"
        outside_file.write_text("---\nmodel: opus\n---\n", encoding="utf-8")
        try:
            self.assertIsNone(server.read_model_from_definition("../outside_agent_test"))
            self.assertIsNone(server.read_model_from_definition("sub/coder"))
            self.assertIsNone(server.read_model_from_definition("..\\outside_agent_test"))
            event = server.handle_event({
                "hook_event_name": "SubagentStart",
                "agent_type": "../outside_agent_test",
                "agent_id": "id7",
            })
            self.assertEqual(event["model"], "不明")
        finally:
            outside_file.unlink(missing_ok=True)


class FilterTest(ServerStateTestCase):
    """無視（ignored）するイベントと、表示するかどうかの判定"""

    def test_境界値_agent_type_が空文字の_Start_は無視_表示しない(self):
        event = server.handle_event({"hook_event_name": "SubagentStart", "agent_type": "", "agent_id": "f1"})
        self.assertEqual(event["kind"], "ignored")
        self.assertFalse(event["show_by_default"])
        self.assertFalse(server.should_print(event))
        self.assertEqual(server.present_agents, {})

    def test_境界値_agent_type_が空白だけの_Start_は無視(self):
        event = server.handle_event({"hook_event_name": "SubagentStart", "agent_type": "   ", "agent_id": "f2"})
        self.assertEqual(event["kind"], "ignored")
        self.assertEqual(server.present_agents, {})

    def test_境界値_agent_id_が空文字の_Start_は無視(self):
        event = server.handle_event({"hook_event_name": "SubagentStart", "agent_type": "researcher", "agent_id": ""})
        self.assertEqual(event["kind"], "ignored")
        self.assertFalse(event["show_by_default"])
        self.assertEqual(server.present_agents, {})

    def test_異常系_agent_type_が空の_SubagentStop_は_通常表示する(self):
        event = server.handle_event({"hook_event_name": "SubagentStop", "agent_type": "", "agent_id": "f3"})
        self.assertEqual(event["kind"], "ignored")
        self.assertTrue(event["show_by_default"])
        self.assertTrue(server.should_print(event))

    def test_異常系_Start_が来ていない_agent_id_の_SubagentStop_は_通常表示する(self):
        event = server.handle_event({"hook_event_name": "SubagentStop", "agent_type": "researcher", "agent_id": "never-started"})
        self.assertEqual(event["kind"], "ignored")
        self.assertTrue(event["show_by_default"])
        self.assertTrue(server.should_print(event))

    def test_異常系_対象外のイベント_PreToolUse_は_無視_通常は表示しない(self):
        event = server.handle_event({"hook_event_name": "PreToolUse", "tool_name": "Bash"})
        self.assertEqual(event["kind"], "ignored")
        self.assertFalse(event["show_by_default"])
        self.assertFalse(server.should_print(event))

    def test_正常系_verbose_mode_が_True_なら_対象外_PreToolUse_も表示する(self):
        server.verbose_mode = True
        event = server.handle_event({"hook_event_name": "PreToolUse", "tool_name": "Bash"})
        self.assertTrue(server.should_print(event))

    def test_正常系_表示対象の_enter_や_leave_は_verbose_に関係なく表示する(self):
        server.handle_event({"hook_event_name": "SubagentStart", "agent_type": "researcher", "agent_id": "f4"})
        event = server.handle_event({"hook_event_name": "SubagentStop", "agent_type": "researcher", "agent_id": "f4"})
        self.assertTrue(server.should_print(event))

    def test_異常系_PostToolUse_で_Agent_以外のツールは無視(self):
        event = server.handle_event({
            "hook_event_name": "PostToolUse",
            "tool_name": "Bash",
            "tool_response": {"agentId": "f5", "resolvedModel": "claude-haiku-5-5"},
        })
        self.assertEqual(event["kind"], "ignored")
        self.assertNotIn("f5", server.known_models)

    def test_異常系_PostToolUse_で_resolvedModel_が無ければ無視(self):
        event = server.handle_event({
            "hook_event_name": "PostToolUse",
            "tool_name": "Agent",
            "tool_response": {"agentId": "f6"},
        })
        self.assertEqual(event["kind"], "ignored")

    def test_異常系_PostToolUse_で_tool_response_が文字列なら無視(self):
        event = server.handle_event({"hook_event_name": "PostToolUse", "tool_name": "Agent", "tool_response": "text"})
        self.assertEqual(event["kind"], "ignored")


class ConsoleFormatTest(ServerStateTestCase):
    """コンソールに出す1行の文字列"""

    def test_正常系_入室の表示文字列(self):
        event = server.handle_event({"hook_event_name": "SubagentStart", "agent_type": "researcher", "agent_id": "abcdefghijkl"})
        self.assertEqual(server.format_event(event), "入室 abcdefgh 調査担当(researcher) / 不明")

    def test_正常系_無視イベントの表示文字列(self):
        event = server.make_ignored_event("テスト理由")
        self.assertEqual(server.format_event(event), "無視: テスト理由")


class HttpTestCase(ServerStateTestCase):
    """実際に HTTP サーバーを別スレッドで起動して送る"""

    def setUp(self):
        super().setUp()
        # 空いているポートを自動で選ぶ（ポート 0）
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.EventRequestHandler)
        self.port = self.httpd.server_address[1]
        self.server_thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.server_thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.server_thread.join(timeout=5)
        super().tearDown()

    def post_raw(self, body_bytes, path="/events", extra_headers=None):
        """生のバイト列を POST して、HTTP ステータスコードを返す"""
        headers = {"Content-Type": "application/json"}
        headers.update(extra_headers or {})
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=body_bytes,
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status
        except urllib.error.HTTPError as error:
            # エラー応答も接続を持っているので、with で閉じてから番号を返す（ResourceWarning 対策）
            with error:
                return error.code

    def post_json(self, payload):
        """辞書を JSON にして POST する"""
        return self.post_raw(json.dumps(payload).encode("utf-8"))

    def run_quietly(self, function, *args, **kwargs):
        """サーバーのコンソール出力をテスト結果に混ぜないため、標準出力を捨てて実行する"""
        with redirect_stdout(io.StringIO()):
            return function(*args, **kwargs)


class HttpEventsTest(HttpTestCase):
    """POST /events の正常系・境界値・異常系"""

    def test_正常系_Start_を_POST_すると_204_で在席に入る(self):
        status = self.run_quietly(self.post_json, {
            "hook_event_name": "SubagentStart",
            "agent_type": "researcher",
            "agent_id": "http-1",
        })
        self.assertEqual(status, 204)
        self.assertEqual(server.present_agents["http-1"]["role_label"], "調査担当")

    def test_正常系_Start_のあと_Stop_を_POST_すると在席から消える(self):
        self.run_quietly(self.post_json, {"hook_event_name": "SubagentStart", "agent_type": "researcher", "agent_id": "http-2"})
        status = self.run_quietly(self.post_json, {"hook_event_name": "SubagentStop", "agent_type": "researcher", "agent_id": "http-2"})
        self.assertEqual(status, 204)
        self.assertNotIn("http-2", server.present_agents)

    def test_正常系_PostToolUse_で_モデル名が_haiku_になる(self):
        status = self.run_quietly(self.post_json, {
            "hook_event_name": "PostToolUse",
            "tool_name": "Agent",
            "tool_response": {"agentId": "http-3", "resolvedModel": "claude-haiku-5-5"},
        })
        self.assertEqual(status, 204)
        self.assertEqual(server.known_models["http-3"], "haiku")

    def test_境界値_Content_Length_0_は_400(self):
        status = self.run_quietly(self.post_raw, b"")
        self.assertEqual(status, 400)

    def test_境界値_本文が_MAX_BODY_BYTES_ちょうどなら_受け付ける(self):
        # 最大サイズと同じ長さになるよう、余白(pad)で長さを合わせる
        prefix = b'{"hook_event_name":"PreToolUse","pad":"'
        suffix = b'"}'
        pad_length = server.MAX_BODY_BYTES - len(prefix) - len(suffix)
        body = prefix + b"a" * pad_length + suffix
        self.assertEqual(len(body), server.MAX_BODY_BYTES)
        status = self.run_quietly(self.post_raw, body)
        self.assertEqual(status, 204)

    def test_境界値_本文が_MAX_BODY_BYTES_を超えたら_400(self):
        # 本文は送らず、ヘッダーの Content-Length だけ超過した値にする（サーバーは本文を読まずに返す）
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.putrequest("POST", "/events")
            connection.putheader("Content-Type", "application/json")
            connection.putheader("Content-Length", str(server.MAX_BODY_BYTES + 1))
            connection.endheaders()
            response = self.run_quietly(connection.getresponse)
            self.assertEqual(response.status, 400)
        finally:
            connection.close()

    def test_異常系_Content_Length_が数字でなければ_400(self):
        status = self.run_quietly(self.post_raw, b"", extra_headers={"Content-Length": "abc"})
        self.assertEqual(status, 400)

    def test_異常系_不正なJSONは_400(self):
        status = self.run_quietly(self.post_raw, b"{not json")
        self.assertEqual(status, 400)

    def test_異常系_UTF8_でない本文は_400(self):
        status = self.run_quietly(self.post_raw, b"\xff\xfe\xfd")
        self.assertEqual(status, 400)

    def test_異常系_JSON_配列は_400(self):
        status = self.run_quietly(self.post_raw, b'[{"hook_event_name":"SubagentStart"}]')
        self.assertEqual(status, 400)

    def test_異常系_events_以外のパスは_404(self):
        # 対照：同じ本文でも /events なら受け付ける（204）
        body = b'{"hook_event_name":"PreToolUse"}'
        self.assertEqual(self.run_quietly(self.post_raw, body), 204)
        # 別のパスは 404
        self.assertEqual(self.run_quietly(self.post_raw, b"", path="/other"), 404)
        self.assertEqual(self.run_quietly(self.post_raw, b"", path="/events/extra"), 404)

    def test_異常系_本文つきで_events_以外のパスに_POST_しても_404(self):
        # 本文を読んでから 404 を返すので、Windows でも接続が切られず安定する
        body = b'{"hook_event_name":"PreToolUse"}'
        self.assertEqual(self.run_quietly(self.post_raw, body, path="/other"), 404)
        self.assertEqual(self.run_quietly(self.post_raw, body, path="/events/extra"), 404)

    def test_異常系_SubagentStop_で_Start_が無い_agent_id_は_204_で_在席に影響なし(self):
        status = self.run_quietly(self.post_json, {
            "hook_event_name": "SubagentStop",
            "agent_type": "researcher",
            "agent_id": "ghost",
        })
        self.assertEqual(status, 204)
        self.assertEqual(server.present_agents, {})

    def test_異常系_handle_event_が例外を出したら_500(self):
        with mock.patch.object(server, "handle_event", side_effect=RuntimeError("テスト用の失敗")):
            status = self.run_quietly(self.post_json, {"hook_event_name": "SubagentStart"})
        self.assertEqual(status, 500)

    def test_異常系_Content_Type_が_text_plain_なら_415(self):
        body = b'{"hook_event_name":"SubagentStart","agent_type":"researcher","agent_id":"csrf-1"}'
        status = self.run_quietly(self.post_raw, body, extra_headers={"Content-Type": "text/plain"})
        self.assertEqual(status, 415)
        # 弾いたので、イベントは処理されていない
        self.assertEqual(server.present_agents, {})

    def test_正常系_Content_Type_に_charset_が付いていても受け付ける(self):
        body = b'{"hook_event_name":"SubagentStart","agent_type":"researcher","agent_id":"charset-1"}'
        status = self.run_quietly(
            self.post_raw, body, extra_headers={"Content-Type": "application/json; charset=utf-8"}
        )
        self.assertEqual(status, 204)
        self.assertIn("charset-1", server.present_agents)

    def test_境界値_Content_Type_は大文字小文字を区別しない(self):
        body = b'{"hook_event_name":"SubagentStart","agent_type":"researcher","agent_id":"case-1"}'
        status = self.run_quietly(
            self.post_raw, body, extra_headers={"Content-Type": "Application/JSON"}
        )
        self.assertEqual(status, 204)
        self.assertIn("case-1", server.present_agents)

    def test_境界値_Content_Type_が_application_jsonx_なら_415(self):
        # 前方一致ではなく完全一致で判定する
        body = b'{"hook_event_name":"SubagentStart","agent_type":"researcher","agent_id":"prefix-1"}'
        status = self.run_quietly(
            self.post_raw, body, extra_headers={"Content-Type": "application/jsonx"}
        )
        self.assertEqual(status, 415)
        self.assertEqual(server.present_agents, {})


class LeftAgentLimitTest(ServerStateTestCase):
    """退室済み agent_id の上限（MAX_LEFT_AGENT_IDS）と、入室し直したときの扱い"""

    def let_agents_come_and_go(self, agent_ids):
        """指定した agent_id を順に入室・退室させる"""
        for agent_id in agent_ids:
            server.handle_event({"hook_event_name": "SubagentStart", "agent_type": "researcher", "agent_id": agent_id})
            server.handle_event({"hook_event_name": "SubagentStop", "agent_type": "researcher", "agent_id": agent_id})

    def report_model(self, agent_id, resolved_model="claude-haiku-5-5"):
        """PostToolUse（モデル判明）を送る"""
        return server.handle_event({
            "hook_event_name": "PostToolUse",
            "tool_name": "Agent",
            "tool_response": {"agentId": agent_id, "resolvedModel": resolved_model},
        })

    def test_境界値_上限ちょうど200人までは_1人目も残る(self):
        agent_ids = [f"left-{number}" for number in range(server.MAX_LEFT_AGENT_IDS)]
        self.let_agents_come_and_go(agent_ids)
        self.assertEqual(len(server.left_agent_ids), 200)
        self.assertIn("left-0", server.left_agent_ids)

    def test_境界値_201人目の退室で_1人目が消える(self):
        agent_ids = [f"left-{number}" for number in range(server.MAX_LEFT_AGENT_IDS + 1)]
        self.let_agents_come_and_go(agent_ids)
        self.assertEqual(len(server.left_agent_ids), 200)
        self.assertNotIn("left-0", server.left_agent_ids)
        self.assertIn("left-1", server.left_agent_ids)
        self.assertIn("left-200", server.left_agent_ids)

    def test_境界値_上限で消えた古い_id_の_PostToolUse_は_known_models_に登録される(self):
        # これは上限を設けたことの副作用：一覧から消えた id は「退室済み」と判定されない
        agent_ids = [f"left-{number}" for number in range(server.MAX_LEFT_AGENT_IDS + 1)]
        self.let_agents_come_and_go(agent_ids)

        event = self.report_model("left-0")
        self.assertEqual(event["kind"], "model")
        self.assertEqual(server.known_models["left-0"], "haiku")

        # まだ一覧に残っている left-1 の PostToolUse は、従来どおり無視される
        ignored_event = self.report_model("left-1")
        self.assertEqual(ignored_event["kind"], "ignored")
        self.assertNotIn("left-1", server.known_models)

    def test_異常系_退室済みの_id_で_再入室すると_一覧から外れ_その後_PostToolUse_でモデル名が更新される(self):
        self.let_agents_come_and_go(["re-1"])
        self.assertIn("re-1", server.left_agent_ids)

        server.handle_event({"hook_event_name": "SubagentStart", "agent_type": "researcher", "agent_id": "re-1"})
        self.assertNotIn("re-1", server.left_agent_ids)
        self.assertIn("re-1", server.present_agents)

        event = self.report_model("re-1")
        self.assertEqual(event["kind"], "model")
        self.assertEqual(server.present_agents["re-1"]["model"], "haiku")


class HandlerSettingsTest(unittest.TestCase):
    """HTTP ハンドラの設定値"""

    def test_正常系_ハンドラの_timeout_は_5秒(self):
        self.assertEqual(server.EventRequestHandler.timeout, 5)


class MissingContentTypeHttpTest(HttpTestCase):
    """Content-Type ヘッダーが無い POST"""

    def test_異常系_Content_Type_ヘッダーが無い_POST_は_415(self):
        # 本文なし（Content-Length 0）の場合
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.putrequest("POST", "/events")
            connection.putheader("Content-Length", "0")
            connection.endheaders()
            response = self.run_quietly(connection.getresponse)
            self.assertEqual(response.status, 415)
        finally:
            connection.close()
        self.assertEqual(server.present_agents, {})

    def test_異常系_Content_Type_ヘッダーが無く_本文つきの_POST_も_415(self):
        # 本文を先に読んでから 415 を返すので、本文つきでも接続が切られず安定する
        request_body = b'{"hook_event_name":"SubagentStart","agent_type":"researcher","agent_id":"no-ct-1"}'
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.putrequest("POST", "/events")
            connection.putheader("Content-Length", str(len(request_body)))
            connection.endheaders(request_body)
            response = self.run_quietly(connection.getresponse)
            self.assertEqual(response.status, 415)
        finally:
            connection.close()
        self.assertEqual(server.present_agents, {})


class SlowClientTimeoutTest(HttpTestCase):
    """本文を送ってこないクライアントは、ハンドラの timeout で切られる"""

    def setUp(self):
        # timeout はリクエスト処理の開始時(setup)に読まれるので、サーバーを起動する前に差し替え、
        # テストが終わるまで(cleanup で)元に戻さない
        timeout_patcher = mock.patch.object(server.EventRequestHandler, "timeout", 0.3)
        timeout_patcher.start()
        self.addCleanup(timeout_patcher.stop)
        super().setUp()

    def test_異常系_本文が届かない接続は_timeout_で切られる(self):
        # Content-Length 10 と宣言するが、本文は1バイトも送らない
        incomplete_request = (
            "POST /events HTTP/1.1\r\n"
            "Host: x\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 10\r\n"
            "\r\n"
        ).encode("ascii")
        with socket.create_connection(("127.0.0.1", self.port), timeout=2) as client_socket:
            client_socket.sendall(incomplete_request)
            try:
                received_bytes = client_socket.recv(1024)
            except ConnectionResetError:
                received_bytes = b""
        # 2秒以内にサーバー側から閉じられた（待ち続けると recv が TimeoutError になりテスト失敗）
        self.assertEqual(received_bytes, b"")


if __name__ == "__main__":
    unittest.main()
