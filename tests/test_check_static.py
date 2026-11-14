"""
tools/check_static.py のテスト（標準 unittest）

server.py は実行せず、check_static が ast で STATIC_FILES を読むだけ。
違反ファイルは一時フォルダに作るので、本物の static/ や docs/ は変更しない。
"""
import contextlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CHECK_STATIC_PATH = PROJECT_ROOT / "tools" / "check_static.py"
REAL_STATIC_FOLDER = PROJECT_ROOT / "static"

# tools フォルダには __init__.py が無いので、ファイルの場所を直接指定して読み込む
_spec = importlib.util.spec_from_file_location("check_static", CHECK_STATIC_PATH)
check_static = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_static)

# index.html に必ず必要な要素の id と作業場所（docs/ui_contract.md と同じ）
ALL_REQUIRED_ELEMENT_IDS = check_static.REQUIRED_ELEMENT_IDS
ALL_REQUIRED_SLOT_ROLES = check_static.REQUIRED_SLOT_ROLES

# template の中身の初期値（違反なしの小さな SVG）
SAFE_CAT_SVG = '<svg viewBox="0 0 64 64"><circle cx="32" cy="36" r="20" fill="#b3b9b7"/></svg>'

# テスト用の server.py（STATIC_FILES に /images/x.png を足したもの）
SERVER_TEXT_WITH_IMAGE = (
    "STATIC_FILES = {\n"
    '    "/": ("index.html", "text/html; charset=utf-8"),\n'
    '    "/app.js": ("app.js", "text/javascript; charset=utf-8"),\n'
    '    "/style.css": ("style.css", "text/css; charset=utf-8"),\n'
    '    "/images/x.png": ("images/x.png", "image/png"),\n'
    "}\n"
)


def build_index_html(cat_inner_by_id=None, omit_ids=(), omit_roles=(), extra_body=""):
    """違反のない index.html を作る。
    cat_inner_by_id を渡すと template を作ってその中身にする。omit_ids の要素・omit_roles の作業場所は作らない"""
    cat_inner_by_id = cat_inner_by_id or {}
    element_parts = [f'<div id="{element_id}"></div>' for element_id in ALL_REQUIRED_ELEMENT_IDS if element_id not in omit_ids]
    slot_parts = [f'<div class="slot" data-role="{role}"></div>' for role in ALL_REQUIRED_SLOT_ROLES if role not in omit_roles]
    template_parts = [
        f'<template id="{template_id}">{inner_svg}</template>' for template_id, inner_svg in cat_inner_by_id.items()
    ]
    return (
        "<!doctype html><html lang='ja'><head><meta charset='utf-8'><title>t</title>"
        "<link rel='stylesheet' href='/style.css'>"
        "<script src='/app.js' defer></script></head>"
        "<body>" + extra_body + "".join(element_parts + slot_parts + template_parts) + "</body></html>"
    )


def run_check(files, server_text=None):
    """files（相対パス → 中身）を一時フォルダに作って main を呼ぶ。(終了コード, 表示文字) を返す"""
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_name:
        temp_folder = Path(temp_name)
        target_folder = temp_folder / "target"
        target_folder.mkdir()
        for relative_path, content in files.items():
            file_path = target_folder / relative_path
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(content, encoding="utf-8")

        argument_list = [str(target_folder)]
        if server_text is not None:
            server_path = temp_folder / "server.py"
            server_path.write_text(server_text, encoding="utf-8")
            argument_list += ["--server", str(server_path)]

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exit_code = check_static.main(argument_list)
        return exit_code, output.getvalue()


