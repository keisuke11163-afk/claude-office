"use strict";

/* =========================================================
   Claude Office 画面の動き
   - 見た目は style.css と index.html の template に任せる
   - ここでは docs/ui_contract.md で決めた class / id / data- 属性だけを操作する
   - 文字は textContent、要素は createElement、属性は setAttribute / dataset で入れる
   ========================================================= */

// ===== 設定値（docs/ui_contract.md にも同じ値を書いている） =====
const ENTER_MS = 600; // entering から present に切り替えるまでの時間
const LEAVE_MS = 600; // leaving の席を DOM から消すまでの時間
const MAX_LOG_ENTRIES = 50; // ログに残す件数
const ELAPSED_REFRESH_MS = 1000; // 経過時間を書き換える間隔

// デスクの役割（index.html の並び順と同じ）。ここに無い agent_type は other デスクへ
const DESK_ROLES = ["researcher", "coder", "test-runner", "code-reviewer", "code-explainer"];
const OTHER_DESK_ROLE = "other";

// キャラクター template の id に使ってよい文字と、agent_type として使わせない名前
const SAFE_CAT_NAME_PATTERN = /^[a-z0-9-]+$/;
const RESERVED_CAT_NAMES = ["generic", "absent"];

// "YYYY-MM-DDTHH:MM:SS" で始まる時刻文字列かを調べる
const LOCAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// 接続状態ごとの表示文字
const CONNECTION_TEXTS = {
  connecting: "接続中…",
  open: "接続済み",
  reconnecting: "再接続中",
  closed: "切断（再読み込みしてください）",
};

// モックモードかどうか（読み込み時に1回だけ判定する）
const IS_MOCK_MODE = location.hash === "#mock";

// ===== 画面の状態 =====
// 役割 → { role, deskElement, seatsElement }
const desksByRole = new Map();
// 在席中（entering / present）のエージェント：agent_id → 席の記録 { agent, desk, seatElement, fields }
const activeSeats = new Map();
// 最後に処理したイベントの seq（古いイベントを二重に処理しないため）
let lastSeq = -1;

// ===== 小さな道具 =====

// 普通のオブジェクト（JSON の {}）かどうか
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 空でない文字列ならそのまま、違えば代わりの値を返す
function toText(value, fallbackText) {
  return typeof value === "string" && value !== "" ? value : fallbackText;
}

// 2桁にそろえる（3 → "03"）
function padTwoDigits(number) {
  return String(number).padStart(2, "0");
}

// Date を API と同じ形 "YYYY-MM-DDTHH:MM:SS.mmm"（現地時刻）にする
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
    roleLabel: toText(source.role_label, agentType),
    model: toText(source.model, "不明"),
    startedAt: toText(source.started_at, toLocalTimestamp(new Date()).slice(0, 19)),
  };
}

// ===== 接続状態の表示 =====

function setConnectionStatus(connectionState, overrideText) {
  const statusElement = document.getElementById("connection-status");
  if (!statusElement) {
    return;
  }
  statusElement.dataset.connection = connectionState;
  statusElement.textContent = overrideText || CONNECTION_TEXTS[connectionState] || "";
}

// ===== 入退室ログ =====

// ログを1件、先頭（新しい順）に足す。最大件数を超えた古いものは消す
function addLogEntry(logKind, timestamp, messageText, leaveReason) {
  const logList = document.getElementById("activity-log");
  if (!logList) {
    return;
  }
  // 時刻が無い・読めないときは今の時刻を使う（system の記録など）
  const entryTimestamp =
    typeof timestamp === "string" && LOCAL_TIMESTAMP_PATTERN.test(timestamp)
      ? timestamp
      : toLocalTimestamp(new Date());

  const logItem = document.createElement("li");
  logItem.className = "log-entry";
  logItem.dataset.kind = logKind;
  if (leaveReason === "timeout") {
    logItem.dataset.reason = "timeout";
  }

  const timeElement = document.createElement("time");
  timeElement.dataset.field = "time";
  timeElement.setAttribute("datetime", entryTimestamp);
  timeElement.textContent = extractClockText(entryTimestamp);

  const messageElement = document.createElement("span");
  messageElement.dataset.field = "message";
  messageElement.textContent = messageText;

  logItem.append(timeElement, messageElement);
  logList.prepend(logItem);

  // 古いログを消す
  while (logList.children.length > MAX_LOG_ENTRIES) {
    logList.lastElementChild.remove();
  }
}

