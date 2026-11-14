"""
画面ファイル（HTML / CSS / JS / SVG）が docs/ui_contract.md と docs/api.md の決まりを守っているか検査する。
（index.html に app.js が使う要素があるか、使っている URL が server.py に登録済みかも調べる）

使い方:
    python tools/check_static.py <フォルダ> [--server server.py のパス]
例:
    python tools/check_static.py static
    python tools/check_static.py proposals/chatgpt

フォルダの中（サブフォルダも含む）の .html / .htm / .css / .js / .svg を調べる。
問題があれば「NG ファイル:行: 内容」を出して終了コード 1、無ければ「OK」で終了コード 0。
"""
import argparse
import ast
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

# このファイルの1つ上がプロジェクトのフォルダ
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SERVER_FILE = PROJECT_ROOT / "server.py"

# index.html に必ず必要な要素の id（app.js が探す。docs/ui_contract.md と同じ）
REQUIRED_ELEMENT_IDS = (
    "connection-status",
    "scene",
    "scene-fx",
    "scene-empty",
    "light-toggle",
    "worker-list",
    "worker-detail",
    "activity-log",
    "side-crew",
    "side-events",
    "scene-population",
    "crew-total",
    "summary-present",
    "summary-enter",
    "summary-leave",
    "mock-controls",
    "mock-enter",
    "mock-leave",
    "mock-light",
    "mock-work",
    "mock-react",
    "mock-walk",
)

# index.html に必ず必要な作業場所（<div class="slot" data-role="…">）
REQUIRED_SLOT_ROLES = ("researcher", "coder", "test-runner", "code-reviewer", "code-explainer", "other")

# JS の文字列に書かれた、サーバーから読むファイルの URL（例 "/assets/octopus/coder.png"）
JS_LOCAL_FILE_URL_PATTERN = re.compile(r"""["'`](/[A-Za-z0-9_\-./]+\.[A-Za-z0-9]+)["'`]""")

# JS で使ってはいけない書き方（画面に HTML を文字列で入れる・文字列をコードとして動かす）
FORBIDDEN_JS_PATTERNS = (
    (re.compile(r"\binnerHTML\b"), "innerHTML は使えません（textContent を使う）"),
    (re.compile(r"\bouterHTML\b"), "outerHTML は使えません"),
    (re.compile(r"\binsertAdjacentHTML\b"), "insertAdjacentHTML は使えません"),
    (re.compile(r"\bdocument\s*\.\s*write(ln)?\b"), "document.write は使えません"),
    (re.compile(r"\beval\s*\("), "eval は使えません"),
    (re.compile(r"\bnew\s+Function\b"), "new Function は使えません"),
    (re.compile(r"\bset(Timeout|Interval)\s*\(\s*[\"'`]"), "setTimeout / setInterval に文字列は渡せません（関数を渡す）"),
)

# 外部の URL（http://, https://）
EXTERNAL_URL_PATTERN = re.compile(r"https?://", re.IGNORECASE)

# template の中（キャラクターの SVG）で使ってはいけない要素
FORBIDDEN_TEMPLATE_TAGS = {"script", "style", "foreignobject", "image", "iframe", "object", "embed"}


class Finding:
    """見つかった問題1件"""

    def __init__(self, file_path, line_number, message):
        self.file_path = file_path
        self.line_number = line_number
        self.message = message

    def __str__(self):
        return f"NG {self.file_path}:{self.line_number}: {self.message}"


def load_static_urls(server_file):
    """server.py の STATIC_FILES のキー（配っている URL）を、実行せずに読み取る"""
    source_text = Path(server_file).read_text(encoding="utf-8")
    syntax_tree = ast.parse(source_text)
    for node in ast.walk(syntax_tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "STATIC_FILES" for target in node.targets
        ):
            return set(ast.literal_eval(node.value).keys())
    raise ValueError(f"{server_file} に STATIC_FILES が見つかりません")


def classify_reference(url_text):
    """参照先の URL を分類する：'external' / 'local'（/ で始まる）/ 'fragment'（#...）/ 'relative'"""
    value = url_text.strip().strip("\"'").strip()
    lowered = value.lower()
    if lowered.startswith(("http:", "https:", "//", "data:", "javascript:", "blob:", "file:")):
        return "external", value
    if value.startswith("#"):
        return "fragment", value
    if value.startswith("/"):
        return "local", value
    return "relative", value


