import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  extractLastContextTokens,
  findRolloutPath,
  readContextTokens,
  resolveCodexHome,
} from "../codex-context.js";

const THREAD_ID = "01a08a91-6bae-7502-96bb-2522368f3de8";

// codex が実際に残すセッションログの行（codex 0.154.0 で実測した形）
const tokenCountLine = (lastInput, totalInput) =>
  JSON.stringify({
    timestamp: "2026-09-10T09:06:27.794Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: totalInput, total_tokens: totalInput },
        last_token_usage: {
          input_tokens: lastInput,
          cached_input_tokens: 1000,
          output_tokens: 7,
        },
        model_context_window: 258400,
      },
    },
  });

/** 入力: 会話ID・トークン記録の並び / 出力: 使い捨てのcodexホーム。 */
function createCodexHome(lines) {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-context-test-"));
  const dayDirectory = join(codexHome, "sessions", "2026", "09", "10");
  mkdirSync(dayDirectory, { recursive: true });
  writeFileSync(
    join(dayDirectory, `rollout-2026-09-10T18-06-21-${THREAD_ID}.jsonl`),
    `${lines.join("\n")}\n`,
  );
  return codexHome;
}

test("最後のlast_token_usageを文脈量にする（累計値は使わない）", () => {
  const tailText = [
    "",
    tokenCountLine(12345, 12345),
    tokenCountLine(54321, 66666),
  ].join("\n");

  assert.equal(extractLastContextTokens(tailText), 54321);
});

test("token_usage_recordの1レスポンス分も読める", () => {
  const tailText = [
    "",
    JSON.stringify({
      type: "token_usage_record",
      payload: {
        thread_id: THREAD_ID,
        usage: { input_tokens: 98765, cached_input_tokens: 1000 },
        turn_token_usage: { input_tokens: 98765 },
      },
    }),
  ].join("\n");

  assert.equal(extractLastContextTokens(tailText), 98765);
});

test("読み始めが行の途中でも壊れず、トークン記録が無ければ0にする", () => {
  assert.equal(extractLastContextTokens('_tokens":999}}}\n{"type":"turn"}'), 0);
  assert.equal(extractLastContextTokens(""), 0);
});

test("会話IDからセッションログを見つけて文脈量を読む", () => {
  const codexHome = createCodexHome([
    tokenCountLine(12345, 12345),
    tokenCountLine(136053, 13546819),
  ]);
  try {
    assert.match(findRolloutPath(THREAD_ID, codexHome), /rollout-.*\.jsonl$/);
    assert.equal(readContextTokens(THREAD_ID, { codexHome }), 136053);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("会話IDが無い・ログが無い場合は0に縮退させる", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-context-empty-"));
  try {
    assert.equal(readContextTokens(null, { codexHome }), 0);
    assert.equal(readContextTokens(THREAD_ID, { codexHome }), 0);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("CODEX_HOMEがあればそちらを見る", () => {
  assert.equal(resolveCodexHome({ CODEX_HOME: "/tmp/codex-home" }), "/tmp/codex-home");
  assert.match(resolveCodexHome({}), /\.codex$/);
});
