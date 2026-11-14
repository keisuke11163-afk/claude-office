"use strict";

/* =========================================================
   Claude Factory（タコの工房）画面の動き
   - 見た目は style.css、骨組みは index.html に任せる
   - ここでは docs/ui_contract.md で決めた id / class / data- 属性だけを操作する
   - 文字は textContent、要素は createElement、属性は setAttribute / dataset で入れる
   - タコ（.worker-actor）は1人1個の要素を使い回す。全部を作り直さないので、
     ほかのイベントが届いても入室・退室のアニメが途中で消えない
   - 在席状態（data-state）と見た目（data-motion / data-visual）は分けて持つ。
     歩く・働く・驚くなどの動きは CSS アニメに任せ、JS は data- 属性を書き換えるだけ
   ========================================================= */

// ===== 設定値（docs/ui_contract.md にも同じ値を書いている） =====
const ENTER_MS = 500; // entering から present に切り替えるまでの時間（CSS の enter アニメと同じ長さ）
const LEAVE_MS = 500; // leaving のタコを DOM から消すまでの時間（CSS の leave アニメと同じ長さ）
const MAX_LOG_ENTRIES = 50; // ログに残す件数
const MAX_ACTORS_PER_SLOT = 2; // 1つの作業場所に絵を出す人数（超えた分は「ほか○匹」）
const ELAPSED_REFRESH_MS = 1000; // 経過時間を書き換える間隔

// ===== 照明（昼・夕・夜）の設定 =====
// 切り替えの順番と、ボタンに出す記号・名前（docs/ui_contract.md の data-light と同じ値）
const LIGHT_MODES = [
  { mode: "day", icon: "☀", shortLabel: "昼", longLabel: "昼" },
  { mode: "dusk", icon: "◐", shortLabel: "夕", longLabel: "夕方" },
  { mode: "night", icon: "☾", shortLabel: "夜", longLabel: "夜" },
];
const DEFAULT_LIGHT_MODE = "day";
const LIGHT_STORAGE_KEY = "claude-factory-light"; // 選んだ照明を覚えておく localStorage の名前

// ===== タコのモーション（見た目だけ。在席状態の data-state とは別に動く） =====
const WALK_MS = 1400; // 入口と席のあいだを歩く見た目の長さ（ENTER_MS / LEAVE_MS とは別）
const GHOST_CLEANUP_MARGIN_MS = 200; // 退室の影武者は、歩き終わりから少し待って必ず消す
const MOTION_TICK_MS = 1700; // モーション指揮役が動く間隔
const MOTION_PICK_RATE = 0.35; // 1回の指揮で動きを変えるタコの割合
const FACING_TURN_RATE = 0.2; // 待機に戻るとき、反対を向く割合（きょろきょろ）
const DEFAULT_DOOR_PERCENT = { x: 25.1, y: 87.4 }; // CSS の --door-x / --door-y が読めないときの入口（#scene に対する %）
const BLINK_MIN_MS = 3200; // まばたきの間隔（タコごとにこの範囲でばらす）
const BLINK_MAX_MS = 6800;

// モーションの名前（data-motion の値）と、詳細パネルに出す日本語
const MOTION_LABELS = { idle: "待機中", walk: "歩行中", work: "作業中", react: "リアクション" };
// モーション指揮役が選ぶ動きと重み（大きいほど選ばれやすい）
const MOTION_WEIGHTS = [
  { motion: "idle", weight: 5 },
  { motion: "work", weight: 4 },
  { motion: "react", weight: 1 },
];
// 役割ごとの仕事のポーズ（data-pose の値。CSS で小物と動きを描く。進捗や成否は表さない）
const WORK_POSES = {
  researcher: ["magnify", "book"],
  coder: ["type", "monitor"],
  "test-runner": ["check", "cheer"],
  "code-reviewer": ["redpen", "tilt"],
  "code-explainer": ["point"],
  other: ["sort", "think"],
};
// リアクションの種類（data-react の値。驚く「!」・喜ぶ「♪」・困る「汗」）
const REACTIONS = ["surprise", "joy", "trouble"];