class CheckStaticNormalTest(unittest.TestCase):
    """正常系：本物の static/ は問題なし"""

    def test_real_static_folder_returns_0(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exit_code = check_static.main([str(REAL_STATIC_FOLDER)])
        self.assertEqual(exit_code, 0, msg=output.getvalue())
        self.assertIn("OK", output.getvalue())


class CheckStaticJsNgTest(unittest.TestCase):
    """異常系：JS で使ってはいけない書き方"""

    CASES = (
        ("innerHTML", 'element.innerHTML = "<b>x</b>";', "innerHTML は使えません"),
        ("outerHTML", 'element.outerHTML = "<b>x</b>";', "outerHTML は使えません"),
        ("insertAdjacentHTML", 'element.insertAdjacentHTML("beforeend", "<b>x</b>");', "insertAdjacentHTML は使えません"),
        ("document.write", 'document.write("x");', "document.write は使えません"),
        ("eval(", 'const value = eval("1 + 1");', "eval は使えません"),
        ("new Function", 'const make = new Function("return 1");', "new Function は使えません"),
        ('setTimeout("…")', 'setTimeout("alert(1)", 100);', "setTimeout / setInterval に文字列は渡せません"),
        ('setInterval("…")', 'setInterval("alert(1)", 100);', "setTimeout / setInterval に文字列は渡せません"),
        ("外部 URL", 'const imageUrl = "https://example.com/a.png";', "外部の URL が書かれています"),
        ("STATIC_FILES に無い画像", 'const imageUrl = "/images/x.png";', "STATIC_FILES に登録されていない URL です: /images/x.png"),
    )

    def test_each_forbidden_js_pattern_is_ng(self):
        for label, js_line, expected_message in self.CASES:
            with self.subTest(label=label):
                exit_code, output = run_check({"app.js": js_line + "\n"})
                self.assertEqual(exit_code, 1, msg=output)
                self.assertIn(expected_message, output)
                self.assertIn("NG app.js:1:", output)


class CheckStaticHtmlNgTest(unittest.TestCase):
    """異常系：HTML（ページ本体）で使ってはいけない書き方"""

    CASES = (
        ("<style>", "<html><head><style>p{color:red}</style></head><body></body></html>", "<style> は使えません"),
        ("style 属性", '<p style="color:red">x</p>', "style 属性は使えません"),
        ("on属性", '<button onclick="go()">x</button>', "onclick 属性は使えません"),
        ("src の無い <script>", "<script>alert(1)</script>", "<script> の直書きは使えません"),
        ("相対パス", '<link rel="stylesheet" href="style.css">', "相対パスは使えません"),
        ("STATIC_FILES に無い /images/x.png", '<img src="/images/x.png" alt="">', "STATIC_FILES に登録されていない URL です"),
        ("外部 URL（href）", '<a href="https://example.com/">x</a>', "外部・埋め込みの参照は使えません"),
    )

    def test_each_forbidden_html_pattern_is_ng(self):
        for label, html_text, expected_message in self.CASES:
            with self.subTest(label=label):
                exit_code, output = run_check({"page.html": html_text + "\n"})
                self.assertEqual(exit_code, 1, msg=output)
                self.assertIn(expected_message, output)
                self.assertIn("NG page.html:", output)


class CheckStaticTemplateNgTest(unittest.TestCase):
    """異常系：index.html の template の中の決まり違反と、必須の要素・作業場所の欠け"""

    CASES = (
        ("id", '<svg><circle id="head1" cx="1" cy="1" r="1"/></svg>', "キャラクターの中の <circle> に id は付けられません"),
        ("href", '<svg><use href="/style.css"/></svg>', "キャラクターの中で href は使えません"),
        ("url(#…)", '<svg><circle fill="url(#grad)" cx="1" cy="1" r="1"/></svg>', "url(#…) は使えません"),
        ("<script>", "<svg><script>alert(1)</script></svg>", "キャラクターの中で <script> は使えません"),
        ("<image>", '<svg><image x="0" y="0" width="1" height="1"/></svg>', "キャラクターの中で <image> は使えません"),
    )

    def test_each_forbidden_template_pattern_is_ng(self):
        for label, cat_inner, expected_message in self.CASES:
            with self.subTest(label=label):
                index_text = build_index_html(cat_inner_by_id={"cat-coder": cat_inner})
                exit_code, output = run_check({"index.html": index_text})
                self.assertEqual(exit_code, 1, msg=output)
                self.assertIn(expected_message, output)

    def test_missing_required_element_is_ng(self):
        for element_id in ALL_REQUIRED_ELEMENT_IDS:
            with self.subTest(element_id=element_id):
                index_text = build_index_html(omit_ids=(element_id,))
                exit_code, output = run_check({"index.html": index_text})
                self.assertEqual(exit_code, 1, msg=output)
                self.assertIn(f'id="{element_id}" の要素がありません', output)

    def test_missing_required_slot_is_ng(self):
        for role in ALL_REQUIRED_SLOT_ROLES:
            with self.subTest(role=role):
                index_text = build_index_html(omit_roles=(role,))
                exit_code, output = run_check({"index.html": index_text})
                self.assertEqual(exit_code, 1, msg=output)
                self.assertIn(f'data-role="{role}"> がありません', output)

    def test_id_inside_template_does_not_count_as_required_element(self):
        # template の中の id は画面に出ないので、必須の要素として数えない（id 自体も NG）
        index_text = build_index_html(omit_ids=("scene",), cat_inner_by_id={"t1": '<div id="scene"></div>'})
        exit_code, output = run_check({"index.html": index_text})
        self.assertEqual(exit_code, 1, msg=output)
        self.assertIn('id="scene" の要素がありません', output)

    def test_standalone_svg_is_treated_as_template(self):
        # .svg ファイルはまるごと template と同じ扱い（image は使えない）
        exit_code, output = run_check({"icon.svg": '<svg><image x="0" y="0"/></svg>\n'})
        self.assertEqual(exit_code, 1, msg=output)
        self.assertIn("キャラクターの中で <image> は使えません", output)


class CheckStaticCssNgTest(unittest.TestCase):
    """異常系：CSS で使ってはいけない書き方"""

    CASES = (
        ("@import", '@import "other.css";\nbody { color: red; }\n', "@import は使えません"),
        ("url(data:)", "body { background: url(data:image/png;base64,AAAA); }\n", "外部・埋め込みの url() は使えません"),
        ("url(#…)", ".dot { fill: url(#grad); }\n", "url(#…) は使えません"),
        ("url(http)", ".bg { background: url(https://example.com/a.png); }\n", "外部・埋め込みの url() は使えません"),
        ("STATIC_FILES に無い url", ".bg { background: url(/images/x.png); }\n", "STATIC_FILES に登録されていない URL です"),
    )

    def test_each_forbidden_css_pattern_is_ng(self):
        for label, css_text, expected_message in self.CASES:
            with self.subTest(label=label):
                exit_code, output = run_check({"style.css": css_text})
                self.assertEqual(exit_code, 1, msg=output)
                self.assertIn(expected_message, output)
                self.assertIn("NG style.css:", output)


class CheckStaticBoundaryTest(unittest.TestCase):
    """境界値：コメント行、登録済み URL、template 検査の対象、フォルダの有無、対象0件"""

    def test_comment_lines_in_js_are_not_ng(self):
        js_text = (
            '// element.innerHTML = "x";\n'
            '/* eval("1") */\n'
            "/*\n"
            ' * document.write("x");\n'
            " */\n"
        )
        exit_code, output = run_check({"app.js": js_text})
        self.assertEqual(exit_code, 0, msg=output)
        self.assertIn("OK", output)

    def test_registered_app_js_url_is_ok(self):
        # index.html の <script src="/app.js"> と <link href="/style.css"> は STATIC_FILES に登録済み
        exit_code, output = run_check({
            "index.html": build_index_html(),
            "style.css": "body { color: red; }\n",
            "app.js": 'const answer = 42;\n',
        })
        self.assertEqual(exit_code, 0, msg=output)

    def test_registered_js_url_and_stream_are_ok(self):
        # 登録済みの /style.css と、拡張子の無い /stream は JS に書いても OK
        js_text = 'const a = "/style.css";\nconst source = new EventSource("/stream");\n'
        exit_code, output = run_check({"app.js": js_text})
        self.assertEqual(exit_code, 0, msg=output)

    def test_folder_without_index_html_skips_template_check(self):
        exit_code, output = run_check({"style.css": "body { color: red; }\n"})
        self.assertEqual(exit_code, 0, msg=output)

    def test_missing_folder_returns_2(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_name:
            missing_folder = Path(temp_name) / "no_such_folder"
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                exit_code = check_static.main([str(missing_folder)])
        self.assertEqual(exit_code, 2)
        self.assertIn("フォルダが見つかりません", output.getvalue())

    def test_folder_without_target_files_returns_2(self):
        exit_code, output = run_check({"notes.txt": "検査対象ではない\n"})
        self.assertEqual(exit_code, 2, msg=output)
        self.assertIn("検査するファイルがありません", output)


class CheckStaticServerOptionTest(unittest.TestCase):
    """--server で渡した server.py の STATIC_FILES が使われる"""

    def test_url_added_to_custom_server_file_is_ok(self):
        index_text = build_index_html(extra_body='<img src="/images/x.png" alt="">')

        # 一時 server.py に /images/x.png があるので OK
        exit_code, output = run_check({"index.html": index_text}, server_text=SERVER_TEXT_WITH_IMAGE)
        self.assertEqual(exit_code, 0, msg=output)

        # 比べるため、本物の server.py（/images/x.png なし）では NG
        exit_code_default, output_default = run_check({"index.html": index_text})
        self.assertEqual(exit_code_default, 1, msg=output_default)
        self.assertIn("STATIC_FILES に登録されていない URL です: /images/x.png", output_default)


class StaticFilesExistTest(unittest.TestCase):
    """server.py の STATIC_FILES に登録したファイルが、static/ に全部あるか"""

    def test_every_registered_file_exists(self):
        import ast

        source_text = (PROJECT_ROOT / "server.py").read_text(encoding="utf-8")
        for node in ast.walk(ast.parse(source_text)):
            if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == "STATIC_FILES" for target in node.targets
            ):
                static_files = ast.literal_eval(node.value)
                break
        else:
            self.fail("server.py に STATIC_FILES が見つかりません")
        for url_path, (file_name, _content_type) in static_files.items():
            with self.subTest(url=url_path):
                self.assertTrue((REAL_STATIC_FOLDER / file_name).is_file(), f"{file_name} がありません")


if __name__ == "__main__":
    unittest.main()
