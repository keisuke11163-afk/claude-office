"use strict";

/* =========================================================
   Claude Factory（タコの工房）画面の動き
   - 見た目は style.css、骨組みは index.html に任せる
   - ここでは docs/ui_contract.md で決めた id / class / data- 属性だけを操作する
   - 文字は textContent、要素は createElement、属性は setAttribute / dataset で入れる
   - タコ（.worker-actor）は1人1個の要素を使い回す。全部を作り直さないので、
     ほかのイベントが届いても入室・退室のアニメが途中で消えない
   ========================================================= */

// ===== 設定値（docs/ui_contract.md にも同じ値を書いている） =====
const ENTER_MS = 500; // entering から present に切り替えるまでの時間（CSS の enter アニメと同じ長さ）
const LEAVE_MS = 500; // leaving のタコを DOM から消すまでの時間（CSS の leave アニメと同じ長さ）
const MAX_LOG_ENTRIES = 50; // ログに残す件数
const MAX_ACTORS_PER_SLOT = 4; // 1つの作業場所に絵を出す人数（超えた分は「ほか○匹」）
const ELAPSED_REFRESH_MS = 1000; // 経過時間を書き換える間隔

// 作業場所の役割（index.html の .slot と同じ並び）。ここに無い agent_type は other へ
const ROLE_ORDER = ["researcher", "coder", "test-runner", "code-reviewer", "code-explainer", "other"];
const OTHER_ROLE = "other";

// 役割ごとの表示名（サーバーの role_label が無いときだけ使う）
const ROLE_LABELS = {
  researcher: "調査担当",
  coder: "コーディング担当",
  "test-runner": "テスト担当",
  "code-reviewer": "レビュー担当",
  "code-explainer": "解説担当",
  other: "その他",
};

// 役割ごとのタコの絵（server.py の STATIC_FILES に登録した URL。check_static で確かめる）
const SPRITE_URLS = {
  researcher: "/assets/octopus/researcher.png",
  coder: "/assets/octopus/coder.png",
  "test-runner": "/assets/octopus/test-runner.png",
  "code-reviewer": "/assets/octopus/code-reviewer.png",
  "code-explainer": "/assets/octopus/code-explainer.png",
  other: "/assets/octopus/general.png",
};
const ABSENT_SPRITE_URL = "/assets/octopus/absent.png";

// "YYYY-MM-DDTHH:MM:SS" で始まる時刻文字列かを調べる
const LOCAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// 接続状態ごとの表示文字
const CONNECTION_TEXTS = {
  connecting: "接続中…",
  open: "接続済み",
  reconnecting: "再接続中",
  closed: "切断（再読み込みしてください）",
};

// ログの種類ごとの記号
const LOG_SIGNS = { enter: "↳", leave: "↰", update: "↻", system: "✳" };

// 工場長のひとこと（ボタンで順に切り替える）
const MANAGER_QUOTES = [
  "「誰だ！こんなコードを書いたのは！」",
  "「工場長には厳重に注意しておきます」",
  "「私は工場長ではありません」",
  "「犯人はかなり内部事情に詳しいようですね」",
  "「工場長を呼んでください。……私ですか？」",
  "「これは私の責任ではなく、工場長の責任です」",
];

// モックモードかどうか（読み込み時に1回だけ判定する）
const IS_MOCK_MODE = location.hash === "#mock" || new URLSearchParams(location.search).get("mock") === "1";

// ===== 画面の状態 =====
// 画面にいるエージェント（leaving 中も含む）：agent_id → 記録 { agent, role, state, actorElement }
const workers = new Map();
// 最後に処理したイベントの seq（古いイベントを二重に処理しないため）
let lastSeq = -1;
// 詳細を表示しているエージェントの agent_id（いなければ null）
let selectedAgentId = null;
// 数えた入室・退室・イベントの件数
let enterCount = 0;
let leaveCount = 0;
let eventCount = 0;
let quoteIndex = 2;

// ===== 小さな道具 =====

// id で要素を探す
function byId(elementId) {
  return document.getElementById(elementId);
}

// 普通のオブジェクト（JSON の {}）かどうか
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 空でない文字列ならそのまま、違えば代わりの値を返す
function toText(value, fallbackText) {
  return typeof value === "string" && value !== "" ? value : fallbackText;
}

