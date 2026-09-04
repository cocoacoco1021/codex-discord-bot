import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionLifecycle,
  SessionLifecycleError,
} from "../session-lifecycle.js";

const OLD_THREAD_ID = "01a06d09-b18c-7f23-825a-58a984a2865c";
const NEW_THREAD_ID = "01a06d09-b18c-7f23-825a-58a984a28660";
const POLICY = {
  maxRequests: 20,
  maxContextTokens: 80_000,
  maxHandoffChars: 3_000,
};
const BASE_STATE = {
  threadId: OLD_THREAD_ID,
  requestCount: 3,
  contextTokens: 10_000,
  handoffSummary: null,
  rotationPending: false,
};

/**
 * 役割: 呼出履歴・保存履歴・要約の保管履歴を観測できるセッション管理を作る。
 * 入力: 初期状態、Codex代替関数、差し替えたい設定。
 * 出力: 管理と各種履歴。
 */
function createLifecycle(initialState, invokeCodex, overrides = {}) {
  const invocations = [];
  const persistedStates = [];
  const archivedSummaries = [];
  const lifecycle = new SessionLifecycle({
    initialState,
    policy: POLICY,
    persistState: (sessionState) => persistedStates.push({ ...sessionState }),
    invokeCodex: async (invocation) => {
      invocations.push(invocation);
      return invokeCodex(invocation, invocations.length);
    },
    shouldRetryWithoutSession: () => false,
    archiveHandoff: (summary) => {
      archivedSummaries.push(summary);
      return `/tmp/handoffs/handoff-${archivedSummaries.length}.md`;
    },
    ...overrides,
  });
  return { lifecycle, invocations, persistedStates, archivedSummaries };
}

test("通常依頼は同じ会話を継続し会話数と文脈量を保存する", async () => {
  const { lifecycle, invocations, persistedStates } = createLifecycle(
    BASE_STATE,
    async () => ({
      threadId: OLD_THREAD_ID,
      text: "回答",
      contextTokens: 12_345,
    }),
  );

  const response = await lifecycle.runOwnerPrompt("続けて", []);

  assert.equal(response.text, "回答");
  assert.deepEqual(response.rotation, { rotated: false });
  assert.equal(invocations[0].threadId, OLD_THREAD_ID);
  assert.deepEqual(persistedStates.at(-1), {
    ...BASE_STATE,
    requestCount: 4,
    contextTokens: 12_345,
  });
});

test("会話数到達時は旧会話を要約し新会話へ要約だけを渡す", async () => {
  const { lifecycle, invocations, archivedSummaries } = createLifecycle(
    { ...BASE_STATE, requestCount: 20 },
    async (_invocation, callNumber) =>
      callNumber === 1
        ? {
            threadId: OLD_THREAD_ID,
            text: "決定事項だけの引き継ぎ",
            contextTokens: 79_000,
          }
        : {
            threadId: NEW_THREAD_ID,
            text: "新しい会話の回答",
            contextTokens: 2_000,
          },
  );

  const response = await lifecycle.runOwnerPrompt("次の仕事", []);

  assert.equal(response.rotation.rotated, true);
  assert.equal(invocations[0].threadId, OLD_THREAD_ID);
  assert.match(invocations[0].prompt, /新しいCodexセッションへ引き継ぐ/);
  assert.equal(invocations[1].threadId, null);
  assert.match(invocations[1].prompt, /決定事項だけの引き継ぎ/);
  assert.match(invocations[1].prompt, /次の仕事/);
  // 要約は過去ログとして保管される（消さずに残す）
  assert.deepEqual(archivedSummaries, ["決定事項だけの引き継ぎ"]);
  assert.deepEqual(lifecycle.getState(), {
    threadId: NEW_THREAD_ID,
    requestCount: 1,
    contextTokens: 2_000,
    handoffSummary: null,
    rotationPending: false,
  });
});

test("自動更新の開始を持ち主へ知らせるフックを呼ぶ", async () => {
  const { lifecycle } = createLifecycle(
    { ...BASE_STATE, requestCount: 20 },
    async (_invocation, callNumber) =>
      callNumber === 1
        ? { threadId: OLD_THREAD_ID, text: "要約", contextTokens: 79_000 }
        : { threadId: NEW_THREAD_ID, text: "回答", contextTokens: 2_000 },
  );
  const announced = [];

  await lifecycle.runOwnerPrompt("次の仕事", [], {
    onRotationStart: (reason) => announced.push(reason),
  });

  assert.deepEqual(announced, ["ご依頼が20件になりました"]);
});

test("手動更新は要約を保管し次の依頼まで新会話IDを持たない", async () => {
  const { lifecycle, archivedSummaries } = createLifecycle(
    BASE_STATE,
    async () => ({
      threadId: OLD_THREAD_ID,
      text: "  引き継ぎ要約  ",
      contextTokens: 20_000,
    }),
  );

  const result = await lifecycle.rotateWithHandoff();

  assert.equal(result.rotated, true);
  assert.equal(result.summaryLength, "引き継ぎ要約".length);
  assert.equal(result.archivedPath, "/tmp/handoffs/handoff-1.md");
  assert.deepEqual(archivedSummaries, ["引き継ぎ要約"]);
  assert.deepEqual(lifecycle.getState(), {
    threadId: null,
    requestCount: 0,
    contextTokens: 0,
    handoffSummary: "引き継ぎ要約",
    rotationPending: false,
  });
});