// ===== デスク =====

// index.html にあるデスクを役割ごとに覚える
function collectDesks() {
  for (const deskElement of document.querySelectorAll(".desk")) {
    const role = deskElement.dataset.role;
    const seatsElement = deskElement.querySelector(".desk-seats");
    if (role && seatsElement) {
      desksByRole.set(role, { role, deskElement, seatsElement });
    }
  }
}

// agent_type から座るデスクを決める（知らない役割は other）
function findDeskFor(agentType) {
  const deskRole = DESK_ROLES.includes(agentType) ? agentType : OTHER_DESK_ROLE;
  return desksByRole.get(deskRole) || desksByRole.get(OTHER_DESK_ROLE) || null;
}

// 在席人数（data-count）と不在の席を、いまの席の状態に合わせる
function refreshDesk(desk) {
  const seatElements = Array.from(desk.seatsElement.children).filter((element) =>
    element.classList.contains("seat")
  );
  const presentCount = seatElements.filter(
    (seat) => seat.dataset.state === "entering" || seat.dataset.state === "present"
  ).length;
  const hasAgentSeat = seatElements.some((seat) => seat.dataset.state !== "absent");
  const absentSeat = seatElements.find((seat) => seat.dataset.state === "absent");

  desk.deskElement.dataset.count = String(presentCount);

  // 誰もいなければ不在の席を置き、誰かいれば不在の席を外す
  if (!hasAgentSeat && !absentSeat) {
    desk.seatsElement.appendChild(createAbsentSeat());
  } else if (hasAgentSeat && absentSeat) {
    absentSeat.remove();
  }
}

function refreshAllDesks() {
  for (const desk of desksByRole.values()) {
    refreshDesk(desk);
  }
}

// ===== キャラクター =====

// agent_type に合う template を探す（無ければ cat-generic）
function findCatTemplate(agentType) {
  const catName = agentType.toLowerCase();
  // 外から届いた値なので、使ってよい文字だけのときに限って id を組み立てる
  if (SAFE_CAT_NAME_PATTERN.test(catName) && !RESERVED_CAT_NAMES.includes(catName)) {
    const roleTemplate = document.getElementById("cat-" + catName);
    if (roleTemplate instanceof HTMLTemplateElement) {
      return roleTemplate;
    }
  }
  return document.getElementById("cat-generic");
}

// template を複製して .cat の箱に入れる
function createCatElement(catTemplate) {
  const catElement = document.createElement("div");
  catElement.className = "cat";
  if (catTemplate instanceof HTMLTemplateElement) {
    catElement.appendChild(catTemplate.content.cloneNode(true));
  }
  return catElement;
}

// ===== 席 =====

// 不在の席（キャラだけ。名札なし）
function createAbsentSeat() {
  const seatElement = document.createElement("div");
  seatElement.className = "seat";
  seatElement.dataset.state = "absent";
  seatElement.setAttribute("aria-label", "不在");
  seatElement.appendChild(createCatElement(document.getElementById("cat-absent")));
  return seatElement;
}

// 名札の1項目（data-field 付き）を作る
function createField(tagName, fieldName) {
  const fieldElement = document.createElement(tagName);
  fieldElement.dataset.field = fieldName;
  return fieldElement;
}