// 要素を作り、class と文字を入れる（文字は必ず textContent）
function createElementWithText(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = String(text);
  }
  return element;
}

// 2桁にそろえる（3 → "03"）
function padTwoDigits(number) {
  return String(number).padStart(2, "0");
}

// Date を API と同じ形 "YYYY-MM-DDTHH:MM:SS.mmm"（現地時刻。Z などは付けない）にする
function toLocalTimestamp(date) {
  const datePart = `${date.getFullYear()}-${padTwoDigits(date.getMonth() + 1)}-${padTwoDigits(date.getDate())}`;
  const timePart = `${padTwoDigits(date.getHours())}:${padTwoDigits(date.getMinutes())}:${padTwoDigits(date.getSeconds())}`;
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${datePart}T${timePart}.${milliseconds}`;
}

// 時刻文字列から "HH:MM:SS" だけを取り出す
function extractClockText(timestamp) {
  if (typeof timestamp !== "string" || !LOCAL_TIMESTAMP_PATTERN.test(timestamp)) {
    return "--:--:--";
  }
  return timestamp.slice(11, 19);
}

// 入室時刻からの経過時間を "m:ss"（1時間以上は "h:mm:ss"）にする
function formatElapsed(startedAt) {
  if (typeof startedAt !== "string" || !LOCAL_TIMESTAMP_PATTERN.test(startedAt)) {
    return "-:--";
  }
  // タイムゾーンの無い形はブラウザの現地時刻として読まれる
  const startedMs = new Date(startedAt.slice(0, 19)).getTime();
  if (!Number.isFinite(startedMs)) {
    return "-:--";
  }
  const totalSeconds = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${padTwoDigits(minutes)}:${padTwoDigits(seconds)}`;
  }
  return `${minutes}:${padTwoDigits(seconds)}`;
}

// seq を見て、まだ処理していないイベントなら true（seq が無いイベントは通す）
function isNewEvent(eventData) {
  if (!Number.isSafeInteger(eventData.seq)) {
    return true;
  }
  if (eventData.seq <= lastSeq) {
    return false;
  }
  lastSeq = eventData.seq;
  return true;
}

// 届いたエージェント情報を、画面で使う形（すべて文字列）にそろえる
function normalizeAgent(source) {
  if (!isPlainObject(source) || typeof source.agent_id !== "string" || source.agent_id === "") {
    return null;
  }
  const agentType = toText(source.agent_type, "unknown");
  return {
    agentId: source.agent_id,
    agentType: agentType,
    roleLabel: toText(source.role_label, Object.hasOwn(ROLE_LABELS, agentType) ? ROLE_LABELS[agentType] : agentType),
    model: toText(source.model, "不明"),
    startedAt: toText(source.started_at, toLocalTimestamp(new Date()).slice(0, 19)),
  };
}

// agent_type から作業場所の役割を決める（知らない役割は other）
function findRole(agentType) {
  return ROLE_ORDER.includes(agentType) && agentType !== OTHER_ROLE ? agentType : OTHER_ROLE;
}

// 在席中（entering / present）の記録だけを返す
function listPresentWorkers() {
  return Array.from(workers.values()).filter((record) => record.state !== "leaving");
}

// ===== 接続状態の表示 =====

function setConnectionStatus(connectionState, overrideText) {
  const statusElement = byId("connection-status");
  if (!statusElement) {
    return;
  }
  statusElement.dataset.connection = connectionState;
  statusElement.textContent = overrideText || CONNECTION_TEXTS[connectionState] || "";
}

// ===== 業務日誌（ログ） =====

// ログを1件、先頭（新しい順）に足す。最大件数を超えた古いものは消す
function addLogEntry(logKind, timestamp, messageText, leaveReason) {
  const logList = byId("activity-log");
  if (!logList) {
    return;
  }
  // 時刻が無い・読めないときは今の時刻を使う（system の記録など）
  const entryTimestamp =
    typeof timestamp === "string" && LOCAL_TIMESTAMP_PATTERN.test(timestamp)
      ? timestamp
      : toLocalTimestamp(new Date());

  const logItem = createElementWithText("li", "log-entry");
  logItem.dataset.kind = logKind;
  if (leaveReason === "timeout") {
    logItem.dataset.reason = "timeout";
  }
  const timeElement = createElementWithText("time", "", extractClockText(entryTimestamp));
  timeElement.setAttribute("datetime", entryTimestamp);
  logItem.append(
    timeElement,
    createElementWithText("span", "log-sign", LOG_SIGNS[logKind] || "•"),
    createElementWithText("span", "log-msg", messageText)
  );
  logList.prepend(logItem);

  while (logList.children.length > MAX_LOG_ENTRIES) {
    logList.lastElementChild.remove();
  }
}

