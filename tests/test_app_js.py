"""
static/app.js の動作テスト（ヘッドレスの Edge / Chrome を使う、標準 unittest）

tests/js/app_test.html をブラウザで開き、--dump-dom で出た DOM の #test-result を読む。
Edge も Chrome も無いときは skip する。サーバーは起動しない（8765 は使わない）。
"""
import html
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
TEST_PAGE_PATH = PROJECT_ROOT / "tests" / "js" / "app_test.html"

# 探すブラウザの場所（Chrome を優先。この環境では Edge のヘッドレスが DOM を出さなかったため後ろにしている）
BROWSER_CANDIDATE_PATHS = (
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
    Path("/usr/bin/google-chrome"),
)

# ブラウザの実行を待つ上限（秒）
BROWSER_TIMEOUT_SECONDS = 60
# 仮想時間（ミリ秒）。テスト内の待ち（700ms × 6回ほど）が進むように十分な時間を与える
VIRTUAL_TIME_BUDGET_MS = 8000
# app_test.js に登録しているテストの数（増減したらここも直す）
EXPECTED_TEST_COUNT = 16


def find_browser_paths():
    """使えるブラウザの場所を、優先順に全部返す"""
    return [candidate_path for candidate_path in BROWSER_CANDIDATE_PATHS if candidate_path.is_file()]


def run_browser_dump_dom(browser_path):
    """ヘッドレスブラウザでテストページを開き、(出力された DOM, エラー出力) を返す"""
    # 一時的なプロファイルを使い、普段のブラウザの設定を汚さない
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as profile_folder:
        command = [
            str(browser_path),
            "--headless",
            "--disable-gpu",
            "--no-first-run",
            f"--user-data-dir={profile_folder}",
            f"--virtual-time-budget={VIRTUAL_TIME_BUDGET_MS}",
            "--dump-dom",
            TEST_PAGE_PATH.as_uri(),
        ]
        completed = subprocess.run(
            command,
            capture_output=True,
            timeout=BROWSER_TIMEOUT_SECONDS,
            check=False,
        )
    dom_text = completed.stdout.decode("utf-8", errors="replace")
    error_text = completed.stderr.decode("utf-8", errors="replace")
    return dom_text, error_text


def read_result_text(dom_text):
    """DOM から <pre id="test-result"> の文字を取り出す。見つからなければ None"""
    match = re.search(r'<pre id="test-result"[^>]*>(.*?)</pre>', dom_text, re.DOTALL)
    if match is None:
        return None
    return html.unescape(match.group(1)).strip()


class AppJsBrowserTest(unittest.TestCase):
    """ブラウザで app.js の動きを確かめる（ブラウザは1回だけ起動して結果を使い回す）"""

    result_text = None
    error_text = ""

    @classmethod
    def setUpClass(cls):
        browser_paths = find_browser_paths()
        if not browser_paths:
            raise unittest.SkipTest("Edge も Chrome も見つからないためスキップします")
        # 優先順にブラウザを試し、結果（#test-result）が取れた最初のものを使う
        for browser_path in browser_paths:
            try:
                dom_text, error_text = run_browser_dump_dom(browser_path)
            except subprocess.TimeoutExpired:
                cls.error_text = f"{browser_path.name}: {BROWSER_TIMEOUT_SECONDS} 秒以内に終わりませんでした"
                continue
            cls.error_text = f"{browser_path.name}: {error_text}"
            cls.result_text = read_result_text(dom_text)
            if cls.result_text is not None:
                break

    def test_result_is_written_to_dom(self):
        self.assertIsNotNone(
            self.result_text,
            f"#test-result が DOM に出ませんでした。ブラウザのエラー出力（先頭）: {self.error_text[:300]}",
        )

    def test_all_app_js_checks_pass(self):
        self.assertIsNotNone(self.result_text, "結果が無いので確認できません")
        self.assertEqual(
            self.result_text,
            f"PASS {EXPECTED_TEST_COUNT}",
            msg=f"app.js の確認に失敗があります: {self.result_text}",
        )


class AppTestPageSyncTest(unittest.TestCase):
    """tests/js/app_test.html の body が static/index.html の body と同じか（コピーの直し忘れ防止）"""

    def test_body_matches_index_html(self):
        index_text = (PROJECT_ROOT / "static" / "index.html").read_text(encoding="utf-8")
        test_page_text = TEST_PAGE_PATH.read_text(encoding="utf-8")
        index_body = re.search(r"<body[^>]*>(.*)</body>", index_text, re.DOTALL).group(1).strip()
        copied_body = re.search(r"<!-- ここから[^>]*-->\n(.*)\n<!-- ここまで -->", test_page_text, re.DOTALL)
        self.assertIsNotNone(copied_body, "app_test.html に「ここから」「ここまで」の印がありません")
        self.assertEqual(copied_body.group(1).strip(), index_body, "app_test.html の body を index.html に合わせてください")


if __name__ == "__main__":
    unittest.main()