// エージェント1人分の席を作り、記録を返す
function createSeatRecord(agent, desk, initialState) {
  const seatElement = document.createElement("div");
  seatElement.className = "seat";
  seatElement.dataset.state = initialState;
  seatElement.dataset.role = desk.role;
  seatElement.dataset.agentId = agent.agentId;

  // キャラクター
  seatElement.appendChild(createCatElement(findCatTemplate(agent.agentType)));

  // 名札
  const nameplateElement = document.createElement("div");
  nameplateElement.className = "nameplate";
  const fields = {
    roleLabel: createField("span", "role_label"),
    agentType: createField("span", "agent_type"),
    model: createField("span", "model"),
    startedAt: createField("time", "started_at"),
    elapsed: createField("span", "elapsed"),
  };
  nameplateElement.append(fields.roleLabel, fields.agentType, fields.model, fields.startedAt, fields.elapsed);
  seatElement.appendChild(nameplateElement);

  const seatRecord = { agent, desk, seatElement, fields };
  writeAgentInfo(seatRecord);
  return seatRecord;
}

// 記録の中のエージェント情報を、席の属性と名札に書き込む
function writeAgentInfo(seatRecord) {
  const { agent, seatElement, fields } = seatRecord;
  seatElement.dataset.agentType = agent.agentType;
  seatElement.dataset.model = agent.model;
  fields.roleLabel.textContent = agent.roleLabel;
  fields.agentType.textContent = agent.agentType;
  fields.model.textContent = agent.model;
  fields.startedAt.setAttribute("datetime", agent.startedAt);
  fields.startedAt.textContent = extractClockText(agent.startedAt);
  fields.elapsed.textContent = formatElapsed(agent.startedAt);
}

// 新しい席をデスクに置く（entering なら一定時間後に present へ）
function placeNewSeat(agent, initialState) {
  const desk = findDeskFor(agent.agentType);
  if (!desk) {
    return;
  }
  const seatRecord = createSeatRecord(agent, desk, initialState);
  desk.seatsElement.appendChild(seatRecord.seatElement);
  activeSeats.set(agent.agentId, seatRecord);
  refreshDesk(desk);

  if (initialState === "entering") {
    setTimeout(() => {
      // 途中で leaving になっていたら何もしない
      if (seatRecord.seatElement.dataset.state === "entering") {
        seatRecord.seatElement.dataset.state = "present";
      }
    }, ENTER_MS);
  }
}

// 席をアニメなしですぐ消す（役割が変わった二重 enter のとき）
function removeSeatNow(seatRecord) {
  activeSeats.delete(seatRecord.agent.agentId);
  seatRecord.seatElement.remove();
  refreshDesk(seatRecord.desk);
}

// ===== イベントの処理（EventSource とモックの両方から呼ぶ） =====

// snapshot：いまの在席者で席を全部作り直す（アニメなし）
function applySnapshot(snapshotData) {
  if (!isPlainObject(snapshotData)) {
    return;
  }
  // いまの席を全部片づける（leaving 中の席も消える）
  for (const desk of desksByRole.values()) {
    desk.seatsElement.replaceChildren();
  }
  activeSeats.clear();
  lastSeq = Number.isSafeInteger(snapshotData.seq) ? snapshotData.seq : -1;

  // 在席者を present で置き直す
  const agentList = Array.isArray(snapshotData.agents) ? snapshotData.agents : [];
  for (const agentData of agentList) {
    const agent = normalizeAgent(agentData);
    if (agent && !activeSeats.has(agent.agentId)) {
      placeNewSeat(agent, "present");
    }
  }
  refreshAllDesks();
}

// enter：入室。同じ agent_id がすでにいれば席は1つのまま情報だけ更新
function applyEnter(enterData) {
  if (!isPlainObject(enterData) || !isNewEvent(enterData)) {
    return;
  }
  const agent = normalizeAgent(enterData);
  if (!agent) {
    return;
  }

  const existingRecord = activeSeats.get(agent.agentId);
  if (existingRecord && existingRecord.agent.agentType === agent.agentType) {
    // 二重の enter：席はそのまま、名札だけ書き換える
    existingRecord.agent = agent;
    writeAgentInfo(existingRecord);
  } else {
    // 役割が変わっていたら古い席を外してから置き直す
    if (existingRecord) {
      removeSeatNow(existingRecord);
    }
    placeNewSeat(agent, "entering");
  }

  addLogEntry("enter", enterData.time, `${agent.roleLabel} が入室しました（${agent.model}）`);
}