// ===== 工房のジオラマ（タコ） =====

// タコの要素を作る（クリックで詳細を表示）
function createActorElement(record) {
  const actorElement = createElementWithText("button", "worker-actor");
  actorElement.type = "button";
  actorElement.dataset.agentId = record.agent.agentId;
  const spriteImage = document.createElement("img");
  spriteImage.alt = "";
  spriteImage.draggable = false;
  spriteImage.src = SPRITE_URLS[record.role];
  actorElement.append(spriteImage, createElementWithText("span", "bubble"));
  actorElement.addEventListener("click", () => selectWorker(record.agent.agentId));
  return actorElement;
}

// タコの要素に、いまの記録（状態・名前・モデル）を書き込む
function writeActorInfo(record) {
  const { agent, actorElement } = record;
  actorElement.dataset.state = record.state;
  actorElement.dataset.role = record.role;
  actorElement.dataset.agentType = agent.agentType;
  actorElement.dataset.model = agent.model;
  actorElement.setAttribute("aria-label", `${agent.roleLabel}、モデル ${agent.model}、詳細を表示`);
  actorElement.querySelector(".bubble").textContent = agent.roleLabel;
  actorElement.classList.toggle("selected", agent.agentId === selectedAgentId);
}

// 作業場所の「ほか○匹」の札を探す（無ければ作って最後に置く）
function findOverflowBadge(slotElement) {
  let badge = slotElement.querySelector(".overflow-badge");
  if (!badge) {
    badge = createElementWithText("span", "bubble overflow-badge");
    badge.hidden = true;
    slotElement.appendChild(badge);
  }
  return badge;
}

// 作業場所ごとに、絵を出す人（最大4人）と「ほか○匹」を整える
// 要素は動かさず hidden を切り替えるだけなので、アニメがやり直しにならない
function refreshSlots() {
  for (const role of ROLE_ORDER) {
    const slotElement = document.querySelector(`.slot[data-role="${role}"]`);
    if (!slotElement) {
      continue;
    }
    let shownCount = 0;
    let hiddenCount = 0;
    for (const actorElement of slotElement.querySelectorAll(".worker-actor")) {
      // 退室中のタコは、アニメが終わるまで必ず見せる
      if (actorElement.dataset.state === "leaving") {
        actorElement.hidden = false;
        continue;
      }
      const isShown = shownCount < MAX_ACTORS_PER_SLOT;
      actorElement.hidden = !isShown;
      if (isShown) {
        shownCount += 1;
      } else {
        hiddenCount += 1;
      }
    }
    const badge = findOverflowBadge(slotElement);
    badge.hidden = hiddenCount === 0;
    badge.textContent = `ほか${hiddenCount}匹`;
  }
  const emptyMessage = byId("scene-empty");
  if (emptyMessage) {
    emptyMessage.classList.toggle("visible", listPresentWorkers().length === 0);
  }
}

// 新しいタコを作業場所に置く（entering なら一定時間後に present へ）
function placeWorker(agent, initialState) {
  const role = findRole(agent.agentType);
  const record = { agent, role, state: initialState, actorElement: null };
  record.actorElement = createActorElement(record);
  writeActorInfo(record);

  const slotElement = document.querySelector(`.slot[data-role="${role}"]`);
  if (slotElement) {
    // 「ほか○匹」の札より前に入れる（ほかのタコは動かさない）
    slotElement.insertBefore(record.actorElement, findOverflowBadge(slotElement));
  }
  workers.set(agent.agentId, record);

  if (initialState === "entering") {
    setTimeout(() => {
      // 途中で退室・作り直しになっていたら何もしない
      if (workers.get(agent.agentId) === record && record.state === "entering") {
        record.state = "present";
        writeActorInfo(record);
      }
    }, ENTER_MS);
  }
  return record;
}

