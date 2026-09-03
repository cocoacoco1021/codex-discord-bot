import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHandoffSummaryPrompt,
  buildPromptWithHandoff,
  loadSessionPolicy,
  normalizeHandoffSummary,
  parseSessionCommand,
  SessionPolicyError,
  shouldRotateSession,
} from "../session-policy.js";

const POLICY = {
  maxRequests: 20,
  maxContextTokens: 200_000,
  maxHandoffChars: 3_000,
};

test("推奨する会話数・容量・要約長を既定値にする", () => {
  assert.deepEqual(loadSessionPolicy({}), POLICY);
});

test("セッション閾値は環境変数で変更できる", () => {
  assert.deepEqual(
    loadSessionPolicy({
      CODEX_SESSION_MAX_REQUESTS: "10",
      CODEX_SESSION_MAX_CONTEXT_TOKENS: "50000",
      CODEX_HANDOFF_MAX_CHARS: "2000",
    }),
    { maxRequests: 10, maxContextTokens: 50_000, maxHandoffChars: 2_000 },
  );
});

test("0・小数・文字列の閾値を拒否する", () => {
  assert.throws(
    () => loadSessionPolicy({ CODEX_SESSION_MAX_REQUESTS: "0" }),
    SessionPolicyError,
  );
  assert.throws(
    () => loadSessionPolicy({ CODEX_SESSION_MAX_CONTEXT_TOKENS: "1.5" }),
    SessionPolicyError,
  );
  assert.throws(
    () => loadSessionPolicy({ CODEX_HANDOFF_MAX_CHARS: "長い" }),
    SessionPolicyError,
  );
});

test("新規会話コマンドだけを通常依頼から分離する", () => {
  assert.equal(parseSessionCommand(" !NEW "), "handoff");
  assert.equal(parseSessionCommand("!new fresh"), "fresh");
  assert.equal(parseSessionCommand("!new の使い方"), null);
  assert.equal(parseSessionCommand("通常の依頼"), null);
});

test("会話数・容量・旧形式移行のいずれかで更新する", () => {
  const baseState = {
    requestCount: 19,
    contextTokens: 199_999,
    rotationPending: false,
  };

  assert.equal(shouldRotateSession(baseState, POLICY), false);
  assert.equal(
    shouldRotateSession({ ...baseState, requestCount: 20 }, POLICY),
    true,
  );
  assert.equal(
    shouldRotateSession({ ...baseState, contextTokens: 200_000 }, POLICY),
    true,
  );
  assert.equal(
    shouldRotateSession({ ...baseState, rotationPending: true }, POLICY),
    true,
  );
});

test("引き継ぎ指示は秘密を除外し最大文字数を明示する", () => {
  const handoffPrompt = buildHandoffSummaryPrompt(3_000);

  assert.match(handoffPrompt, /新しいCodexセッションへ引き継ぐ/);
  assert.match(handoffPrompt, /3000文字以内/);
  assert.match(handoffPrompt, /APIキー/);
  assert.match(handoffPrompt, /含めない/);
});

test("要約は前後空白を除き最大文字数へ収める", () => {
  assert.equal(normalizeHandoffSummary("  abcdef  ", 4), "abcd");
});

test("新セッションには引き継ぎ要約と現在の依頼だけを渡す", () => {
  const prompt = buildPromptWithHandoff("続きを実装して", "仕様はAに決定");

  assert.match(prompt, /<handoff>\n仕様はAに決定\n<\/handoff>/);
  assert.match(prompt, /持ち主の現在の依頼:\n続きを実装して/);
  assert.equal(buildPromptWithHandoff("通常依頼", null), "通常依頼");
});
