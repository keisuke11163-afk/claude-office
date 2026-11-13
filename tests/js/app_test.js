"use strict";

/* =========================================================
   static/app.js の動作テスト（ブラウザで実行する）
   - app.js は app_test.js より先に読み込んでいるので、applySnapshot などがグローバルに見える
   - 待つ処理は setTimeout で 700ms（app.js の 600ms より少し長く）
   - 結果は #test-result に textContent で書く（成功なら "PASS 件数"、失敗なら "FAIL: …"）
   - innerHTML は使わない
   ========================================================= */
(function () {
  // 確認する席の色（static の cat-generic の頭の色）
  const GENERIC_CAT_HEAD_FILL = "#b3b9b7";
  // 待ち時間（app.js の ENTER_MS / LEAVE_MS は 600ms）
  const WAIT_MS = 700;

  const testCases = [];

  // テストを1件登録する（name は失敗時の表示用）
  function defineTest(name, testBody) {
    testCases.push({ name, testBody });
  }

  // ===== 確認用の小さな道具 =====

  // 条件が偽なら失敗にする
  function assertTrue(condition, message) {
    if (!condition) {
      throw new Error(message);
    }
  }

  // 値が一致しなければ失敗にする（期待値と実際の値を表示）
  function assertSame(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(`${message}（期待: ${JSON.stringify(expected)} / 実際: ${JSON.stringify(actual)}）`);
    }
  }

  // 指定ミリ秒待つ
  function waitMilliseconds(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  // agent_id の席を探す（無ければ null）
  function findSeat(agentId) {
    return document.querySelector(`.seat[data-agent-id="${agentId}"]`);
  }

  // 役割のデスクを探す
  function findDesk(role) {
    return document.querySelector(`.desk[data-role="${role}"]`);
  }

  // デスクにある不在の席の数
  function countAbsentSeats(desk) {
    return desk.querySelectorAll('.seat[data-state="absent"]').length;
  }

  // ログ（新しい順）の項目
  function findLogItems() {
    return Array.from(document.querySelectorAll("#activity-log > li"));
  }

  // 名札の項目（data-field）の文字
  function readNameplateField(seat, fieldName) {
    return seat.querySelector(`[data-field="${fieldName}"]`).textContent;
  }

  // キャラクターの頭の塗りの色
  function readCatHeadFill(seat) {
    return seat.querySelector("circle.cat-head").getAttribute("fill");
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

  // a. サーバー再起動で seq が戻っても反映される
  defineTest("a: サーバー再起動で seq が戻っても反映される", () => {
    resetScreen();
    applySnapshot({ seq: 500, agents: [] });
    applyEnter(makeEnterEvent("agent-a1", "coder", "sonnet", 501));
    assertTrue(findSeat("agent-a1") !== null, "seq 501 の enter で席ができていない");

    // サーバー再起動を想定して seq 1 の snapshot
    applySnapshot({ seq: 1, agents: [] });
    assertSame(lastSeq, 1, "snapshot 後の lastSeq");

    applyEnter(makeEnterEvent("agent-a2", "coder", "sonnet", 2));
    assertTrue(findSeat("agent-a2") !== null, "再起動後の seq 2 の enter が無視された");
  });

  // b. enter のあとの update は、モデルが変わったときだけログに出す
  defineTest("b: 同じモデルの update はログに出ず、変わったときだけ出る", () => {
    resetScreen();
    applyEnter(makeEnterEvent("agent-b1", "coder", "sonnet", 1));
    const logCountAfterEnter = findLogItems().length;
    assertSame(logCountAfterEnter, 1, "enter 後のログ件数");

    applyUpdate(makeUpdateEvent("agent-b1", "sonnet", 2));
    assertSame(findLogItems().length, logCountAfterEnter, "同じモデルの update でログが増えた");

    applyUpdate(makeUpdateEvent("agent-b1", "opus", 3));
    assertSame(findLogItems().length, logCountAfterEnter + 1, "モデルが変わった update のログ件数");
    assertSame(findLogItems()[0].dataset.kind, "update", "新しいログの data-kind");

    const seat = findSeat("agent-b1");
    assertSame(readNameplateField(seat, "model"), "opus", "名札の model");
    assertSame(seat.dataset.model, "opus", "席の data-model");
  });

  // c. 入室前の update（agent_type が null）は席もログも作らない
  defineTest("c: 入室前の update は席もログも作らない", () => {
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
    assertTrue(findSeat("agent-c1") === null, "入室前の update で席ができた");
    assertSame(findLogItems().length, 0, "入室前の update でログが増えた");
    assertSame(findDesk("coder").dataset.count, "0", "入室前の update で人数が増えた");
  });

  // d. seq が古い（lastSeq 以下）イベントは無視される
  defineTest("d: seq が古い（lastSeq 以下）イベントは無視される", () => {
    resetScreen();
    applySnapshot({ seq: 10, agents: [] });

    // 同じ seq の enter は無視
    applyEnter(makeEnterEvent("agent-d1", "coder", "sonnet", 10));
    assertTrue(findSeat("agent-d1") === null, "同じ seq の enter が処理された");

    // 新しい seq の enter は処理
    applyEnter(makeEnterEvent("agent-d1", "coder", "sonnet", 11));
    assertTrue(findSeat("agent-d1") !== null, "新しい seq の enter が処理されない");

    // 同じ seq / 古い seq の update は無視
    applyUpdate(makeUpdateEvent("agent-d1", "opus", 11));
    applyUpdate(makeUpdateEvent("agent-d1", "opus", 9));
    assertSame(readNameplateField(findSeat("agent-d1"), "model"), "sonnet", "古い seq の update が処理された");

    // 古い seq の leave は無視（席は残る）
    applyLeave(makeLeaveEvent("agent-d1", 10, "stop", "コーディング担当"));
    assertSame(findSeat("agent-d1").dataset.state, "entering", "古い seq の leave が処理された");
    assertSame(lastSeq, 11, "無視されたイベントで lastSeq が変わった");
  });

  // e. enter → entering、700ms 後に present。desk の人数が 1。不在の席が消える
  defineTest("e: enter で entering → 700ms 後に present。不在の席が消える", async () => {
    resetScreen();
    const researcherDesk = findDesk("researcher");
    assertSame(countAbsentSeats(researcherDesk), 1, "enter 前は不在の席が1つあるはず");

    applyEnter(makeEnterEvent("agent-e1", "researcher", "haiku", 1, "調査担当"));
    const seat = findSeat("agent-e1");
    assertSame(seat.dataset.state, "entering", "enter 直後の状態");
    assertSame(researcherDesk.dataset.count, "1", "enter 直後の data-count");
    assertSame(countAbsentSeats(researcherDesk), 0, "在席がいるのに不在の席が残っている");

    await waitMilliseconds(WAIT_MS);
    assertSame(seat.dataset.state, "present", "700ms 後の状態");
    assertSame(researcherDesk.dataset.count, "1", "700ms 後の data-count");
  });

  // f. leave → leaving、700ms 後に席が消え、デスクに不在の席が戻る。data-count は 0
  defineTest("f: leave で leaving → 700ms 後に席が消え、不在の席が戻る", async () => {
    resetScreen();
    const researcherDesk = findDesk("researcher");
    applyEnter(makeEnterEvent("agent-f1", "researcher", "haiku", 1, "調査担当"));
    await waitMilliseconds(WAIT_MS);

    const seat = findSeat("agent-f1");
    applyLeave(makeLeaveEvent("agent-f1", 2, "stop", "調査担当"));
    assertSame(seat.dataset.state, "leaving", "leave 直後の状態");
    assertSame(researcherDesk.dataset.count, "0", "leaving の席は人数に数えない");

    // 通常の退室（stop）はログに data-reason が付かない
    const leaveLogItem = findLogItems()[0];
    assertSame(leaveLogItem.dataset.kind, "leave", "退室のログ data-kind");
    assertSame(leaveLogItem.dataset.reason, undefined, "stop の退室に data-reason が付いた");

    await waitMilliseconds(WAIT_MS);
    assertTrue(!seat.isConnected, "700ms 後も席が画面に残っている");
    assertTrue(findSeat("agent-f1") === null, "700ms 後も agent-f1 の席が見える");
    assertSame(countAbsentSeats(researcherDesk), 1, "席が空いたのに不在の席が戻らない");
    assertSame(researcherDesk.dataset.count, "0", "700ms 後の data-count");
  });

  // f2. reason が timeout の退室はログに data-reason="timeout" が付く
  defineTest("f2: reason timeout の退室はログに data-reason=timeout が付く", async () => {
    resetScreen();
    applyEnter(makeEnterEvent("agent-f2", "coder", "sonnet", 1));
    applyLeave(makeLeaveEvent("agent-f2", 2, "timeout", "コーディング担当"));

    const newestLogItem = findLogItems()[0];
    assertSame(newestLogItem.dataset.kind, "leave", "退室のログ data-kind");
    assertSame(newestLogItem.dataset.reason, "timeout", "timeout の退室の data-reason");
    assertTrue(newestLogItem.textContent.includes("時間切れ"), "timeout のログの文字に「時間切れ」が無い");

    await waitMilliseconds(WAIT_MS);
    assertTrue(findSeat("agent-f2") === null, "timeout の退室で席が消えていない");
  });

  // g. 知らない agent_type は other デスクに入り、cat-generic の絵になる
  defineTest("g: 知らない agent_type は other デスクに入り cat-generic の絵になる", () => {
    resetScreen();
    applyEnter(makeEnterEvent("agent-g1", "Explore", "haiku", 1, "Explore"));
    const seat = findSeat("agent-g1");
    assertTrue(seat !== null, "知らない agent_type の席ができていない");
    assertSame(seat.closest(".desk").dataset.role, "other", "席が入ったデスク");
    assertSame(findDesk("other").dataset.count, "1", "other デスクの data-count");
    assertSame(readCatHeadFill(seat), GENERIC_CAT_HEAD_FILL, "cat-generic の絵の色");
    assertSame(seat.dataset.agentType, "Explore", "席の data-agent-type");
  });

  // h. agent_type に "../x" や "absent" が来ても cat-generic になる（cat-absent にならない）
  defineTest("h: agent_type に ../x や absent が来ても cat-generic になる", () => {
    resetScreen();
    const suspiciousAgentTypes = ["../x", "absent", "generic"];
    suspiciousAgentTypes.forEach((agentType, index) => {
      applyEnter(makeEnterEvent(`agent-h${index}`, agentType, "sonnet", index + 1));
    });

    suspiciousAgentTypes.forEach((agentType, index) => {
      const seat = findSeat(`agent-h${index}`);
      assertTrue(seat !== null, `agent_type "${agentType}" の席ができていない`);
      assertSame(seat.dataset.state, "entering", `agent_type "${agentType}" の状態（absent になっていないか）`);
      assertSame(readCatHeadFill(seat), GENERIC_CAT_HEAD_FILL, `agent_type "${agentType}" で cat-generic の絵になっていない`);
    });
  });

  // i. ログは最大50件（古いものから消える）
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

  // j. snapshot で全席が作り直され、在席者は present で置かれる
  defineTest("j: snapshot で全席が作り直され、在席者は present で置かれる", () => {
    resetScreen();
    // 入室中（entering）の席を作っておく
    applyEnter(makeEnterEvent("agent-j1", "researcher", "haiku", 1, "調査担当"));
    assertSame(findSeat("agent-j1").dataset.state, "entering", "snapshot 前の状態");

    applySnapshot({
      seq: 5,
      agents: [
        { agent_id: "agent-j2", agent_type: "coder", role_label: "コーディング担当", model: "opus", started_at: "2026-11-14T09:00:00" },
        { agent_id: "agent-j3", agent_type: "researcher", role_label: "調査担当", model: "sonnet", started_at: "2026-11-14T09:30:00" },
      ],
    });

    assertTrue(findSeat("agent-j1") === null, "snapshot で古い席が消えていない");
    const seatJ2 = findSeat("agent-j2");
    const seatJ3 = findSeat("agent-j3");
    assertTrue(seatJ2 !== null && seatJ3 !== null, "snapshot の在席者の席ができていない");
    assertSame(seatJ2.dataset.state, "present", "snapshot の席の状態（アニメなしで present）");
    assertSame(seatJ3.dataset.state, "present", "snapshot の席の状態（アニメなしで present）");
    assertSame(findDesk("coder").dataset.count, "1", "coder の data-count");
    assertSame(findDesk("researcher").dataset.count, "1", "researcher の data-count");
    assertSame(countAbsentSeats(findDesk("researcher")), 0, "在席がいるデスクに不在の席が残っている");
    assertSame(countAbsentSeats(findDesk("test-runner")), 1, "在席がいないデスクには不在の席があるはず");
  });

  // ===== 実行と結果の書き込み =====

  // 全テストを順に実行し、結果を #test-result に書く
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

  // 読み込みが終わってから実行する（defer の読み込みなので普通は DOMContentLoaded 前）
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runAllTests);
  } else {
    runAllTests();
  }
})();
