"use strict";

/* =========================================================
   static/app.js の動作テスト（ブラウザで実行する）
   - app.js は app_test.js より先に読み込んでいるので、applySnapshot などがグローバルに見える
   - 待つ処理は setTimeout で 700ms（app.js の ENTER_MS / LEAVE_MS 500ms より長く）
   - 歩きの見た目（WALK_MS）を待つテストは WALK_MS + 500ms 待つ
   - 結果は #test-result に textContent で書く（成功なら "PASS 件数"、失敗なら "FAIL: …"）
   - innerHTML は使わない
   ========================================================= */
(function () {
  const GENERAL_SPRITE_URL = "/assets/octopus/general.png";
  const WAIT_MS = 700;

  const testCases = [];

  // テストを1件登録する（name は失敗時の表示用）
  function defineTest(name, testBody) {
    testCases.push({ name, testBody });
  }

  // ===== 確認用の小さな道具 =====

  function assertTrue(condition, message) {
    if (!condition) {
      throw new Error(message);
    }
  }

  function assertSame(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(`${message}（期待: ${JSON.stringify(expected)} / 実際: ${JSON.stringify(actual)}）`);
    }
  }

  function waitMilliseconds(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  // agent_id のタコを探す（無ければ null）
  function findActor(agentId) {
    return document.querySelector(`.worker-actor[data-agent-id="${agentId}"]`);
  }

  // 役割の作業場所を探す
  function findSlot(role) {
    return document.querySelector(`.slot[data-role="${role}"]`);
  }

  // ログ（新しい順）の項目
  function findLogItems() {
    return Array.from(document.querySelectorAll("#activity-log > li"));
  }

  // 「在室中」の人数（#summary-present の数字）
  function readPresentCount() {
    return parseInt(document.getElementById("summary-present").textContent, 10);
  }

  // 「工房の仲間たち」の役割の行
  function findCrewRow(role) {
    return document.querySelector(`#worker-list .crew-row[data-role="${role}"]`);
  }

  // 入室のイベント（サーバーが送る形に合わせる）
  function makeEnterEvent(agentId, agentType, model, seq, roleLabel) {
    return {
      kind: "enter",
      agent_id: agentId,
      agent_type: agentType,
      role_label: roleLabel || agentType,
      model: model,
      started_at: "2026-11-14T10:00:00",
      time: "2026-11-14T10:00:00.000",
      seq: seq,
    };
  }

  // モデル更新のイベント（data.kind は "model"）
  function makeUpdateEvent(agentId, model, seq) {
    return {
      kind: "model",
      agent_id: agentId,
      agent_type: "coder",
      role_label: "コーディング担当",
      model: model,
      time: "2026-11-14T10:05:00.000",
      seq: seq,
    };
  }

  // 退室のイベント（reason は "stop" か "timeout"）
  function makeLeaveEvent(agentId, seq, reason, roleLabel) {
    return {
      kind: "leave",
      agent_id: agentId,
      agent_type: "coder",
      role_label: roleLabel,
      reason: reason,
      time: "2026-11-14T10:10:00.000",
      seq: seq,
    };
  }

  // 画面を空にする（seq を 0 に戻し、ログも消す）
  function resetScreen() {
    applySnapshot({ seq: 0, agents: [] });
    document.getElementById("activity-log").replaceChildren();
  }

  // ===== テスト本体 =====

  defineTest("a: サーバー再起動で seq が戻っても反映される", () => {
    resetScreen();
    applySnapshot({ seq: 500, agents: [] });
    applyEnter(makeEnterEvent("agent-a1", "coder", "sonnet", 501));
    assertTrue(findActor("agent-a1") !== null, "seq 501 の enter でタコが出ていない");

    applySnapshot({ seq: 1, agents: [] });
    assertSame(lastSeq, 1, "snapshot 後の lastSeq");

    applyEnter(makeEnterEvent("agent-a2", "coder", "sonnet", 2));
    assertTrue(findActor("agent-a2") !== null, "再起動後の seq 2 の enter が無視された");
  });

  defineTest("b: 同じモデルの update はログに出ず、変わったときだけ出る", () => {
    resetScreen();
    applyEnter(makeEnterEvent("agent-b1", "coder", "sonnet", 1));
    assertSame(findLogItems().length, 1, "enter 後のログ件数");

    applyUpdate(makeUpdateEvent("agent-b1", "sonnet", 2));
    assertSame(findLogItems().length, 1, "同じモデルの update でログが増えた");

    applyUpdate(makeUpdateEvent("agent-b1", "opus", 3));
    assertSame(findLogItems().length, 2, "モデルが変わった update のログ件数");
    assertSame(findLogItems()[0].dataset.kind, "update", "新しいログの data-kind");
    assertSame(findActor("agent-b1").dataset.model, "opus", "タコの data-model");
    assertTrue(findCrewRow("coder").textContent.includes("opus"), "仲間たちの一覧にモデルが出ていない");
  });

  defineTest("c: 入室前の update はタコもログも作らない", () => {
    resetScreen();
    applyUpdate({
      kind: "model",
      agent_id: "agent-c1",
      agent_type: null,
      role_label: null,
      model: "opus",
      time: "2026-11-14T10:00:00.000",
      seq: 1,
    });
    assertTrue(findActor("agent-c1") === null, "入室前の update でタコが出た");
    assertSame(findLogItems().length, 0, "入室前の update でログが増えた");
    assertSame(readPresentCount(), 0, "入室前の update で人数が増えた");
  });

  defineTest("d: seq が古い（lastSeq 以下）イベントは無視される", () => {
    resetScreen();
    applySnapshot({ seq: 10, agents: [] });

    applyEnter(makeEnterEvent("agent-d1", "coder", "sonnet", 10));
    assertTrue(findActor("agent-d1") === null, "同じ seq の enter が処理された");

    applyEnter(makeEnterEvent("agent-d1", "coder", "sonnet", 11));
    assertTrue(findActor("agent-d1") !== null, "新しい seq の enter が処理されない");

    applyUpdate(makeUpdateEvent("agent-d1", "opus", 11));
    applyUpdate(makeUpdateEvent("agent-d1", "opus", 9));
    assertSame(findActor("agent-d1").dataset.model, "sonnet", "古い seq の update が処理された");

    applyLeave(makeLeaveEvent("agent-d1", 10, "stop", "コーディング担当"));
    assertSame(findActor("agent-d1").dataset.state, "entering", "古い seq の leave が処理された");
    assertSame(lastSeq, 11, "無視されたイベントで lastSeq が変わった");
  });

  defineTest("e: enter で entering → 700ms 後に present。人数と一覧が変わる", async () => {
    resetScreen();
    assertTrue(document.getElementById("scene-empty").classList.contains("visible"), "誰もいないのに案内が出ていない");

    applyEnter(makeEnterEvent("agent-e1", "researcher", "haiku", 1, "調査担当"));
    const actor = findActor("agent-e1");
    assertSame(actor.closest(".slot").dataset.role, "researcher", "タコが入った作業場所");
    assertSame(actor.dataset.state, "entering", "enter 直後の状態");
    assertSame(readPresentCount(), 1, "enter 直後の人数");
    assertTrue(!document.getElementById("scene-empty").classList.contains("visible"), "在室がいるのに案内が出ている");
    assertTrue(findCrewRow("researcher").textContent.includes("在室"), "一覧の調査担当が在室になっていない");

    await waitMilliseconds(WAIT_MS);
    assertSame(actor.dataset.state, "present", "700ms 後の状態");
  });

  defineTest("f: leave で leaving → 700ms 後にタコが消える", async () => {
    resetScreen();
    applyEnter(makeEnterEvent("agent-f1", "researcher", "haiku", 1, "調査担当"));
    await waitMilliseconds(WAIT_MS);

    const actor = findActor("agent-f1");
    applyLeave(makeLeaveEvent("agent-f1", 2, "stop", "調査担当"));
    assertSame(actor.dataset.state, "leaving", "leave 直後の状態");
    assertSame(readPresentCount(), 0, "leaving のタコは人数に数えない");

    const leaveLogItem = findLogItems()[0];
    assertSame(leaveLogItem.dataset.kind, "leave", "退室のログ data-kind");
    assertSame(leaveLogItem.dataset.reason, undefined, "stop の退室に data-reason が付いた");

    await waitMilliseconds(WAIT_MS);
    assertTrue(!actor.isConnected, "700ms 後もタコが画面に残っている");
    assertTrue(findCrewRow("researcher").textContent.includes("不在"), "一覧の調査担当が不在に戻らない");
  });

  defineTest("f2: reason timeout の退室はログに data-reason=timeout が付く", async () => {
    resetScreen();
    applyEnter(makeEnterEvent("agent-f2", "coder", "sonnet", 1));
    applyLeave(makeLeaveEvent("agent-f2", 2, "timeout", "コーディング担当"));

    const newestLogItem = findLogItems()[0];
    assertSame(newestLogItem.dataset.reason, "timeout", "timeout の退室の data-reason");
    assertTrue(newestLogItem.textContent.includes("時間切れ"), "timeout のログの文字に「時間切れ」が無い");

    await waitMilliseconds(WAIT_MS);
    assertTrue(findActor("agent-f2") === null, "timeout の退室でタコが消えていない");
  });

  defineTest("f3: 退室中にほかのイベントが届いても、退室のアニメが続く", async () => {
    resetScreen();
    applyEnter(makeEnterEvent("agent-f3", "researcher", "haiku", 1, "調査担当"));
    await waitMilliseconds(WAIT_MS);
    const actor = findActor("agent-f3");

    applyLeave(makeLeaveEvent("agent-f3", 2, "stop", "調査担当"));
    applyEnter(makeEnterEvent("agent-f3b", "coder", "sonnet", 3));
    applyUpdate(makeUpdateEvent("agent-f3b", "opus", 4));
    assertTrue(actor.isConnected, "ほかのイベントで退室中のタコがすぐ消えた");
    assertSame(actor.dataset.state, "leaving", "退室中のタコの状態");
    assertTrue(!actor.hidden, "退室中のタコが隠れた");

    await waitMilliseconds(WAIT_MS);
    assertTrue(!actor.isConnected, "アニメの後もタコが残っている");
  });

  defineTest("g: 知らない agent_type は other の作業場所に入り、general の絵になる", () => {
    resetScreen();
    applyEnter(makeEnterEvent("agent-g1", "Explore", "haiku", 1, "Explore"));
    const actor = findActor("agent-g1");
    assertTrue(actor !== null, "知らない agent_type のタコが出ていない");
    assertSame(actor.closest(".slot").dataset.role, "other", "タコが入った作業場所");
    assertSame(actor.querySelector("img").getAttribute("src"), GENERAL_SPRITE_URL, "general の絵");
    assertSame(actor.dataset.agentType, "Explore", "タコの data-agent-type");
  });

  defineTest("h: agent_type に ../x や absent が来ても general の絵で other に入る", () => {
    resetScreen();
    const suspiciousAgentTypes = ["../x", "absent", "generic", "other"];
    suspiciousAgentTypes.forEach((agentType, index) => {
      applyEnter(makeEnterEvent(`agent-h${index}`, agentType, "sonnet", index + 1));
    });
    suspiciousAgentTypes.forEach((agentType, index) => {
      const actor = findActor(`agent-h${index}`);
      assertTrue(actor !== null, `agent_type "${agentType}" のタコが出ていない`);
      assertSame(actor.closest(".slot").dataset.role, "other", `agent_type "${agentType}" の作業場所`);
      assertSame(actor.querySelector("img").getAttribute("src"), GENERAL_SPRITE_URL, `agent_type "${agentType}" の絵`);
    });
  });

  defineTest("i: ログは最大50件で、古いものから消える", () => {
    resetScreen();
    for (let number = 1; number <= 60; number += 1) {
      applyEnter(makeEnterEvent(`agent-i${number}`, "coder", "sonnet", number, `担当${number}`));
    }
    const logItems = findLogItems();
    assertSame(logItems.length, 50, "ログの件数");
    assertTrue(logItems[0].textContent.includes("担当60"), "一番新しいログが先頭に無い");
    assertTrue(logItems[49].textContent.includes("担当11"), "一番古く残るログが違う（11 件目のはず）");
  });

  defineTest("j: snapshot でタコが全部置き直され、在室者は present で置かれる", () => {
    resetScreen();
    applyEnter(makeEnterEvent("agent-j1", "researcher", "haiku", 1, "調査担当"));

    applySnapshot({
      seq: 5,
      agents: [
        { agent_id: "agent-j2", agent_type: "coder", role_label: "コーディング担当", model: "opus", started_at: "2026-11-14T09:00:00" },
        { agent_id: "agent-j3", agent_type: "researcher", role_label: "調査担当", model: "sonnet", started_at: "2026-11-14T09:30:00" },
      ],
    });
    assertTrue(findActor("agent-j1") === null, "snapshot で古いタコが消えていない");
    assertSame(findActor("agent-j2").dataset.state, "present", "snapshot のタコの状態（アニメなしで present）");
    assertSame(findActor("agent-j3").dataset.state, "present", "snapshot のタコの状態（アニメなしで present）");
    assertSame(readPresentCount(), 2, "snapshot 後の人数");
  });

  defineTest("k: 同じ agent_id の二重 enter ではタコが1匹のまま", () => {
    resetScreen();
    applyEnter(makeEnterEvent("agent-k1", "coder", "sonnet", 1));
    applyEnter(makeEnterEvent("agent-k1", "coder", "opus", 2));
    assertSame(document.querySelectorAll('.worker-actor[data-agent-id="agent-k1"]').length, 1, "タコの数");
    assertSame(findActor("agent-k1").dataset.model, "opus", "二重 enter で情報が更新されない");
    assertSame(readPresentCount(), 1, "二重 enter で人数が増えた");

    // 役割が変わった enter は、新しい作業場所に置き直す
    applyEnter(makeEnterEvent("agent-k1", "researcher", "haiku", 3, "調査担当"));
    assertSame(document.querySelectorAll('.worker-actor[data-agent-id="agent-k1"]').length, 1, "役割変更後のタコの数");
    assertSame(findActor("agent-k1").closest(".slot").dataset.role, "researcher", "役割変更後の作業場所");
  });

  defineTest("l: 1つの作業場所に絵を出すのは4匹まで。残りは「ほか○匹」", () => {
    resetScreen();
    for (let number = 1; number <= 6; number += 1) {
      applyEnter(makeEnterEvent(`agent-l${number}`, "coder", "sonnet", number));
    }
    const slot = findSlot("coder");
    const shownActors = Array.from(slot.querySelectorAll(".worker-actor")).filter((actor) => !actor.hidden);
    assertSame(shownActors.length, 4, "絵を出している数");
    const badge = slot.querySelector(".overflow-badge");
    assertTrue(badge !== null && !badge.hidden, "「ほか○匹」が出ていない");
    assertSame(badge.textContent, "ほか2匹", "「ほか○匹」の文字");
    assertSame(readPresentCount(), 6, "人数");
  });

  defineTest("m: 届いた文字は HTML として解釈されない", () => {
    resetScreen();
    const suspiciousLabel = '<img src="/x" id="injected-m">';
    applyEnter(makeEnterEvent("agent-m1", "coder", "sonnet", 1, suspiciousLabel));
    assertTrue(document.getElementById("injected-m") === null, "role_label の中のタグが要素になった");
    assertSame(findActor("agent-m1").querySelector(".bubble").textContent, suspiciousLabel, "吹き出しの文字");
    assertTrue(findLogItems()[0].textContent.includes(suspiciousLabel), "ログに文字のまま出ていない");
  });

  defineTest("n: toLocalTimestamp は現地時刻で、タイムゾーン記号を付けない", () => {
    const text = toLocalTimestamp(new Date(2026, 0, 2, 3, 4, 5, 6));
    assertSame(text, "2026-01-02T03:04:05.006", "toLocalTimestamp の結果");
    // 現地時刻の今を入室時刻にすると、経過は 0:00 付近（9時間ずれたりしない）
    const elapsed = formatElapsed(toLocalTimestamp(new Date()).slice(0, 19));
    assertTrue(elapsed === "0:00" || elapsed === "0:01", `入室直後の経過が 0:00 にならない（${elapsed}）`);
  });

  // ===== 照明・モーション（見た目は data-state と別に動く） =====

  const MOTION_NAMES = ["idle", "walk", "work", "react"];
  // 歩きの見た目（WALK_MS）と影武者の片付けが終わるまで待つ時間
  const WALK_WAIT_MS = WALK_MS + 500;

  // 在席中の1匹を snapshot で置く（アニメなしで present）
  function placePresentAgent(agentId, agentType, roleLabel) {
    applySnapshot({
      seq: 0,
      agents: [{ agent_id: agentId, agent_type: agentType, role_label: roleLabel || agentType, model: "sonnet", started_at: "2026-11-14T09:00:00" }],
    });
  }

  defineTest("o: 照明ボタンで 昼→夕→夜→昼 と回り、夜だけ .night が付く", () => {
    const scene = document.getElementById("scene");
    const lightToggle = document.getElementById("light-toggle");
    setLightMode("day");
    assertSame(scene.dataset.light, "day", "最初の照明");
    assertTrue(!scene.classList.contains("night"), "昼なのに .night が付いている");

    lightToggle.click();
    assertSame(scene.dataset.light, "dusk", "1回押した後の照明");
    assertTrue(!scene.classList.contains("night"), "夕方なのに .night が付いている");

    lightToggle.click();
    assertSame(scene.dataset.light, "night", "2回押した後の照明");
    assertTrue(scene.classList.contains("night"), "夜なのに .night が付いていない");
    const labelText = lightToggle.getAttribute("aria-label");
    assertTrue(labelText.includes("夜") && labelText.includes("昼"), `aria-label に今と次のモードが無い（${labelText}）`);
    assertTrue(lightToggle.textContent.includes("夜") && lightToggle.textContent.includes("昼"), "ボタンの文字に今と次のモードが無い");

    lightToggle.click();
    assertSame(scene.dataset.light, "day", "3回押した後の照明");
    assertTrue(!scene.classList.contains("night"), "昼に戻っても .night が残っている");

    // 照明レイヤーはクリックを妨げない
    assertSame(getComputedStyle(document.querySelector(".light-layer")).pointerEvents, "none", "照明レイヤーの pointer-events");
    assertSame(getComputedStyle(document.getElementById("scene-fx")).pointerEvents, "none", "#scene-fx の pointer-events");
  });

  defineTest("p: enter したタコに data-motion・data-facing・data-frame と中身の部品が付く", () => {
    resetScreen();
    applyEnter(makeEnterEvent("agent-p1", "coder", "sonnet", 1));
    const actor = findActor("agent-p1");
    assertTrue(MOTION_NAMES.includes(actor.dataset.motion), `data-motion が無い・知らない値（${actor.dataset.motion}）`);
    assertTrue(actor.dataset.facing === "left" || actor.dataset.facing === "right", "data-facing が無い");
    assertSame(actor.dataset.frame, "0", "1枚絵の data-frame");
    assertSame(actor.dataset.state, "entering", "在席状態は今までどおり entering");
    // 部品：最初の img が役割の絵、名札は button の直下
    assertTrue(actor.querySelector(".octo-rig > .octo-body > img.octo-sprite") !== null, "octo-rig > octo-body > img が無い");
    assertSame(actor.querySelector("img"), actor.querySelector(".octo-sprite"), "最初の img が本体の絵ではない");
    assertTrue(actor.querySelector(".octo-lids") !== null, "まぶたが無い");
    assertTrue(actor.querySelector(".octo-prop") !== null, "小物の要素が無い");
    assertTrue(actor.querySelector(".octo-mark") !== null, "記号の要素が無い");
    assertTrue(actor.querySelector(":scope > .bubble") !== null, "名札（.bubble）が button の直下に無い");
    // 動きを減らす設定でなければ、入口から歩いてくる
    if (!prefersReducedMotion()) {
      assertSame(actor.dataset.motion, "walk", "入室直後のモーション");
      assertSame(actor.dataset.visual, "walk-in", "入室直後の data-visual");
    }
  });

  defineTest("q: leave で #scene-fx に影武者ができ、歩き終わると消える", async () => {
    resetScreen();
    placePresentAgent("agent-q1", "researcher", "調査担当");
    applyLeave(makeLeaveEvent("agent-q1", 1, "stop", "調査担当"));
    const effectLayer = document.getElementById("scene-fx");
    const ghosts = effectLayer.querySelectorAll(".octo-ghost");
    assertSame(findActor("agent-q1").dataset.state, "leaving", "在席状態は今までどおり leaving");
    if (prefersReducedMotion()) {
      assertSame(ghosts.length, 0, "動きを減らす設定なのに影武者ができた");
      return;
    }
    assertSame(ghosts.length, 1, "影武者の数");
    assertSame(ghosts[0].getAttribute("aria-hidden"), "true", "影武者は読み上げない");
    assertTrue(ghosts[0].querySelector("[id], button, .bubble") === null, "影武者に id・ボタン・名札が入っている");
    assertSame(findActor("agent-q1").dataset.visual, "ghosted", "本物のタコは見えなくする");

    await waitMilliseconds(WALK_WAIT_MS);
    assertSame(effectLayer.children.length, 0, "歩き終わっても影武者が残っている");
    assertTrue(findActor("agent-q1") === null, "本物のタコが消えていない");
  });

  defineTest("r: snapshot で #scene-fx が空になり、歩きの見た目とタイマーも片付く", async () => {
    resetScreen();
    placePresentAgent("agent-r1", "researcher", "調査担当");
    applyLeave(makeLeaveEvent("agent-r1", 1, "stop", "調査担当"));
    applyEnter(makeEnterEvent("agent-r2", "coder", "sonnet", 2));

    applySnapshot({
      seq: 3,
      agents: [{ agent_id: "agent-r2", agent_type: "coder", role_label: "コーディング担当", model: "sonnet", started_at: "2026-11-14T09:00:00" }],
    });
    assertSame(document.getElementById("scene-fx").children.length, 0, "snapshot 後の #scene-fx");
    assertSame(visualTimerIds.size, 0, "snapshot 後も見た目用のタイマーが残っている");
    const actor = findActor("agent-r2");
    assertSame(actor.dataset.state, "present", "snapshot のタコの状態");
    assertSame(actor.dataset.visual, undefined, "snapshot のタコが歩いている");

    await waitMilliseconds(WAIT_MS);
    assertSame(actor.dataset.visual, undefined, "snapshot の後で歩きが始まった");
    assertTrue(MOTION_NAMES.includes(actor.dataset.motion), "snapshot のタコの data-motion");
  });

  defineTest("s: 同じ役割5匹・二重 enter・5匹目の退室でも壊れない", async () => {
    resetScreen();
    for (let number = 1; number <= 5; number += 1) {
      applyEnter(makeEnterEvent(`agent-s${number}`, "coder", "sonnet", number));
    }
    applyEnter(makeEnterEvent("agent-s1", "coder", "opus", 6));
    const slot = findSlot("coder");
    const actors = Array.from(slot.querySelectorAll(".worker-actor"));
    assertSame(actors.length, 5, "二重 enter の後のタコの数");
    const hiddenActor = actors.find((actor) => actor.hidden);
    assertTrue(hiddenActor !== undefined, "5匹目が hidden になっていない");
    assertSame(hiddenActor.dataset.visual, undefined, "hidden のタコが歩いている");

    // 5匹目が退室：見えるようにしてから歩き去る（影武者は多くても1つ）
    applyLeave(makeLeaveEvent(hiddenActor.dataset.agentId, 7, "stop", "コーディング担当"));
    assertTrue(document.getElementById("scene-fx").children.length <= 1, "影武者が2つ以上できた");

    await waitMilliseconds(WALK_WAIT_MS);
    const remainingActors = Array.from(slot.querySelectorAll(".worker-actor"));
    assertSame(remainingActors.length, 4, "退室後のタコの数");
    assertTrue(remainingActors.every((actor) => !actor.hidden), "4匹なのに hidden のタコがいる");
    assertTrue(slot.querySelector(".overflow-badge").hidden, "4匹なのに「ほか○匹」が出ている");
    assertSame(document.getElementById("scene-fx").children.length, 0, "影武者が残っている");
    assertSame(readPresentCount(), 4, "退室後の人数");
  });

  defineTest("t: モーション指揮役は hidden・退室中のタコを触らず、絵が出ている在席者だけ動かす", () => {
    resetScreen();
    const agents = [];
    for (let number = 1; number <= 6; number += 1) {
      agents.push({ agent_id: `agent-t${number}`, agent_type: "coder", role_label: "コーディング担当", model: "sonnet", started_at: "2026-11-14T09:00:00" });
    }
    applySnapshot({ seq: 0, agents: agents });
    applyLeave(makeLeaveEvent("agent-t1", 1, "stop", "コーディング担当"));
    const actors = Array.from(findSlot("coder").querySelectorAll(".worker-actor"));
    for (const actor of actors) {
      actor.dataset.motion = "test-sentinel";
    }

    runMotionTick(1);
    const isPaused = document.hidden || prefersReducedMotion();
    for (const actor of actors) {
      const isConductable = actor.dataset.state === "present" && !actor.hidden;
      if (isPaused || !isConductable) {
        assertSame(actor.dataset.motion, "test-sentinel", `指揮役が触ってはいけないタコを動かした（${actor.dataset.agentId}）`);
      } else {
        assertTrue(MOTION_NAMES.includes(actor.dataset.motion), `指揮役が動かさなかった（${actor.dataset.agentId}）`);
      }
    }
    // DOM は作り直さない（同じ要素のまま）
    assertSame(findActor("agent-t2"), actors.find((actor) => actor.dataset.agentId === "agent-t2"), "タコの要素が作り直された");
  });

  defineTest("u: 一覧の行に hover / focus すると、工房の作業場所とタコが強調される", () => {
    resetScreen();
    placePresentAgent("agent-u1", "researcher", "調査担当");
    const row = findCrewRow("researcher");
    row.dispatchEvent(new Event("mouseenter"));
    assertTrue(findSlot("researcher").classList.contains("is-highlighted"), "hover で作業場所が強調されない");
    assertTrue(findActor("agent-u1").classList.contains("is-highlighted"), "hover でタコが強調されない");
    assertTrue(!findSlot("coder").classList.contains("is-highlighted"), "ほかの作業場所まで強調された");
    row.dispatchEvent(new Event("mouseleave"));
    assertTrue(!findSlot("researcher").classList.contains("is-highlighted"), "hover を外しても強調が残る");

    const focusRow = findCrewRow("researcher");
    focusRow.dispatchEvent(new FocusEvent("focus"));
    assertTrue(findActor("agent-u1").classList.contains("is-highlighted"), "focus でタコが強調されない");
    focusRow.dispatchEvent(new FocusEvent("blur"));
    assertTrue(!findActor("agent-u1").classList.contains("is-highlighted"), "blur しても強調が残る");
  });

  defineTest("v: 詳細パネルにモーション名が日本語で出て、モーションが変わると書き換わる", () => {
    resetScreen();
    placePresentAgent("agent-v1", "coder", "コーディング担当");
    selectWorker("agent-v1");
    const motionText = document.querySelector("#worker-detail .detail-motion");
    assertTrue(motionText !== null, "詳細にモーションの欄が無い");
    assertTrue(Object.values(MOTION_LABELS).includes(motionText.textContent), `モーション名が日本語でない（${motionText.textContent}）`);

    const record = workers.get("agent-v1");
    setActorMotion(record, "work");
    assertSame(motionText.textContent, "作業中", "work の表示");
    assertTrue(WORK_POSES.coder.includes(findActor("agent-v1").dataset.pose), "coder の仕事のポーズ");

    setActorMotion(record, "react", "joy");
    assertSame(motionText.textContent, "リアクション", "react の表示");
    assertSame(findActor("agent-v1").dataset.react, "joy", "リアクションの種類");
    assertSame(findActor("agent-v1").dataset.pose, undefined, "react なのに仕事のポーズが残っている");
  });

  // ===== 壊れたデータ・動きを減らす設定・保存できない環境・歩きの細かい部分 =====

  // 「動きを減らす」設定の見え方を、テストの間だけ変える（元に戻す関数を返す）
  function overrideReducedMotion(isReduced) {
    Object.defineProperty(reducedMotionQuery, "matches", { configurable: true, get: () => isReduced });
    return () => {
      delete reducedMotionQuery.matches;
    };
  }

  // タブが隠れている状態を、テストの間だけ変える（元に戻す関数を返す）
  function overrideDocumentHidden(isHidden) {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => isHidden });
    return () => {
      delete document.hidden;
    };
  }

  defineTest("w: 壊れた snapshot は画面を壊さない（null・文字・agents が配列でない・id が無い）", () => {
    resetScreen();
    placePresentAgent("agent-w1", "coder", "コーディング担当");
    applySnapshot(null);
    applySnapshot("broken");
    assertTrue(findActor("agent-w1") !== null, "中身の無い snapshot で画面のタコが消えた");

    applySnapshot({ seq: "abc", agents: "not-array" });
    assertSame(lastSeq, -1, "seq が数でないときの lastSeq");
    assertSame(workers.size, 0, "agents が配列でないのに在席者が残った");

    applySnapshot({
      seq: 3,
      agents: [
        null,
        { agent_type: "coder" },
        { agent_id: "", agent_type: "coder" },
        { agent_id: "agent-w2", agent_type: "coder", role_label: "コーディング担当", model: "sonnet", started_at: "2026-11-14T09:00:00" },
      ],
    });
    assertSame(document.querySelectorAll(".worker-actor").length, 1, "壊れた項目でタコが出た");
    assertTrue(findActor("agent-w2") !== null, "正しい1件が出ていない");
    assertSame(readPresentCount(), 1, "人数");
  });

  defineTest("x: 退室アニメ中に同じ agent_id が再入室しても、新しいタコは古い退室の時計で消えない", async () => {
    resetScreen();
    placePresentAgent("agent-x1", "coder", "コーディング担当");
    applyLeave(makeLeaveEvent("agent-x1", 1, "stop", "コーディング担当"));
    const oldActor = findActor("agent-x1");
    applyEnter(makeEnterEvent("agent-x1", "coder", "sonnet", 2));
    const newActor = findActor("agent-x1");
    assertTrue(newActor !== null && newActor !== oldActor, "再入室で新しいタコが置かれていない");
    assertTrue(!oldActor.isConnected, "退室中の古いタコが残っている");
    assertSame(newActor.dataset.state, "entering", "再入室直後の状態");
    assertSame(readPresentCount(), 1, "再入室後の人数");

    await waitMilliseconds(WAIT_MS);
    assertTrue(newActor.isConnected && findActor("agent-x1") === newActor, "古い退室の時計で新しいタコが消えた");
    assertSame(newActor.dataset.state, "present", "700ms 後の状態");
    assertSame(document.querySelectorAll('.worker-actor[data-agent-id="agent-x1"]').length, 1, "タコの数");
  });

  defineTest("y: localStorage が例外を投げる環境でも、照明は切り替わり昼で起動する", () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("localStorage は使えません（テスト）");
      },
    });
    try {
      assertSame(loadSavedLightMode(), "day", "読めないときに昼で起動しなかった");
      setLightMode("night");
      assertSame(document.getElementById("scene").dataset.light, "night", "保存に失敗すると照明が変わらない");
      cycleLightMode();
      assertSame(document.getElementById("scene").dataset.light, "day", "夜の次が昼にならない");
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(window, "localStorage", originalDescriptor);
      } else {
        delete window.localStorage;
      }
      setLightMode("day");
    }
  });

  defineTest("z: 役割ごとに仕事のポーズが決まり、小物（.octo-prop）が見える", () => {
    resetScreen();
    const roles = Object.keys(WORK_POSES);
    applySnapshot({
      seq: 0,
      agents: roles.map((role) => ({
        agent_id: `agent-z-${role}`,
        agent_type: role === OTHER_ROLE ? "Explore" : role,
        role_label: ROLE_LABELS[role],
        model: "sonnet",
        started_at: "2026-11-14T09:00:00",
      })),
    });
    for (const role of roles) {
      const record = workers.get(`agent-z-${role}`);
      assertSame(record.role, role, "作業場所の役割");
      for (const pose of WORK_POSES[role]) {
        setActorMotion(record, "work", pose);
        assertSame(record.actorElement.dataset.pose, pose, `${role} の仕事のポーズ`);
        assertSame(record.actorElement.dataset.motion, "work", `${role} の動き`);
        assertSame(getComputedStyle(record.actorElement.querySelector(".octo-prop")).display, "block", `${role}（${pose}）の小物が見えない`);
      }
      // 知らないポーズは、その役割のポーズから選び直す
      setActorMotion(record, "work", "知らないポーズ");
      assertTrue(WORK_POSES[role].includes(record.actorElement.dataset.pose), `${role} の知らないポーズの扱い`);
    }
  });

  defineTest("aa: 動きを減らす設定では、入室で歩かず仕事のポーズで止まり、退室で影武者を出さず、指揮役も動かない", () => {
    const restoreReducedMotion = overrideReducedMotion(true);
    try {
      resetScreen();
      applyEnter(makeEnterEvent("agent-aa1", "researcher", "haiku", 1, "調査担当"));
      const enteredActor = findActor("agent-aa1");
      assertTrue(enteredActor.dataset.visual === undefined, "動きを減らす設定なのに入室で歩いた");
      assertSame(enteredActor.dataset.motion, "work", "動きを減らす設定の入室直後の動き");
      assertSame(enteredActor.dataset.pose, WORK_POSES.researcher[0], "動きを減らす設定の仕事のポーズ");

      placePresentAgent("agent-aa2", "coder", "コーディング担当");
      const presentActor = findActor("agent-aa2");
      presentActor.dataset.motion = "test-sentinel";
      runMotionTick(1);
      assertSame(presentActor.dataset.motion, "test-sentinel", "動きを減らす設定で指揮役が動かした");

      applyLeave(makeLeaveEvent("agent-aa1", 2, "stop", "調査担当"));
      assertSame(document.getElementById("scene-fx").children.length, 0, "動きを減らす設定なのに影武者が出た");
      assertTrue(enteredActor.dataset.visual === undefined, "動きを減らす設定なのに本物が ghosted になった");

      stopMotionConductor();
      startMotionConductor();
      assertSame(motionConductorId, null, "動きを減らす設定で指揮役が始まった");
    } finally {
      restoreReducedMotion();
      stopMotionConductor();
      startMotionConductor();
    }
  });

  defineTest("ab: タブが隠れている間は、モーション指揮役がタコを動かさない", () => {
    resetScreen();
    placePresentAgent("agent-ab1", "coder", "コーディング担当");
    const actor = findActor("agent-ab1");
    actor.dataset.motion = "test-sentinel";
    const restoreHidden = overrideDocumentHidden(true);
    try {
      runMotionTick(1);
      assertSame(actor.dataset.motion, "test-sentinel", "隠れたタブで指揮役が動かした");
    } finally {
      restoreHidden();
    }
    runMotionTick(1);
    assertTrue(MOTION_NAMES.includes(actor.dataset.motion), "表示に戻ったのに指揮役が動かない");
  });

  defineTest("ac: 歩いている最中のタコは指揮役が触らず、歩き終わると歩く動きをやめる", async () => {
    if (prefersReducedMotion()) {
      return;
    }
    resetScreen();
    applyEnter(makeEnterEvent("agent-ac1", "coder", "sonnet", 1));
    const actor = findActor("agent-ac1");
    assertSame(actor.dataset.visual, "walk-in", "入室の歩きが始まっていない");

    // ENTER_MS（500ms）過ぎると present になるが、歩きは WALK_MS（1400ms）まで続く。その時間帯を狙う
    await waitMilliseconds(WAIT_MS);
    assertSame(actor.dataset.state, "present", "歩きの途中で present になっていない");
    assertSame(actor.dataset.visual, "walk-in", "present になった時点で歩きが終わっている");
    runMotionTick(1);
    assertSame(actor.dataset.motion, "walk", "歩いている最中（present）に指揮役が動きを変えた");

    await waitMilliseconds(WALK_WAIT_MS - WAIT_MS);
    assertTrue(actor.dataset.visual === undefined, "歩き終わったのに data-visual が残っている");
    assertTrue(actor.dataset.motion !== "walk", "歩き終わっても walk のまま");
  });

  defineTest("ad: 保存された照明を読み書きする（知らない値・無いときは昼）", () => {
    const savedBefore = localStorage.getItem(LIGHT_STORAGE_KEY);
    try {
      localStorage.setItem(LIGHT_STORAGE_KEY, "night");
      assertSame(loadSavedLightMode(), "night", "保存した夜を読めない");
      localStorage.setItem(LIGHT_STORAGE_KEY, "midnight-party");
      assertSame(loadSavedLightMode(), "day", "知らない値で昼にならない");
      localStorage.removeItem(LIGHT_STORAGE_KEY);
      assertSame(loadSavedLightMode(), "day", "保存が無いときに昼にならない");

      setLightMode("dusk");
      assertSame(localStorage.getItem(LIGHT_STORAGE_KEY), "dusk", "切り替えた照明が保存されない");
    } finally {
      if (savedBefore === null) {
        localStorage.removeItem(LIGHT_STORAGE_KEY);
      } else {
        localStorage.setItem(LIGHT_STORAGE_KEY, savedBefore);
      }
      setLightMode("day");
    }
  });

  defineTest("ae: 影武者は歩き終わりの animationend で、タイマーを待たずに消える", () => {
    if (prefersReducedMotion()) {
      return;
    }
    resetScreen();
    placePresentAgent("agent-ae1", "coder", "コーディング担当");
    applyLeave(makeLeaveEvent("agent-ae1", 1, "stop", "コーディング担当"));
    const ghostElement = document.querySelector("#scene-fx .octo-ghost");
    assertTrue(ghostElement !== null, "影武者が無い");
    ghostElement.dispatchEvent(new Event("animationend"));
    assertSame(document.getElementById("scene-fx").children.length, 0, "animationend で影武者が消えていない");
  });

  // ===== 実行と結果の書き込み =====

  async function runAllTests() {
    const failureMessages = [];
    let passedCount = 0;

    for (const testCase of testCases) {
      try {
        await testCase.testBody();
        passedCount += 1;
      } catch (error) {
        const errorText = error && error.message ? error.message : String(error);
        failureMessages.push(`${testCase.name} → ${errorText}`);
      }
    }

    const resultElement = document.getElementById("test-result");
    if (failureMessages.length === 0) {
      resultElement.textContent = `PASS ${passedCount}`;
    } else {
      resultElement.textContent =
        `FAIL: ${failureMessages.length} 件失敗（全 ${testCases.length} 件中） ／ ` + failureMessages.join(" ／ ");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runAllTests);
  } else {
    runAllTests();
  }
})();