// タコをアニメなしですぐ消す
function removeWorkerNow(record) {
  record.actorElement.remove();
  if (workers.get(record.agent.agentId) === record) {
    workers.delete(record.agent.agentId);
  }
}

// ===== 右側の一覧・詳細・数字 =====

// 「工房の仲間たち」：役割ごとに1行（その役割の最初の在席者を代表にする）
function renderCrewList() {
  const listElement = byId("worker-list");
  if (!listElement) {
    return;
  }
  const presentWorkers = listPresentWorkers();
  const rows = ROLE_ORDER.map((role) => {
    const group = presentWorkers.filter((record) => record.role === role);
    const representative = group[0];
    const rowButton = createElementWithText("button", "crew-row");
    rowButton.type = "button";
    rowButton.dataset.role = role;

    const iconImage = document.createElement("img");
    iconImage.alt = "";
    iconImage.src = representative ? SPRITE_URLS[role] : ABSENT_SPRITE_URL;

    const infoBox = createElementWithText("span", "crew-info");
    if (representative) {
      const moreText = group.length > 1 ? ` ほか${group.length - 1}匹` : "";
      infoBox.append(
        createElementWithText("b", "", representative.agent.roleLabel),
        createElementWithText("small", "", `${representative.agent.agentType} / ${representative.agent.model}${moreText}`)
      );
      rowButton.classList.toggle("active", representative.agent.agentId === selectedAgentId);
      rowButton.addEventListener("click", () => selectWorker(representative.agent.agentId));
    } else {
      infoBox.append(
        createElementWithText("b", "", ROLE_LABELS[role]),
        createElementWithText("small", "", "作業員を待機中")
      );
      rowButton.disabled = true;
    }
    rowButton.append(
      iconImage,
      infoBox,
      createElementWithText("span", representative ? "crew-state" : "crew-state off", representative ? "● 在室" : "○ 不在")
    );
    return rowButton;
  });
  listElement.replaceChildren(...rows);
}

// 「作業員の詳細」：選んでいるエージェントの情報
function renderWorkerDetail() {
  const detailElement = byId("worker-detail");
  if (!detailElement) {
    return;
  }
  const record = selectedAgentId ? workers.get(selectedAgentId) : null;
  if (!record || record.state === "leaving") {
    detailElement.replaceChildren(createElementWithText("p", "", "工房のタコか、右側の仲間たちを選んでね。"));
    return;
  }
  const spriteImage = document.createElement("img");
  spriteImage.alt = "";
  spriteImage.src = SPRITE_URLS[record.role];

  const descriptionList = document.createElement("dl");
  const rows = [
    ["役割", record.agent.agentType, ""],
    ["モデル", record.agent.model, ""],
    ["経過", formatElapsed(record.agent.startedAt), "detail-elapsed"],
    ["入室", extractClockText(record.agent.startedAt), ""],
  ];
  for (const [labelText, valueText, className] of rows) {
    const valueElement = createElementWithText("dd", className, valueText);
    if (className === "detail-elapsed") {
      valueElement.dataset.startedAt = record.agent.startedAt;
    }
    descriptionList.append(createElementWithText("dt", "", labelText), valueElement);
  }
  const textBox = document.createElement("div");
  textBox.append(createElementWithText("h3", "", record.agent.roleLabel), descriptionList);
  detailElement.replaceChildren(spriteImage, textBox);
}

// 人数・件数の表示
function renderMetrics() {
  const presentCount = listPresentWorkers().length;
  const texts = {
    "side-crew": `${presentCount} 匹`,
    "side-events": `${eventCount} 件`,
    "scene-population": `${presentCount} WORKERS`,
    "crew-total": `${presentCount} 在室`,
    "summary-present": `${presentCount} 匹`,
    "summary-enter": `${enterCount} 件`,
    "summary-leave": `${leaveCount} 件`,
  };
  for (const [elementId, text] of Object.entries(texts)) {
    const element = byId(elementId);
    if (element) {
      element.textContent = text;
    }
  }
}