// 役割ごとのスプライトシート（まだ無いので空）。用意できたら次の形で足す：
//   coder: { url: "/assets/octopus/coder_sheet.png", frameCount: 16, fps: 8, rowByMotion: { idle: 0, … }, framesByMotion: { idle: 16, walk: 6, … } }
//   - 1行が1つのモーション。横の列数が frameCount。行ごとに使うコマ数が違うときは framesByMotion（左から何コマ使うか）
//   - URL は server.py の STATIC_FILES にも登録する
//   - 設定が無い役割は、1枚絵 + CSS の仮アニメ（呼吸・まばたき・よちよち）で動く
// 1コマ 400×360、4行（待機・歩き・作業・リアクション）× 16列。待機は16コマでまばたき1回、歩きとリアクションは6コマ、作業は8コマ
const SHEET_ROWS = { idle: 0, walk: 1, work: 2, react: 3 };
const SHEET_FRAMES = { idle: 16, walk: 6, work: 8, react: 6 };
const SPRITE_SHEETS = {
  researcher: { url: "/assets/octopus/researcher_sheet.png", frameCount: 16, fps: 8, rowByMotion: SHEET_ROWS, framesByMotion: SHEET_FRAMES },
  coder: { url: "/assets/octopus/coder_sheet.png", frameCount: 16, fps: 8, rowByMotion: SHEET_ROWS, framesByMotion: SHEET_FRAMES },
  "test-runner": { url: "/assets/octopus/test-runner_sheet.png", frameCount: 16, fps: 8, rowByMotion: SHEET_ROWS, framesByMotion: SHEET_FRAMES },
  "code-reviewer": { url: "/assets/octopus/code-reviewer_sheet.png", frameCount: 16, fps: 8, rowByMotion: SHEET_ROWS, framesByMotion: SHEET_FRAMES },
  "code-explainer": { url: "/assets/octopus/code-explainer_sheet.png", frameCount: 16, fps: 8, rowByMotion: SHEET_ROWS, framesByMotion: SHEET_FRAMES },
  other: { url: "/assets/octopus/general_sheet.png", frameCount: 16, fps: 8, rowByMotion: SHEET_ROWS, framesByMotion: SHEET_FRAMES },
};

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
// 画面にいるエージェント（leaving 中も含む）：agent_id → 記録
//   { agent, role（＝作業場所）, state, actorElement, motion, facing, frame }
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
// いまの照明（day / dusk / night）
let currentLightMode = DEFAULT_LIGHT_MODE;
// 見た目用のタイマー（歩き終わり・影武者の片付け）。snapshot のときにまとめて止める
const visualTimerIds = new Set();
// モーション指揮役の setInterval の番号（止まっているときは null）
let motionConductorId = null;
// 一覧の行で強調している役割（なければ null）
let highlightedRole = null;
// 「動きを減らす」設定（matchMedia が無い環境では null）
const reducedMotionQuery =
  typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

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

// 配列から1つを選ぶ
function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

// min 以上 max 未満の数を選ぶ
function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

// 「動きを減らす」設定なら true（歩き・揺れ・モーション指揮をしない）
function prefersReducedMotion() {
  return Boolean(reducedMotionQuery && reducedMotionQuery.matches);
}