// leave：退室。leaving にして、一定時間後に席を消す
function applyLeave(leaveData) {
  if (!isPlainObject(leaveData) || !isNewEvent(leaveData)) {
    return;
  }
  if (typeof leaveData.agent_id !== "string" || leaveData.agent_id === "") {
    return;
  }
  const seatRecord = activeSeats.get(leaveData.agent_id);

  // ログ（席が無くても、届いた退室は記録する）
  const knownRoleLabel = seatRecord ? seatRecord.agent.roleLabel : "不明";
  const roleLabel = toText(leaveData.role_label, toText(leaveData.agent_type, knownRoleLabel));
  const isTimeout = leaveData.reason === "timeout";
  const messageText = isTimeout
    ? `${roleLabel} が退室しました（時間切れで自動退室）`
    : `${roleLabel} が退室しました`;
  addLogEntry("leave", leaveData.time, messageText, leaveData.reason);

  if (!seatRecord) {
    return;
  }

  // 在席の一覧からはすぐ外す（leaving 中は人数に数えない）
  activeSeats.delete(leaveData.agent_id);
  seatRecord.seatElement.dataset.state = "leaving";
  refreshDesk(seatRecord.desk);

  setTimeout(() => {
    // snapshot で作り直されて、すでに画面に無ければ何もしない
    if (!seatRecord.seatElement.isConnected) {
      return;
    }
    seatRecord.seatElement.remove();
    refreshDesk(seatRecord.desk);
  }, LEAVE_MS);
}

// update（data.kind は "model"）：在席中の人だけモデル表示を更新する
function applyUpdate(updateData) {
  if (!isPlainObject(updateData) || !isNewEvent(updateData)) {
    return;
  }
  // 入室前の update（agent_type が null など）は席を作らず、ログにも出さない
  const seatRecord = activeSeats.get(updateData.agent_id);
  if (!seatRecord) {
    return;
  }
  const newModel = toText(updateData.model, "");
  // モデル名が無い・変わっていないときは何もしない（enter と同じモデルの update でログが並ばないように）
  if (newModel === "" || newModel === seatRecord.agent.model) {
    return;
  }
  seatRecord.agent.model = newModel;
  writeAgentInfo(seatRecord);
  addLogEntry("update", updateData.time, `${seatRecord.agent.roleLabel} のモデル: ${newModel}`);
}

// ===== 経過時間の更新（1秒ごと） =====