// 画面の右側と数字をいまの状態に合わせる（タコの要素は作り直さない）
function refreshPanels() {
  // 選んでいた人がいなくなったら、最初の在席者を選び直す
  const selectedRecord = selectedAgentId ? workers.get(selectedAgentId) : null;
  if (!selectedRecord || selectedRecord.state === "leaving") {
    const firstPresent = listPresentWorkers()[0];
    selectedAgentId = firstPresent ? firstPresent.agent.agentId : null;
  }
  for (const record of workers.values()) {
    record.actorElement.classList.toggle("selected", record.agent.agentId === selectedAgentId);
  }
  refreshSlots();
  renderCrewList();
  renderWorkerDetail();
  renderMetrics();
}

// タコ（または一覧の行）を選ぶ
function selectWorker(agentId) {
  const record = workers.get(agentId);
  if (!record || record.state === "leaving") {
    return;
  }
  selectedAgentId = agentId;
  refreshPanels();
}

// ===== イベントの処理（EventSource とモックの両方から呼ぶ） =====

// snapshot：いまの在席者でタコを全部置き直す（アニメなし）
function applySnapshot(snapshotData) {
  if (!isPlainObject(snapshotData)) {
    return;
  }
  for (const record of Array.from(workers.values())) {
    removeWorkerNow(record);
  }
  workers.clear();
  lastSeq = Number.isSafeInteger(snapshotData.seq) ? snapshotData.seq : -1;

  const agentList = Array.isArray(snapshotData.agents) ? snapshotData.agents : [];
  for (const agentData of agentList) {
    const agent = normalizeAgent(agentData);
    if (agent && !workers.has(agent.agentId)) {
      placeWorker(agent, "present");
    }
  }
  refreshPanels();
}

// enter：入室。同じ agent_id がすでに在席中なら、タコは1つのまま情報だけ更新
function applyEnter(enterData) {
  if (!isPlainObject(enterData) || !isNewEvent(enterData)) {
    return;
  }
  const agent = normalizeAgent(enterData);
  if (!agent) {
    return;
  }
  const existingRecord = workers.get(agent.agentId);
  if (existingRecord && existingRecord.state !== "leaving" && existingRecord.role === findRole(agent.agentType)) {
    // 二重の enter：タコはそのまま、情報だけ書き換える
    existingRecord.agent = agent;
    writeActorInfo(existingRecord);
  } else {
    // 役割が変わった・退室中だったときは、古いタコを外してから置き直す
    if (existingRecord) {
      removeWorkerNow(existingRecord);
    }
    placeWorker(agent, "entering");
  }
  enterCount += 1;
  eventCount += 1;
  addLogEntry("enter", enterData.time, `${agent.roleLabel} が入室しました（${agent.model}）`);
  refreshPanels();
}

// leave：退室。leaving にして、アニメが終わったらタコを消す
function applyLeave(leaveData) {
  if (!isPlainObject(leaveData) || !isNewEvent(leaveData)) {
    return;
  }
  if (typeof leaveData.agent_id !== "string" || leaveData.agent_id === "") {
    return;
  }
  const record = workers.get(leaveData.agent_id);
  const knownLabel = record ? record.agent.roleLabel : "不明";
  const roleLabel = toText(leaveData.role_label, toText(leaveData.agent_type, knownLabel));
  const isTimeout = leaveData.reason === "timeout";
  leaveCount += 1;
  eventCount += 1;
  addLogEntry(
    "leave",
    leaveData.time,
    isTimeout ? `${roleLabel} が退室しました（時間切れで自動退室）` : `${roleLabel} が退室しました`,
    leaveData.reason
  );

  if (record && record.state !== "leaving") {
    record.state = "leaving";
    writeActorInfo(record);
    setTimeout(() => {
      // 途中で snapshot や再入室で置き直されていたら何もしない
      if (workers.get(leaveData.agent_id) === record && record.state === "leaving") {
        removeWorkerNow(record);
        refreshPanels();
      }
    }, LEAVE_MS);
  }
  refreshPanels();
}

// update（data.kind は "model"）：在席中の人だけモデル表示を更新する
function applyUpdate(updateData) {
  if (!isPlainObject(updateData) || !isNewEvent(updateData)) {
    return;
  }
  // 入室前の update（agent_type が null など）は何もしない
  const record = workers.get(updateData.agent_id);
  if (!record || record.state === "leaving") {
    return;
  }
  const newModel = toText(updateData.model, "");
  // モデル名が無い・変わっていないときは何もしない（ログが並ばないように）
  if (newModel === "" || newModel === record.agent.model) {
    return;
  }
  record.agent.model = newModel;
  writeActorInfo(record);
  eventCount += 1;
  addLogEntry("update", updateData.time, `${record.agent.roleLabel} のモデル: ${newModel}`);
  refreshPanels();
}