test("要約の保管に失敗しても更新自体は続ける", async () => {
  const { lifecycle } = createLifecycle(
    BASE_STATE,
    async () => ({
      threadId: OLD_THREAD_ID,
      text: "引き継ぎ要約",
      contextTokens: 20_000,
    }),
    {
      archiveHandoff: () => {
        throw new Error("保管先に書けません");
      },
    },
  );

  const result = await lifecycle.rotateWithHandoff();

  assert.equal(result.rotated, true);
  assert.equal(result.archivedPath, null);
  assert.equal(lifecycle.getState().handoffSummary, "引き継ぎ要約");
});

test("要約に失敗した場合は旧会話を維持する", async () => {
  const { lifecycle, persistedStates } = createLifecycle(
    BASE_STATE,
    async () => {
      throw new Error("利用上限");
    },
  );

  await assert.rejects(lifecycle.rotateWithHandoff(), SessionLifecycleError);
  assert.deepEqual(lifecycle.getState(), BASE_STATE);
  assert.equal(persistedStates.length, 0);
});

test("自動更新に失敗しても依頼そのものは通す", async () => {
  const { lifecycle, invocations } = createLifecycle(
    { ...BASE_STATE, requestCount: 20 },
    async (_invocation, callNumber) => {
      if (callNumber === 1) throw new Error("利用上限");
      return { threadId: OLD_THREAD_ID, text: "回答", contextTokens: 81_000 };
    },
  );

  const response = await lifecycle.runOwnerPrompt("今日の予定は？", []);

  assert.equal(response.text, "回答");
  assert.equal(response.rotation.rotated, false);
  assert.ok(response.rotation.error instanceof SessionLifecycleError);
  // 会話は元のまま続いている
  assert.equal(invocations[1].threadId, OLD_THREAD_ID);
  assert.equal(lifecycle.getState().threadId, OLD_THREAD_ID);
  assert.equal(lifecycle.getState().requestCount, 21);
});

test("自動更新に失敗した直後は既定件数だけ再挑戦を控える", async () => {
  let failSummary = true;
  const { lifecycle, invocations } = createLifecycle(
    { ...BASE_STATE, requestCount: 20 },
    async (invocation) => {
      if (/新しいCodexセッションへ引き継ぐ/.test(invocation.prompt)) {
        if (failSummary) throw new Error("利用上限");
        return { threadId: OLD_THREAD_ID, text: "要約", contextTokens: 100 };
      }
      return { threadId: OLD_THREAD_ID, text: "回答", contextTokens: 81_000 };
    },
  );

  await lifecycle.runOwnerPrompt("1件目", []); // 要約に失敗 → 26件目まで控える
  const summaryAttempts = () =>
    invocations.filter((invocation) =>
      /新しいCodexセッションへ引き継ぐ/.test(invocation.prompt),
    ).length;
  assert.equal(summaryAttempts(), 1);

  // 21〜24件目は要約を試さない（失敗の連発で待たされない）
  for (let i = 0; i < 4; i += 1) {
    const response = await lifecycle.runOwnerPrompt(`控え${i}`, []);
    assert.equal(response.text, "回答");
  }
  assert.equal(summaryAttempts(), 1);
  assert.equal(lifecycle.getState().requestCount, 25);

  // 5件先の25件目に達したら再挑戦する
  failSummary = false;
  await lifecycle.runOwnerPrompt("再挑戦", []);
  assert.equal(summaryAttempts(), 2);
});

test("fresh更新は要約せず統計と会話IDを外す", () => {
  const { lifecycle } = createLifecycle(BASE_STATE, async () => {
    throw new Error("呼ばれない");
  });

  lifecycle.rotateFresh();

  assert.deepEqual(lifecycle.getState(), {
    threadId: null,
    requestCount: 0,
    contextTokens: 0,
    handoffSummary: null,
    rotationPending: false,
  });
});

test("不正な旧会話IDだけを外して同じ依頼を一度再試行する", async () => {
  const invalidSessionError = new Error("invalid session");
  const invocations = [];
  const persistedStates = [];
  let invocationCount = 0;
  const lifecycle = new SessionLifecycle({
    initialState: BASE_STATE,
    policy: POLICY,
    persistState: (sessionState) => persistedStates.push({ ...sessionState }),
    invokeCodex: async (invocation) => {
      invocations.push(invocation);
      invocationCount += 1;
      if (invocationCount === 1) throw invalidSessionError;
      return {
        threadId: NEW_THREAD_ID,
        text: "再試行成功",
        contextTokens: 1_000,
      };
    },
    shouldRetryWithoutSession: (error) => error === invalidSessionError,
  });

  const response = await lifecycle.runOwnerPrompt("同じ依頼", []);

  assert.equal(response.text, "再試行成功");
  assert.equal(invocations[0].threadId, OLD_THREAD_ID);
  assert.equal(invocations[1].threadId, null);
  assert.equal(persistedStates.at(-1).threadId, NEW_THREAD_ID);
});
