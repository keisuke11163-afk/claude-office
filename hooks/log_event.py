"""
検証用フック：Claude Code から渡されたイベントをそのままログファイルに追記する。

使い方（settings.json の hooks から呼ばれる）:
    python log_event.py
標準入力（stdin）にフックのデータ(JSON)が流れてくる。
"""
import json
import os
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

# ログの保存先：このファイルの1つ上のフォルダにある logs/events.jsonl
LOG_FILE = Path(__file__).resolve().parent.parent / "logs" / "events.jsonl"

# 表示サーバーのポート（server.py と同じ環境変数。未設定なら 8765）
# 注意：server.py の DEFAULT_PORT / get_port と同じにすること（もう一方と揃える）
DEFAULT_PORT = 8765


def main():
    # stdin を UTF-8 として読む（Windows の既定文字コードだと日本語が化けるため）
    raw_text = sys.stdin.buffer.read().decode("utf-8", errors="replace")

    # JSONとして読めればオブジェクト、読めなければ文字列のまま残す
    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError:
        payload = {"unparsed": raw_text}

    # 受信時刻を付けて1行1JSON（JSON Lines形式）で追記する
    record = {"received_at": datetime.now().isoformat(timespec="milliseconds"), "payload": payload}
    # ログを書けなくても（ディスク満杯・権限なしなど）、サーバーへの送信は続ける
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as log:
            log.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass

    # JSONとして読めたものだけ、表示サーバーにも送る
    if isinstance(payload, dict) and "unparsed" not in payload:
        send_to_server(raw_text)


def send_to_server(raw_text):
    """フックの生データを表示サーバーに POST する。失敗しても何もしない"""
    # ポート番号を環境変数から決める（数字でなければ既定値）
    # 注意：server.py の get_port と同じ決め方にすること（もう一方と揃える）
    try:
        port = int(os.environ.get("CLAUDE_OFFICE_PORT", DEFAULT_PORT))
    except ValueError:
        port = DEFAULT_PORT
    # 送信内容を作る
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/events",
        data=raw_text.encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    # 0.2秒だけ待つ。サーバーが止まっていてもエラーにしない
    # （Windows では接続拒否でもタイムアウトまで待つことがあるので短くしている）
    try:
        with urllib.request.urlopen(request, timeout=0.2):
            pass
    except Exception:
        pass


if __name__ == "__main__":
    # フックが失敗しても Claude Code 本体の作業を止めないよう、例外は握りつぶして正常終了する
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