// ===== 経過時間の更新（1秒ごと） =====

function refreshElapsedTimes() {
  for (const element of document.querySelectorAll(".detail-elapsed")) {
    element.textContent = formatElapsed(element.dataset.startedAt);
  }
}

// ===== 本番：サーバーの /stream に接続する =====

// イベントの data を JSON として読み、処理関数に渡す
function listenJsonEvent(eventSource, eventName, handleData) {
  eventSource.addEventListener(eventName, (message) => {
    let eventData;
    try {
      eventData = JSON.parse(message.data);
    } catch (error) {
      console.error(`${eventName} の data を読めません`, error);
      return;
    }
    handleData(eventData);
  });
}

function startLiveMode() {
  document.body.dataset.mode = "live";

  // EventSource が使えないブラウザ
  if (!("EventSource" in window)) {
    setConnectionStatus("closed");
    addLogEntry("system", null, "このブラウザはリアルタイム表示に対応していません");
    return;
  }

  setConnectionStatus("connecting");
  const eventSource = new EventSource("/stream");
  let snapshotCount = 0; // 受け取った snapshot の数（2回目以降は再接続）
  let hasLoggedDisconnect = false; // 切断の記録を1回だけ出すため

  eventSource.addEventListener("open", () => {
    setConnectionStatus("open");
  });

  // snapshot：接続のたびに届く
  listenJsonEvent(eventSource, "snapshot", (snapshotData) => {
    snapshotCount += 1;
    applySnapshot(snapshotData);
    setConnectionStatus("open");
    if (snapshotCount >= 2) {
      addLogEntry("system", null, "再接続（この間の履歴は抜けている可能性あり）");
    }
    hasLoggedDisconnect = false;
  });

  // 種類はイベント名で判定する（update の data.kind は "model" なので使わない）
  listenJsonEvent(eventSource, "enter", applyEnter);
  listenJsonEvent(eventSource, "leave", applyLeave);
  listenJsonEvent(eventSource, "update", applyUpdate);

  // 切断：CLOSED なら自動では戻らないので再読み込みを促す
  eventSource.addEventListener("error", () => {
    if (eventSource.readyState === EventSource.CLOSED) {
      setConnectionStatus("closed");
      addLogEntry("system", null, "切断されました（再読み込みしてください）");
      return;
    }
    setConnectionStatus("reconnecting");
    if (!hasLoggedDisconnect) {
      hasLoggedDisconnect = true;
      addLogEntry("system", null, "接続が切れました（再接続しています）");
    }
  });
}

/* =========================================================
   ここから下はモックモード（URL の末尾が #mock のときだけ動く）
   サーバーに接続せず、偽のイベントを処理関数に渡す
   ========================================================= */

const MOCK_STEP_INTERVAL_MS = 4000; // 偽イベントを起こす間隔
const MOCK_MAX_PRESENT = 8; // 同時に在席させる最大人数
const MOCK_TIMEOUT_RATE = 0.25; // 退室のうち timeout にする割合
const MOCK_MODELS = ["haiku", "sonnet", "opus"];

