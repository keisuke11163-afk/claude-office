"use strict";

// 履歴に残す最大件数
const MAX_HISTORY_COUNT = 50;
// 入室中のエージェント： agent_id -> 情報（role_label, agent_type, model, started_at）
let presentAgents = new Map();

// 接続状態の表示を切り替える
function showConnectionStatus(text, className) {
  const statusElement = document.getElementById("connection-status");
  statusElement.textContent = text;
  statusElement.className = className;
}

// "2026-11-14T01:17:41.242" から "01:17:41" を取り出す
function formatTime(isoText) {
  if (typeof isoText !== "string") {
    return "";
  }
  const timePart = isoText.split("T")[1] || isoText;
  return timePart.slice(0, 8);
}

// 入室中の表を作り直す（受信データは textContent で入れる：XSS対策）
function renderAgentTable() {
  const tableBody = document.getElementById("agent-table-body");
  tableBody.replaceChildren();
  for (const agent of presentAgents.values()) {
    const row = document.createElement("tr");
    const cellValues = [agent.role_label, agent.agent_type, agent.model, formatTime(agent.started_at)];
    for (const value of cellValues) {
      const cell = document.createElement("td");
      cell.textContent = value ?? "";
      row.appendChild(cell);
    }
    tableBody.appendChild(row);
  }
  document.getElementById("agent-count").textContent = String(presentAgents.size);
}

// 履歴の先頭に1行追加する（50件を超えたら古いものを消す）
function addHistory(timeText, message) {
  const historyList = document.getElementById("history-list");
  const item = document.createElement("li");
  item.textContent = `[${formatTime(timeText)}] ${message}`;
  historyList.prepend(item);
  while (historyList.children.length > MAX_HISTORY_COUNT) {
    historyList.lastElementChild.remove();
  }
}

// 「調査担当(researcher) / haiku」のような説明文を作る
function describeAgent(event) {
  const who = event.agent_type ? `${event.role_label}(${event.agent_type})` : "(まだ入室していない)";
  return `${who} / ${event.model}`;
}

// サーバーに接続する（切れたらブラウザが自動で再接続する）
const eventSource = new EventSource("/stream");

eventSource.addEventListener("open", () => {
  showConnectionStatus("接続中", "connected");
});

eventSource.addEventListener("error", () => {
  // CLOSED は「もう再接続しない」状態（サーバーがエラーを返したときなど）
  if (eventSource.readyState === EventSource.CLOSED) {
    showConnectionStatus("切断（ページを再読み込みしてください）", "reconnecting");
  } else {
    showConnectionStatus("再接続中", "reconnecting");
  }
});

// snapshot：入室中の一覧を丸ごと置き換える（接続・再接続のたびに届く）
eventSource.addEventListener("snapshot", (message) => {
  const snapshot = JSON.parse(message.data);
  presentAgents = new Map();
  for (const agent of snapshot.agents) {
    presentAgents.set(agent.agent_id, agent);
  }
  renderAgentTable();
});

// enter：入室
eventSource.addEventListener("enter", (message) => {
  const event = JSON.parse(message.data);
  presentAgents.set(event.agent_id, {
    agent_id: event.agent_id,
    agent_type: event.agent_type,
    role_label: event.role_label,
    model: event.model,
    started_at: event.started_at,
  });
  renderAgentTable();
  addHistory(event.time, `入室 ${describeAgent(event)}`);
});

// leave：退室（reason が "timeout" なら自動掃除による退室）
eventSource.addEventListener("leave", (message) => {
  const event = JSON.parse(message.data);
  presentAgents.delete(event.agent_id);
  renderAgentTable();
  const reasonText = event.reason === "timeout" ? "（時間切れ）" : "";
  addHistory(event.time, `退室 ${describeAgent(event)}${reasonText}`);
});

// update：モデル名が分かった（入室中ならモデル欄を書き換える）
eventSource.addEventListener("update", (message) => {
  const event = JSON.parse(message.data);
  const agent = presentAgents.get(event.agent_id);
  if (agent) {
    agent.model = event.model;
    renderAgentTable();
  }
  addHistory(event.time, `モデル判明 ${describeAgent(event)}`);
});