// 飾り用の span（読み上げない）を作る
function createDecorationElement(className) {
  const element = createElementWithText("span", className);
  element.setAttribute("aria-hidden", "true");
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
// 中身：button.worker-actor > div.octo-rig（向き・歩きの揺れ）> div.octo-body（呼吸）> img + まぶた
//       と、役割の小物（.octo-prop）・記号（.octo-mark）・名札（.bubble）
function createActorElement(record) {
  const actorElement = createElementWithText("button", "worker-actor");
  actorElement.type = "button";
  actorElement.dataset.agentId = record.agent.agentId;

  // 本体：いまは1枚絵（スプライトシートの設定があれば applySpriteFrame で切り替える）
  const spriteImage = document.createElement("img");
  spriteImage.className = "octo-sprite";
  spriteImage.alt = "";
  spriteImage.draggable = false;
  spriteImage.src = SPRITE_URLS[record.role];
  const bodyElement = createElementWithText("div", "octo-body");
  bodyElement.dataset.sprite = "image";
  bodyElement.append(spriteImage, createDecorationElement("octo-lids"));

  // 向きと歩きの揺れを受け持つ枠（小物も一緒に反転する）
  const rigElement = createElementWithText("div", "octo-rig");
  rigElement.append(bodyElement, createDecorationElement("octo-prop"));

  // 記号は左右反転させたくないので枠の外に置く
  actorElement.append(rigElement, createDecorationElement("octo-mark"), createElementWithText("span", "bubble"));

  // まばたきの間隔をタコごとにばらす（みんな同時に目を閉じないように）
  actorElement.style.setProperty("--blink-ms", `${Math.round(randomBetween(BLINK_MIN_MS, BLINK_MAX_MS))}ms`);
  actorElement.style.setProperty("--blink-delay", `${-Math.round(randomBetween(0, BLINK_MAX_MS))}ms`);
  actorElement.addEventListener("click", () => selectWorker(record.agent.agentId));
  return actorElement;
}

// ===== タコのモーション（data- 属性を書き換えるだけ。DOM は作り直さない） =====

// スプライトシートの設定があれば本体をシート表示にし、data-frame（シートの行）を決める
// 設定が無い役割は1枚絵のまま（data-frame は "0"）
function applySpriteFrame(record) {
  const { actorElement } = record;
  const sheet = Object.hasOwn(SPRITE_SHEETS, record.role) ? SPRITE_SHEETS[record.role] : null;
  const bodyElement = actorElement.querySelector(".octo-body");
  if (!sheet || !bodyElement) {
    record.frame = 0;
    actorElement.dataset.frame = "0";
    return;
  }
  const rowNumbers = Object.values(sheet.rowByMotion);
  const rowCount = Math.max(...rowNumbers) + 1;
  const row = Object.hasOwn(sheet.rowByMotion, record.motion) ? sheet.rowByMotion[record.motion] : 0;
  // この行で使うコマ数（指定が無ければ全列）
  const frames =
    sheet.framesByMotion && Object.hasOwn(sheet.framesByMotion, record.motion)
      ? Math.min(sheet.framesByMotion[record.motion], sheet.frameCount)
      : sheet.frameCount;
  bodyElement.dataset.sprite = "sheet";
  bodyElement.style.setProperty("--sheet-image", `url("${sheet.url}")`);
  bodyElement.style.setProperty("--sheet-cols", String(sheet.frameCount));
  bodyElement.style.setProperty("--sheet-frames", String(frames));
  bodyElement.style.setProperty("--sheet-end", `${sheet.frameCount > 1 ? ((frames - 1) / (sheet.frameCount - 1)) * 100 : 0}%`);
  bodyElement.style.setProperty("--sheet-rows", String(rowCount));
  bodyElement.style.setProperty("--sheet-row-ratio", String(rowCount > 1 ? row / (rowCount - 1) : 0));
  bodyElement.style.setProperty("--sheet-duration", `${frames / sheet.fps}s`);
  record.frame = row;
  actorElement.dataset.frame = String(row);
}

// タコのモーションを切り替える（variant：仕事のポーズ名かリアクションの種類。省略するとランダム）
function setActorMotion(record, motion, variant) {
  const { actorElement } = record;
  record.motion = motion;
  actorElement.dataset.motion = motion;

  // 仕事は役割ごとのポーズ、リアクションは記号の種類を選ぶ
  if (motion === "work") {
    const poses = Object.hasOwn(WORK_POSES, record.role) ? WORK_POSES[record.role] : WORK_POSES[OTHER_ROLE];
    actorElement.dataset.pose = poses.includes(variant) ? variant : pickRandom(poses);
  } else {
    delete actorElement.dataset.pose;
  }
  if (motion === "react") {
    actorElement.dataset.react = REACTIONS.includes(variant) ? variant : pickRandom(REACTIONS);
  } else {
    delete actorElement.dataset.react;
  }
  applySpriteFrame(record);

  // 詳細パネルに出ているタコなら、モーション名だけ書き換える
  if (record.agent.agentId === selectedAgentId) {
    const motionElement = document.querySelector("#worker-detail .detail-motion");
    if (motionElement) {
      motionElement.textContent = MOTION_LABELS[motion];
    }
  }
}

// タコの向きを変える（right：絵のまま／left：左右反転）
function setActorFacing(record, facing) {
  record.facing = facing;
  record.actorElement.dataset.facing = facing;
}

// 置いたばかりのタコの、最初のモーション（動きを減らす設定では、役割の小物が見える仕事のポーズで止める）
function setInitialMotion(record) {
  setActorFacing(record, "right");
  if (prefersReducedMotion()) {
    const poses = Object.hasOwn(WORK_POSES, record.role) ? WORK_POSES[record.role] : WORK_POSES[OTHER_ROLE];
    setActorMotion(record, "work", poses[0]);
  } else {
    setActorMotion(record, "idle");
  }
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

// 作業場所ごとに、絵を出す人（最大 MAX_ACTORS_PER_SLOT 人）と「ほか○匹」を整える
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
  const record = { agent, role, state: initialState, actorElement: null, motion: "idle", facing: "right", frame: 0 };
  record.actorElement = createActorElement(record);
  writeActorInfo(record);
  setInitialMotion(record);

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

// ===== 歩いて入退室する見た目（在席状態とは別。タイマーは snapshot でまとめて片付ける） =====

// 見た目用のタイマーを登録する（clearVisualEffects でまとめて止められるように）
function scheduleVisualTimer(callback, delayMs) {
  const timerId = setTimeout(() => {
    visualTimerIds.delete(timerId);
    callback();
  }, delayMs);
  visualTimerIds.add(timerId);
  return timerId;
}

// 見た目用のタイマーを全部止め、#scene-fx（退室の影武者）を空にする
function clearVisualEffects() {
  for (const timerId of visualTimerIds) {
    clearTimeout(timerId);
  }
  visualTimerIds.clear();
  const effectLayer = byId("scene-fx");
  if (effectLayer) {
    effectLayer.replaceChildren();
  }
}

// 歩く演出をしてよいか（動きを減らす設定・工房や #scene-fx が無いときはしない）
function canPlayWalk() {
  return !prefersReducedMotion() && byId("scene") !== null && byId("scene-fx") !== null;
}

// 入口（自動ドア・エレベーター）の画面上の位置。CSS の --door-x / --door-y（#scene に対する %）を読む
// タコのいる .slot から読むので、上の階の作業場所は .slot に書いたエレベーターの位置になる（無ければ #scene の値を引き継ぐ）
function findDoorPoint(fromElement) {
  const scene = byId("scene");
  const sceneRect = scene.getBoundingClientRect();
  const slotElement = fromElement ? fromElement.closest(".slot") : null;
  const sceneStyle = getComputedStyle(slotElement || scene);
  const doorXPercent = parseFloat(sceneStyle.getPropertyValue("--door-x"));
  const doorYPercent = parseFloat(sceneStyle.getPropertyValue("--door-y"));
  const xPercent = Number.isFinite(doorXPercent) ? doorXPercent : DEFAULT_DOOR_PERCENT.x;
  const yPercent = Number.isFinite(doorYPercent) ? doorYPercent : DEFAULT_DOOR_PERCENT.y;
  return {
    x: sceneRect.left + (sceneRect.width * xPercent) / 100,
    y: sceneRect.top + (sceneRect.height * yPercent) / 100,
    sceneRect: sceneRect,
  };
}

// アニメの影響を外して、タコの絵（.octo-rig）の位置を測る（測ったあとの data-visual は呼び出し側が決める）
function measureActorRig(actorElement) {
  actorElement.dataset.visual = "measure";
  return actorElement.querySelector(".octo-rig").getBoundingClientRect();
}

// 入室：入口から自分の席まで歩いてくる（見た目だけ。data-state は今までどおり ENTER_MS で present になる）
function startEnterWalk(record) {
  const { actorElement } = record;
  if (!canPlayWalk() || actorElement.hidden || !actorElement.isConnected) {
    return;
  }
  const rigRect = measureActorRig(actorElement);
  if (rigRect.width === 0) {
    delete actorElement.dataset.visual;
    return;
  }
  // 足もと（絵の下の中央）から入口までのずれ。このずれの位置から 0 に向かって歩く
  const door = findDoorPoint(actorElement);
  const sceneScale = getSceneScale();
  const offsetX = (door.x - (rigRect.left + rigRect.width / 2)) / sceneScale;
  const offsetY = (door.y - rigRect.bottom) / sceneScale;
  actorElement.style.setProperty("--walk-from-x", `${Math.round(offsetX)}px`);
  actorElement.style.setProperty("--walk-from-y", `${Math.round(offsetY)}px`);
  actorElement.style.setProperty("--walk-ms", `${WALK_MS}ms`);
  actorElement.dataset.visual = "walk-in";
  // 入口が左にあれば右へ歩く
  setActorFacing(record, offsetX > 0 ? "left" : "right");
  setActorMotion(record, "walk");

  // 歩き終わったら席で待機（途中で退室・置き直しになっていたら何もしない）
  scheduleVisualTimer(() => {
    if (workers.get(record.agent.agentId) !== record || actorElement.dataset.visual !== "walk-in") {
      return;
    }
    delete actorElement.dataset.visual;
    setActorMotion(record, "idle");
  }, WALK_MS);
}

// 退室：席を立って入口まで歩いて出ていく
// 本物のタコは今までどおり LEAVE_MS で消えるので、#scene-fx に見た目だけの「影武者」を置いて歩かせる
function startLeaveWalk(record) {
  const { actorElement } = record;
  const effectLayer = byId("scene-fx");
  if (!canPlayWalk() || actorElement.hidden || !actorElement.isConnected) {
    return;
  }
  const rigElement = actorElement.querySelector(".octo-rig");
  const rigRect = measureActorRig(actorElement);
  if (rigRect.width === 0) {
    delete actorElement.dataset.visual;
    return;
  }
  const door = findDoorPoint(actorElement);
  const sceneScale = getSceneScale();
  const offsetX = (door.x - (rigRect.left + rigRect.width / 2)) / sceneScale;
  const offsetY = (door.y - rigRect.bottom) / sceneScale;

  // 影武者：絵の部分（.octo-rig）だけを複製する。ボタン・名札・id は持たない
  const ghostElement = createElementWithText("div", "octo-ghost");
  ghostElement.setAttribute("aria-hidden", "true");
  ghostElement.dataset.agentId = record.agent.agentId;
  ghostElement.dataset.role = record.role;
  ghostElement.dataset.motion = "walk";
  ghostElement.dataset.facing = offsetX < 0 ? "left" : "right";
  ghostElement.style.setProperty("--ghost-x", `${Math.round((rigRect.left - door.sceneRect.left) / sceneScale)}px`);
  ghostElement.style.setProperty("--ghost-y", `${Math.round((rigRect.top - door.sceneRect.top) / sceneScale)}px`);
  ghostElement.style.setProperty("--ghost-w", `${Math.round(rigRect.width / sceneScale)}px`);
  ghostElement.style.setProperty("--walk-to-x", `${Math.round(offsetX)}px`);
  ghostElement.style.setProperty("--walk-to-y", `${Math.round(offsetY)}px`);
  ghostElement.style.setProperty("--walk-ms", `${WALK_MS}ms`);
  ghostElement.append(rigElement.cloneNode(true));
  effectLayer.append(ghostElement);

  // 本物は見えなくする（DOM からは今までどおり LEAVE_MS 後に消える）
  actorElement.dataset.visual = "ghosted";

  // 歩き終わったら影武者を消す（animationend が来なくてもタイマーで必ず消す）
  const removeGhost = () => ghostElement.remove();
  ghostElement.addEventListener("animationend", (event) => {
    if (event.target === ghostElement) {
      removeGhost();
    }
  });
  scheduleVisualTimer(removeGhost, WALK_MS + GHOST_CLEANUP_MARGIN_MS);
}

// 一覧の行に合わせて、工房の作業場所とその役割のタコを強調する（role が null なら外す）
function highlightRole(role) {
  highlightedRole = role;
  for (const slotElement of document.querySelectorAll(".slot")) {
    slotElement.classList.toggle("is-highlighted", slotElement.dataset.role === role);
  }
  for (const record of workers.values()) {
    record.actorElement.classList.toggle("is-highlighted", record.role === role && record.state !== "leaving");
  }
}

// 一覧の行に、hover / focus で強調する仕組みを付ける
function attachRowHighlight(rowButton, role) {
  const turnOn = () => highlightRole(role);
  const turnOff = () => {
    if (highlightedRole === role) {
      highlightRole(null);
    }
  };
  rowButton.addEventListener("mouseenter", turnOn);
  rowButton.addEventListener("focus", turnOn);
  rowButton.addEventListener("mouseleave", turnOff);
  rowButton.addEventListener("blur", turnOff);
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
    attachRowHighlight(rowButton, role);

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
  // 行を作り直しても、強調中の役割はそのまま（新しく来たタコにも付ける）
  if (highlightedRole !== null) {
    highlightRole(highlightedRole);
  }
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
    ["動き", MOTION_LABELS[record.motion] || MOTION_LABELS.idle, "detail-motion"],
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
  // 歩きの見た目（影武者・タイマー）を先に片付ける
  clearVisualEffects();
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
  let enteredRecord = null; // 新しく置いたタコ（二重の enter なら null のまま）
  if (existingRecord && existingRecord.state !== "leaving" && existingRecord.role === findRole(agent.agentType)) {
    // 二重の enter：タコはそのまま、情報だけ書き換える
    existingRecord.agent = agent;
    writeActorInfo(existingRecord);
  } else {
    // 役割が変わった・退室中だったときは、古いタコを外してから置き直す
    if (existingRecord) {
      removeWorkerNow(existingRecord);
    }
    enteredRecord = placeWorker(agent, "entering");
  }
  enterCount += 1;
  eventCount += 1;
  addLogEntry("enter", enterData.time, `${agent.roleLabel} が入室しました（${agent.model}）`);
  refreshPanels();
  // 見た目：入口から席まで歩いてくる（席の並びが決まった refreshPanels の後で測る）
  if (enteredRecord) {
    startEnterWalk(enteredRecord);
  }
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

  let startedLeaving = false; // この leave で退室を始めたか
  if (record && record.state !== "leaving") {
    startedLeaving = true;
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
  // 見た目：席を立って入口へ歩いていく（data-state の切り替えとは別）
  if (startedLeaving) {
    startLeaveWalk(record);
  }
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

// ===== モーション指揮役（setInterval 1本で、在席中のタコの一部だけ動きを変える） =====

// 重み付きで動きを1つ選ぶ
function pickWeightedMotion() {
  const totalWeight = MOTION_WEIGHTS.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const item of MOTION_WEIGHTS) {
    roll -= item.weight;
    if (roll < 0) {
      return item.motion;
    }
  }
  return MOTION_WEIGHTS[0].motion;
}

// 指揮してよいタコか（在席中・絵が出ている・歩いていない）
function canConductMotion(record) {
  const { actorElement } = record;
  return record.state === "present" && !actorElement.hidden && actorElement.dataset.visual === undefined;
}

// 1回分の指揮（pickRate はテストで 1 にすると、対象のタコ全員の動きを変える）
function runMotionTick(pickRate = MOTION_PICK_RATE) {
  if (document.hidden || prefersReducedMotion()) {
    return;
  }
  for (const record of workers.values()) {
    if (!canConductMotion(record) || Math.random() >= pickRate) {
      continue;
    }
    const nextMotion = pickWeightedMotion();
    // 待機に戻るときは、ときどき反対を向く
    if (nextMotion === "idle" && Math.random() < FACING_TURN_RATE) {
      setActorFacing(record, record.facing === "left" ? "right" : "left");
    }
    setActorMotion(record, nextMotion);
  }
}

// 指揮を始める（タブが見えていて、動きを減らす設定でないときだけ）
function startMotionConductor() {
  if (motionConductorId !== null || document.hidden || prefersReducedMotion()) {
    return;
  }
  motionConductorId = setInterval(() => runMotionTick(), MOTION_TICK_MS);
}

// 指揮を止める
function stopMotionConductor() {
  if (motionConductorId !== null) {
    clearInterval(motionConductorId);
    motionConductorId = null;
  }
}

// タブの表示・非表示と「動きを減らす」設定の変化に合わせて、指揮を止めたり再開したりする
function setupMotionConductor() {
  const restartConductor = () => {
    stopMotionConductor();
    startMotionConductor();
  };
  document.addEventListener("visibilitychange", restartConductor);
  if (reducedMotionQuery && typeof reducedMotionQuery.addEventListener === "function") {
    reducedMotionQuery.addEventListener("change", restartConductor);
  }
  startMotionConductor();
}

// 指揮してよいタコ全員を、同じモーションにする（モックの確認用）
function setMotionForAll(motion) {
  for (const record of workers.values()) {
    if (canConductMotion(record)) {
      setActorMotion(record, motion);
    }
  }
}

// ===== 照明（昼・夕・夜） =====

// 照明のモード名から LIGHT_MODES の位置を探す（無ければ -1）
function findLightModeIndex(mode) {
  return LIGHT_MODES.findIndex((item) => item.mode === mode);
}

// 照明を切り替える：#scene の data-light と、互換のための .night、ボタンの文字と aria-label
function setLightMode(mode) {
  const modeIndex = findLightModeIndex(mode);
  if (modeIndex < 0) {
    return;
  }
  const currentMode = LIGHT_MODES[modeIndex];
  const nextMode = LIGHT_MODES[(modeIndex + 1) % LIGHT_MODES.length];
  currentLightMode = currentMode.mode;

  const scene = byId("scene");
  if (scene) {
    scene.dataset.light = currentMode.mode;
    scene.classList.toggle("night", currentMode.mode === "night");
  }
  const lightToggle = byId("light-toggle");
  if (lightToggle) {
    lightToggle.textContent = `${currentMode.icon} ${currentMode.shortLabel} → ${nextMode.shortLabel}にする`;
    lightToggle.setAttribute("aria-label", `照明：いまは${currentMode.longLabel}。押すと${nextMode.longLabel}にします`);
  }

  // 選んだ照明を覚えておく（保存できない設定のブラウザでも、表示はそのまま動く）
  try {
    localStorage.setItem(LIGHT_STORAGE_KEY, currentMode.mode);
  } catch (error) {
    // 保存できなくても困らないので何もしない
  }
}

// 昼 → 夕 → 夜 → 昼 の順に切り替える
function cycleLightMode() {
  const modeIndex = Math.max(0, findLightModeIndex(currentLightMode));
  setLightMode(LIGHT_MODES[(modeIndex + 1) % LIGHT_MODES.length].mode);
}

// 前に選んだ照明を読む（無い・読めないときは昼）
function loadSavedLightMode() {
  try {
    const savedMode = localStorage.getItem(LIGHT_STORAGE_KEY);
    return findLightModeIndex(savedMode) >= 0 ? savedMode : DEFAULT_LIGHT_MODE;
  } catch (error) {
    return DEFAULT_LIGHT_MODE;
  }
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

function startMockMode() {
  document.body.dataset.mode = "mock";
  setConnectionStatus("open", "モック表示中");
  const mockControls = byId("mock-controls");
  if (mockControls) {
    mockControls.hidden = false;
  }

  const mockState = { seq: 0, nextAgentNumber: 1 };

  // 偽のエージェントを1人作る（started_at は現地時刻。何分前に入室したか・役割を指定できる）
  function makeMockAgent(minutesAgo, chosenAgentType) {
    const agentType = chosenAgentType || pickRandom(MOCK_AGENT_TYPES);
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

  // 最初は各役割（other も含めて6つ）に1匹ずつ、少し前から在席している
  const firstAgents = MOCK_AGENT_TYPES.slice(0, ROLE_ORDER.length).map((agentType, index) =>
    makeMockAgent(3 + index * 11, agentType)
  );
  applySnapshot({ seq: 0, agents: firstAgents });
  addLogEntry("system", null, "モック表示を開始しました（偽のイベントです）");

  const enterButton = byId("mock-enter");
  const leaveButton = byId("mock-leave");
  if (enterButton) {
    enterButton.addEventListener("click", mockEnter);
  }
  if (leaveButton) {
    leaveButton.addEventListener("click", mockLeave);
  }

  // 照明・モーションを確かめるボタン（サーバー無しで全部の動きを見られるように）
  const mockButtonActions = {
    "mock-light": cycleLightMode,
    "mock-work": () => setMotionForAll("work"),
    "mock-react": () => setMotionForAll("react"),
    // 1匹が歩いて出ていき、別の1匹が歩いて入ってくる
    "mock-walk": () => {
      mockLeave();
      mockEnter();
    },
  };
  for (const [buttonId, action] of Object.entries(mockButtonActions)) {
    const button = byId(buttonId);
    if (button) {
      button.addEventListener("click", action);
    }
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

// ===== ボタン類（ページ内リンク・照明・工場長のひとこと） =====

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

  // 照明：昼 → 夕 → 夜 → 昼（#scene の data-light と .night を書き換える）
  const lightToggle = byId("light-toggle");
  if (lightToggle) {
    lightToggle.addEventListener("click", cycleLightMode);
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

// ===== 背景の拡大・縮小と移動（見た目だけ。#scene に transform を掛ける。位置の % や cqw は変わらない） =====

// 背景（街）の中で、オフィスがある範囲（横の割合）。最初とオフィスボタンではここを枠いっぱいに見せる
const OFFICE_RANGE = { left: 256 / 1536, right: 1280 / 1536 };
const ZOOM_STEP = 1.3; // ＋・－ボタン、ダブルクリック、ホイール1回あたりの倍率
const DRAG_START_PX = 5; // これより動いたらドラッグ（タコのクリックと区別する）
const viewState = { zoom: 1, panX: 0, panY: 0 };

// オフィスが枠いっぱいに見える倍率（これより大きくはしない。拡大の上限）
function getMaxZoom() {
  const scene = byId("scene");
  const viewport = byId("scene-viewport");
  if (!scene || !viewport || scene.offsetWidth === 0) {
    return 1;
  }
  const officeWidth = scene.offsetWidth * (OFFICE_RANGE.right - OFFICE_RANGE.left);
  return Math.min(viewport.clientWidth / officeWidth, viewport.clientHeight / scene.offsetHeight);
}

// 街全体が枠に収まる倍率（これより小さくはしない）
function getMinZoom() {
  const scene = byId("scene");
  const viewport = byId("scene-viewport");
  if (!scene || !viewport || scene.offsetWidth === 0) {
    return 1;
  }
  return Math.min(1, viewport.clientWidth / scene.offsetWidth, viewport.clientHeight / scene.offsetHeight);
}

// 画面上の大きさ ÷ 本来の大きさ（歩きの距離など、画面で測った値を #scene の中の値に直すのに使う）
function getSceneScale() {
  const scene = byId("scene");
  if (!scene || scene.offsetWidth === 0) {
    return 1;
  }
  return scene.getBoundingClientRect().width / scene.offsetWidth;
}

// 倍率と位置を #scene に書く（枠の外に余白が出ないように位置を詰める）
function applyView() {
  const scene = byId("scene");
  const viewport = byId("scene-viewport");
  if (!scene || !viewport) {
    return;
  }
  // 背景が枠より大きい向きは、枠の外に余白が出ないように詰める。小さい向きは真ん中に置く
  const clampPan = (pan, viewSize, sceneSize) =>
    sceneSize <= viewSize ? (viewSize - sceneSize) / 2 : Math.min(0, Math.max(viewSize - sceneSize, pan));
  viewState.panX = clampPan(viewState.panX, viewport.clientWidth, scene.offsetWidth * viewState.zoom);
  viewState.panY = clampPan(viewState.panY, viewport.clientHeight, scene.offsetHeight * viewState.zoom);
  scene.style.transform = `translate(${viewState.panX}px, ${viewState.panY}px) scale(${viewState.zoom})`;
  viewport.dataset.zoomed = viewState.zoom > 1.001 ? "true" : "false";
  // 上限・下限ではボタンを押せなくする
  const zoomInButton = byId("zoom-in");
  const zoomOutButton = byId("zoom-out");
  if (zoomInButton) {
    zoomInButton.disabled = viewState.zoom >= getMaxZoom() - 0.001;
  }
  if (zoomOutButton) {
    zoomOutButton.disabled = viewState.zoom <= getMinZoom() + 0.001;
  }
}

// 画面上の1点（clientX, clientY）を動かさずに倍率を変える
function zoomAt(nextZoom, clientX, clientY) {
  const viewport = byId("scene-viewport");
  if (!viewport) {
    return;
  }
  const rect = viewport.getBoundingClientRect();
  const zoom = Math.min(getMaxZoom(), Math.max(getMinZoom(), nextZoom));
  const pointX = clientX - rect.left;
  const pointY = clientY - rect.top;
  const worldX = (pointX - viewState.panX) / viewState.zoom;
  const worldY = (pointY - viewState.panY) / viewState.zoom;
  viewState.zoom = zoom;
  viewState.panX = pointX - worldX * zoom;
  viewState.panY = pointY - worldY * zoom;
  applyView();
}

function zoomAtCenter(factor) {
  const viewport = byId("scene-viewport");
  if (!viewport) {
    return;
  }
  const rect = viewport.getBoundingClientRect();
  zoomAt(viewState.zoom * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

// オフィスが枠いっぱいに見える位置（最初の表示）
function showOffice() {
  const scene = byId("scene");
  const viewport = byId("scene-viewport");
  if (!scene || !viewport) {
    return;
  }
  viewState.zoom = getMaxZoom();
  viewState.panX = -scene.offsetWidth * OFFICE_RANGE.left * viewState.zoom;
  viewState.panY = 0;
  applyView();
}

// 街全体を見せる
function showWholeCity() {
  viewState.zoom = getMinZoom();
  viewState.panX = 0;
  viewState.panY = 0;
  applyView();
}

// ボタン・ダブルクリック・Ctrl+ホイール（トラックパッドのピンチ）・ドラッグ・2本指ピンチ
function setupSceneZoom() {
  const viewport = byId("scene-viewport");
  if (!viewport) {
    return;
  }
  const zoomInButton = byId("zoom-in");
  const zoomOutButton = byId("zoom-out");
  const zoomResetButton = byId("zoom-reset");
  const zoomOfficeButton = byId("zoom-office");
  if (zoomInButton) {
    zoomInButton.addEventListener("click", () => zoomAtCenter(ZOOM_STEP));
  }
  if (zoomOutButton) {
    zoomOutButton.addEventListener("click", () => zoomAtCenter(1 / ZOOM_STEP));
  }
  if (zoomResetButton) {
    zoomResetButton.addEventListener("click", showWholeCity);
  }
  if (zoomOfficeButton) {
    zoomOfficeButton.addEventListener("click", showOffice);
  }

  // ふつうのホイールはページのスクロールに使う。Ctrl を押しながら（ピンチ操作を含む）なら拡大・縮小
  viewport.addEventListener("wheel", (event) => {
    if (!event.ctrlKey) {
      return;
    }
    event.preventDefault();
    zoomAt(viewState.zoom * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), event.clientX, event.clientY);
  }, { passive: false });

  viewport.addEventListener("dblclick", (event) => {
    if (event.target.closest(".zoom-controls, .worker-actor")) {
      return;
    }
    if (viewState.zoom >= getMaxZoom() - 0.001) {
      showWholeCity();
    } else {
      zoomAt(viewState.zoom * ZOOM_STEP * ZOOM_STEP, event.clientX, event.clientY);
    }
  });

  const pointers = new Map();
  let drag = null;
  let pinch = null;
  let suppressClick = false;
  viewport.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".zoom-controls")) {
      return;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      drag = { x: event.clientX, y: event.clientY, panX: viewState.panX, panY: viewState.panY, moved: false };
    } else if (pointers.size === 2) {
      const [first, second] = [...pointers.values()];
      pinch = { distance: Math.hypot(first.x - second.x, first.y - second.y), zoom: viewState.zoom };
      drag = null;
    }
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) {
      return;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size === 2) {
      const [first, second] = [...pointers.values()];
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      if (pinch.distance > 0) {
        zoomAt((pinch.zoom * distance) / pinch.distance, (first.x + second.x) / 2, (first.y + second.y) / 2);
      }
      return;
    }
    if (!drag) {
      return;
    }
    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    if (!drag.moved) {
      if (Math.hypot(deltaX, deltaY) < DRAG_START_PX) {
        return;
      }
      drag.moved = true;
      viewport.setPointerCapture(event.pointerId);
      viewport.dataset.dragging = "true";
    }
    viewState.panX = drag.panX + deltaX;
    viewState.panY = drag.panY + deltaY;
    applyView();
  });
  const endPointer = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) {
      pinch = null;
    }
    if (pointers.size === 0) {
      if (drag && drag.moved) {
        // ドラッグの終わりに来る click で、タコが選ばれないようにする
        suppressClick = true;
        setTimeout(() => {
          suppressClick = false;
        }, 0);
      }
      drag = null;
      delete viewport.dataset.dragging;
    }
  };
  viewport.addEventListener("pointerup", endPointer);
  viewport.addEventListener("pointercancel", endPointer);
  viewport.addEventListener("click", (event) => {
    if (suppressClick) {
      event.stopPropagation();
      event.preventDefault();
    }
  }, true);
  window.addEventListener("resize", applyView);
  showOffice();
}

// ===== 起動 =====

function start() {
  setupControls();
  setLightMode(loadSavedLightMode());
  setupMotionConductor();
  setupSceneZoom();
  refreshPanels();
  setInterval(refreshElapsedTimes, ELAPSED_REFRESH_MS);
  if (IS_MOCK_MODE) {
    startMockMode();
  } else {
    startLiveMode();
  }
}

start();