// 偽の役割（roles.json に無い組み込みの役割も混ぜる）
const MOCK_AGENT_TYPES = [
  { agentType: "researcher", roleLabel: "調査担当" },
  { agentType: "coder", roleLabel: "コーディング担当" },
  { agentType: "test-runner", roleLabel: "テスト担当" },
  { agentType: "code-reviewer", roleLabel: "レビュー担当" },
  { agentType: "code-explainer", roleLabel: "解説担当" },
  { agentType: "general-purpose", roleLabel: "general-purpose" },
  { agentType: "Explore", roleLabel: "Explore" },
];

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function startMockMode() {
  document.body.dataset.mode = "mock";
  setConnectionStatus("open", "モック表示中");
  const mockControls = byId("mock-controls");
  if (mockControls) {
    mockControls.hidden = false;
  }

  const mockState = { seq: 0, nextAgentNumber: 1 };

  // 偽のエージェントを1人作る（started_at は現地時刻。何分前に入室したかを指定できる）
  function makeMockAgent(minutesAgo) {
    const agentType = pickRandom(MOCK_AGENT_TYPES);
    const startedDate = new Date(Date.now() - minutesAgo * 60 * 1000);
    const agentNumber = mockState.nextAgentNumber;
    mockState.nextAgentNumber += 1;
    return {
      agent_id: `mock-${agentNumber}`,
      agent_type: agentType.agentType,
      role_label: agentType.roleLabel,
      model: pickRandom(MOCK_MODELS),
      started_at: toLocalTimestamp(startedDate).slice(0, 19),
    };
  }

  function mockEnter() {
    if (listPresentWorkers().length >= MOCK_MAX_PRESENT) {
      return;
    }
    mockState.seq += 1;
    applyEnter({ kind: "enter", time: toLocalTimestamp(new Date()), ...makeMockAgent(0), seq: mockState.seq });
  }

  function mockLeave() {
    const presentWorkers = listPresentWorkers();
    if (presentWorkers.length === 0) {
      return;
    }
    const record = pickRandom(presentWorkers);
    mockState.seq += 1;
    applyLeave({
      kind: "leave",
      time: toLocalTimestamp(new Date()),
      agent_id: record.agent.agentId,
      agent_type: record.agent.agentType,
      role_label: record.agent.roleLabel,
      model: record.agent.model,
      reason: Math.random() < MOCK_TIMEOUT_RATE ? "timeout" : "stop",
      seq: mockState.seq,
    });
  }

  function mockUpdate() {
    const presentWorkers = listPresentWorkers();
    if (presentWorkers.length === 0) {
      return;
    }
    const record = pickRandom(presentWorkers);
    mockState.seq += 1;
    applyUpdate({
      kind: "model",
      time: toLocalTimestamp(new Date()),
      agent_id: record.agent.agentId,
      agent_type: record.agent.agentType,
      role_label: record.agent.roleLabel,
      model: pickRandom(MOCK_MODELS.filter((model) => model !== record.agent.model)),
      seq: mockState.seq,
    });
  }

  // 最初は数人が少し前から在席している
  applySnapshot({ seq: 0, agents: [makeMockAgent(3), makeMockAgent(12), makeMockAgent(65)] });
  addLogEntry("system", null, "モック表示を開始しました（偽のイベントです）");

  const enterButton = byId("mock-enter");
  const leaveButton = byId("mock-leave");
  if (enterButton) {
    enterButton.addEventListener("click", mockEnter);
  }
  if (leaveButton) {
    leaveButton.addEventListener("click", mockLeave);
  }

  setInterval(() => {
    const roll = Math.random();
    if (roll < 0.45) {
      mockEnter();
    } else if (roll < 0.85) {
      mockLeave();
    } else {
      mockUpdate();
    }
  }, MOCK_STEP_INTERVAL_MS);
}

// ===== ボタン類（ページ内リンク・昼夜・工場長のひとこと） =====

function setupControls() {
  for (const navItem of document.querySelectorAll(".nav-item")) {
    navItem.addEventListener("click", () => {
      for (const otherItem of document.querySelectorAll(".nav-item")) {
        otherItem.classList.remove("chosen");
      }
      navItem.classList.add("chosen");
      const target = byId(navItem.dataset.scroll || "");
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }

  const lightToggle = byId("light-toggle");
  const scene = byId("scene");
  if (lightToggle && scene) {
    lightToggle.addEventListener("click", () => {
      const isNight = scene.classList.toggle("night");
      lightToggle.textContent = isNight ? "☀ 昼にする" : "☾ 夜にする";
    });
  }

  const quoteButton = byId("next-quote");
  const quoteText = byId("manager-quote");
  if (quoteButton && quoteText) {
    quoteButton.addEventListener("click", () => {
      quoteIndex = (quoteIndex + 1) % MANAGER_QUOTES.length;
      quoteText.textContent = MANAGER_QUOTES[quoteIndex];
    });
  }
}

// ===== 起動 =====

function start() {
  setupControls();
  refreshPanels();
  setInterval(refreshElapsedTimes, ELAPSED_REFRESH_MS);
  if (IS_MOCK_MODE) {
    startMockMode();
  } else {
    startLiveMode();
  }
}

start();