function refreshElapsedTimes() {
  for (const seatRecord of activeSeats.values()) {
    seatRecord.fields.elapsed.textContent = formatElapsed(seatRecord.agent.startedAt);
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

const MOCK_STEP_INTERVAL_MS = 2500; // 偽イベントを起こす間隔
const MOCK_MAX_PRESENT = 6; // 同時に在席させる最大人数
const MOCK_TIMEOUT_RATE = 0.25; // 退室のうち timeout にする割合

// 偽の役割（roles.json に無い組み込みの役割も混ぜる）
const MOCK_AGENT_TYPES = [
  { agentType: "researcher", roleLabel: "調査担当" },
  { agentType: "coder", roleLabel: "コーディング担当" },
  { agentType: "test-runner", roleLabel: "テスト担当" },
  { agentType: "code-reviewer", roleLabel: "レビュー担当" },
  { agentType: "code-explainer", roleLabel: "解説担当" },
  { agentType: "Explore", roleLabel: "Explore" },
  { agentType: "general-purpose", roleLabel: "general-purpose" },
];

// 偽のモデル名（決まった3つ以外も混ぜる）
const MOCK_MODELS = ["haiku", "sonnet", "opus", "haiku", "sonnet", "不明", "claude-xxx-preview"];

// 配列から1つ選ぶ
function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

// 偽のエージェントを1人作り、在席の一覧に入れる
function createMockAgent(mockState, agentTypeInfo, startedDate) {
  const mockAgent = {
    agent_id: `mock-${mockState.nextAgentNumber}`,
    agent_type: agentTypeInfo.agentType,
    role_label: agentTypeInfo.roleLabel,
    model: pickRandom(MOCK_MODELS),
    started_at: toLocalTimestamp(startedDate).slice(0, 19),
  };
  mockState.nextAgentNumber += 1;
  mockState.presentAgents.set(mockAgent.agent_id, mockAgent);
  return mockAgent;
}

// 偽の入室
function runMockEnter(mockState) {
  const mockAgent = createMockAgent(mockState, pickRandom(MOCK_AGENT_TYPES), new Date());
  mockState.seq += 1;
  applyEnter({ kind: "enter", time: toLocalTimestamp(new Date()), ...mockAgent, seq: mockState.seq });
}

// 偽の退室（ときどき timeout）
function runMockLeave(mockState) {
  const mockAgent = pickRandom(Array.from(mockState.presentAgents.values()));
  mockState.presentAgents.delete(mockAgent.agent_id);
  mockState.seq += 1;
  applyLeave({
    kind: "leave",
    time: toLocalTimestamp(new Date()),
    agent_id: mockAgent.agent_id,
    agent_type: mockAgent.agent_type,
    role_label: mockAgent.role_label,
    model: mockAgent.model,
    reason: Math.random() < MOCK_TIMEOUT_RATE ? "timeout" : "stop",
    seq: mockState.seq,
  });
}

// 偽のモデル更新（在席中の人）
function runMockUpdatePresent(mockState) {
  const mockAgent = pickRandom(Array.from(mockState.presentAgents.values()));
  mockAgent.model = pickRandom(MOCK_MODELS);
  mockState.seq += 1;
  applyUpdate({
    kind: "model",
    time: toLocalTimestamp(new Date()),
    agent_id: mockAgent.agent_id,
    agent_type: mockAgent.agent_type,
    role_label: mockAgent.role_label,
    model: mockAgent.model,
    seq: mockState.seq,
  });
}

// 偽のモデル更新（入室より先に届いた形。agent_type が null なので画面には何も出ない）
function runMockUpdateBeforeEnter(mockState) {
  mockState.seq += 1;
  applyUpdate({
    kind: "model",
    time: toLocalTimestamp(new Date()),
    agent_id: `mock-${mockState.nextAgentNumber}-early`,
    agent_type: null,
    role_label: null,
    model: pickRandom(MOCK_MODELS),
    seq: mockState.seq,
  });
}

// 数秒ごとに、ランダムで1つ偽イベントを起こす
function runMockStep(mockState) {
  const presentCount = mockState.presentAgents.size;
  const roll = Math.random();
  if (presentCount === 0 || (presentCount < MOCK_MAX_PRESENT && roll < 0.4)) {
    runMockEnter(mockState);
  } else if (roll < 0.7) {
    runMockLeave(mockState);
  } else if (roll < 0.85) {
    runMockUpdatePresent(mockState);
  } else {
    runMockUpdateBeforeEnter(mockState);
  }
}

function startMockMode() {
  document.body.dataset.mode = "mock";
  setConnectionStatus("open", "モック表示中");

  const mockState = { seq: 100, nextAgentNumber: 1, presentAgents: new Map() };

  // 最初の snapshot（1時間以上いる人と、少し前に来た人）
  const nowMs = Date.now();
  const initialAgents = [
    createMockAgent(mockState, MOCK_AGENT_TYPES[0], new Date(nowMs - 65 * 60 * 1000)),
    createMockAgent(mockState, MOCK_AGENT_TYPES[4], new Date(nowMs - 90 * 1000)),
  ];
  applySnapshot({ seq: mockState.seq, agents: initialAgents.map((mockAgent) => ({ ...mockAgent })) });
  addLogEntry("system", null, "モック表示を開始しました（偽のイベントです）");

  setInterval(() => runMockStep(mockState), MOCK_STEP_INTERVAL_MS);
}

// ===== 起動（モック用の定数が読み込まれたあとに呼ぶため、ファイルの最後に置く） =====
function startApp() {
  collectDesks();
  refreshAllDesks();
  setInterval(refreshElapsedTimes, ELAPSED_REFRESH_MS);
  if (IS_MOCK_MODE) {
    startMockMode();
  } else {
    startLiveMode();
  }
}

startApp();