class HtmlChecker(HTMLParser):
    """HTML（と SVG）を1つずつ読んで、決まりに反するところを集める"""

    def __init__(self, file_path, static_urls, is_standalone_svg=False):
        super().__init__(convert_charrefs=True)
        self.file_path = file_path
        self.static_urls = static_urls
        self.findings = []
        self.element_ids = set()
        self.slot_roles = set()
        # template の中にいるか（SVG ファイルはまるごと template と同じ扱い）
        self.template_depth = 1 if is_standalone_svg else 0

    def add_finding(self, message):
        line_number, _ = self.getpos()
        self.findings.append(Finding(self.file_path, line_number, message))

    def handle_starttag(self, tag, attrs):
        self.check_tag(tag, attrs)
        if tag == "template":
            self.template_depth += 1

    def handle_startendtag(self, tag, attrs):
        # <circle ... /> のような閉じタグの無い要素
        self.check_tag(tag, attrs)

    def handle_endtag(self, tag):
        if tag == "template" and self.template_depth > 0:
            self.template_depth -= 1

    def check_tag(self, tag, attrs):
        attribute_map = {name: (value or "") for name, value in attrs}
        is_inside_template = self.template_depth > 0

        # ===== HTML に直接書いた CSS / JS =====
        if tag == "style":
            self.add_finding("<style> は使えません（CSS は style.css に書く）")
        if tag == "script" and "src" not in attribute_map:
            self.add_finding("<script> の直書きは使えません（JS は app.js に書く）")

        # ===== 属性 =====
        for attribute_name, attribute_value in attribute_map.items():
            if attribute_name == "style":
                self.add_finding(f"<{tag}> の style 属性は使えません（CSP で無効になる）")
            if attribute_name.startswith("on"):
                self.add_finding(f"<{tag}> の {attribute_name} 属性は使えません（イベントは app.js で扱う）")
            if attribute_name in ("href", "src", "xlink:href", "action", "srcset", "poster"):
                self.check_reference(tag, attribute_name, attribute_value, is_inside_template)

        # ===== 必須の要素の記録 =====
        if "id" in attribute_map and not is_inside_template:
            self.element_ids.add(attribute_map["id"])
        if "slot" in attribute_map.get("class", "").split() and "data-role" in attribute_map:
            self.slot_roles.add(attribute_map["data-role"])

        # ===== template の中の決まり（template を使うときのため） =====
        if is_inside_template:
            if tag in FORBIDDEN_TEMPLATE_TAGS:
                self.add_finding(f"キャラクターの中で <{tag}> は使えません")
            if "id" in attribute_map:
                self.add_finding(f"キャラクターの中の <{tag}> に id は付けられません（複製で重複するため）")
            for attribute_name, attribute_value in attribute_map.items():
                if "url(#" in attribute_value.replace(" ", ""):
                    self.add_finding(f"キャラクターの中で url(#…) は使えません（{attribute_name}）")

    def check_reference(self, tag, attribute_name, attribute_value, is_inside_template):
        """href / src などの参照先を調べる"""
        if is_inside_template:
            self.add_finding(f"キャラクターの中で {attribute_name} は使えません（<{tag}>）")
            return
        kind, value = classify_reference(attribute_value)
        if kind == "external":
            self.add_finding(f"外部・埋め込みの参照は使えません: {value}")
        elif kind == "relative":
            self.add_finding(f"相対パスは使えません（/ で始める）: {value}")
        elif kind == "local" and value not in self.static_urls:
            self.add_finding(f"STATIC_FILES に登録されていない URL です: {value}")


def check_html_file(file_path, display_name, static_urls, is_standalone_svg=False):
    """HTML / SVG ファイルを検査する"""
    text = file_path.read_text(encoding="utf-8")
    checker = HtmlChecker(display_name, static_urls, is_standalone_svg)
    checker.feed(text)
    checker.close()
    findings = list(checker.findings)

    # 外部 URL（属性以外に書かれたものも拾う）
    findings.extend(find_external_urls(text, display_name))

    # index.html には app.js が使う要素と作業場所が全部必要
    if file_path.name.lower() == "index.html":
        for element_id in REQUIRED_ELEMENT_IDS:
            if element_id not in checker.element_ids:
                findings.append(Finding(display_name, 1, f"id=\"{element_id}\" の要素がありません"))
        for role in REQUIRED_SLOT_ROLES:
            if role not in checker.slot_roles:
                findings.append(Finding(display_name, 1, f"作業場所 <div class=\"slot\" data-role=\"{role}\"> がありません"))
    return findings


