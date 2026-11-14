"use strict";

/* =========================================================
   static/app.js の動作テスト（ブラウザで実行する）
   - app.js は app_test.js より先に読み込んでいるので、applySnapshot などがグローバルに見える
   - 待つ処理は setTimeout で 700ms（app.js の ENTER_MS / LEAVE_MS 500ms より長く）
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