def find_external_urls(text, display_name):
    """http:// / https:// が書かれた行を探す"""
    findings = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        if EXTERNAL_URL_PATTERN.search(line):
            findings.append(Finding(display_name, line_number, "外部の URL が書かれています"))
    return findings


def check_css_file(file_path, display_name, static_urls):
    """CSS ファイルを検査する"""
    findings = []
    text = file_path.read_text(encoding="utf-8")
    for line_number, line in enumerate(text.splitlines(), start=1):
        if re.search(r"@import\b", line, re.IGNORECASE):
            findings.append(Finding(display_name, line_number, "@import は使えません"))
        if re.search(r"\bexpression\s*\(", line, re.IGNORECASE):
            findings.append(Finding(display_name, line_number, "expression() は使えません"))
        # url(...) の参照先
        for url_match in re.finditer(r"url\(\s*([^)]*)\)", line, re.IGNORECASE):
            kind, value = classify_reference(url_match.group(1))
            if kind == "external":
                findings.append(Finding(display_name, line_number, f"外部・埋め込みの url() は使えません: {value}"))
            elif kind == "fragment":
                findings.append(Finding(display_name, line_number, f"url(#…) は使えません: {value}"))
            elif kind == "relative":
                findings.append(Finding(display_name, line_number, f"url() の相対パスは使えません（/ で始める）: {value}"))
            elif value not in static_urls:
                findings.append(Finding(display_name, line_number, f"STATIC_FILES に登録されていない URL です: {value}"))
    findings.extend(find_external_urls(text, display_name))
    return findings


def check_js_file(file_path, display_name, static_urls):
    """JS ファイルを検査する（// や * で始まるコメント行は飛ばす）"""
    findings = []
    text = file_path.read_text(encoding="utf-8")
    for line_number, line in enumerate(text.splitlines(), start=1):
        stripped_line = line.strip()
        if stripped_line.startswith(("//", "*", "/*")):
            continue
        for pattern, message in FORBIDDEN_JS_PATTERNS:
            if pattern.search(line):
                findings.append(Finding(display_name, line_number, message))
        if EXTERNAL_URL_PATTERN.search(line):
            findings.append(Finding(display_name, line_number, "外部の URL が書かれています"))
        # 画像などの URL は STATIC_FILES に登録が必要（/stream のような拡張子の無いものは対象外）
        for url_match in JS_LOCAL_FILE_URL_PATTERN.finditer(line):
            if url_match.group(1) not in static_urls:
                findings.append(
                    Finding(display_name, line_number, f"STATIC_FILES に登録されていない URL です: {url_match.group(1)}")
                )
    return findings


def check_folder(folder, static_urls):
    """フォルダの中の画面ファイルを全部検査し、(検査したファイル数, 問題のリスト) を返す"""
    folder = Path(folder)
    findings = []
    checked_count = 0
    for file_path in sorted(folder.rglob("*")):
        if not file_path.is_file():
            continue
        display_name = file_path.relative_to(folder).as_posix()
        suffix = file_path.suffix.lower()
        if suffix in (".html", ".htm"):
            findings.extend(check_html_file(file_path, display_name, static_urls))
        elif suffix == ".svg":
            findings.extend(check_html_file(file_path, display_name, static_urls, is_standalone_svg=True))
        elif suffix == ".css":
            findings.extend(check_css_file(file_path, display_name, static_urls))
        elif suffix == ".js":
            findings.extend(check_js_file(file_path, display_name, static_urls))
        else:
            continue
        checked_count += 1
    return checked_count, findings


def main(argument_list=None):
    parser = argparse.ArgumentParser(description="画面ファイルが決まりを守っているか検査する")
    parser.add_argument("folder", help="検査するフォルダ（例 static、proposals/chatgpt）")
    parser.add_argument("--server", default=str(DEFAULT_SERVER_FILE), help="STATIC_FILES を読む server.py のパス")
    arguments = parser.parse_args(argument_list)

    # Windows のコンソールでも日本語を出せるようにする
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    folder = Path(arguments.folder)
    if not folder.is_dir():
        print(f"フォルダが見つかりません: {folder}")
        return 2

    static_urls = load_static_urls(arguments.server)
    checked_count, findings = check_folder(folder, static_urls)

    for finding in findings:
        print(finding)
    if checked_count == 0:
        print(f"検査するファイルがありません: {folder}")
        return 2
    if findings:
        print(f"NG: {checked_count} ファイル中、問題 {len(findings)} 件")
        return 1
    print(f"OK: {checked_count} ファイル、問題なし")
    return 0


if __name__ == "__main__":
    sys.exit(main())
