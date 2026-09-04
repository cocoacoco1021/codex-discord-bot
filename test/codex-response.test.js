import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateContextTokens,
  extractThreadId,
  shouldRetryWithoutSession,
} from "../codex-response.js";

const THREAD_ID = "123e4567-e89b-12d3-a456-426614174000";

// codex exec --json が流す JSONL の代表例（1行1イベント）
const STDOUT_WITH_EVENTS = [
  `{"type":"thread.started","thread_id":"${THREAD_ID}"}`,
  '{"type":"token_count","info":{"total_token_usage":{"total_tokens":900000},"last_token_usage":{"input_tokens":50000,"cached_input_tokens":40000,"output_tokens":120},"model_context_window":258400}}',
  '{"type":"token_count","info":{"last_token_usage":{"input_tokens":120000,"cached_input_tokens":110000,"output_tokens":80}}}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"完了"}}',
].join("\n");

test("最初のthread.startedから会話IDを取り出す", () => {
  assert.equal(extractThreadId(STDOUT_WITH_EVENTS), THREAD_ID);
});

test("会話IDが無ければnullにする", () => {
  assert.equal(extractThreadId('{"type":"item.completed"}'), null);
});

test("last_token_usageのinput_tokensの最大値を文脈量にする", () => {
  assert.equal(estimateContextTokens(STDOUT_WITH_EVENTS), 120000);
});

test("トークン情報が無ければ文脈量を0に縮退させる", () => {
  assert.equal(estimateContextTokens('{"type":"item.completed"}'), 0);
});

test("スレッドが見つからない場合だけ新規で再試行する", () => {
  assert.equal(shouldRetryWithoutSession(new Error("thread not found")), true);
  assert.equal(
    shouldRetryWithoutSession(new Error("conversation does not exist")),
    true,
  );
  assert.equal(shouldRetryWithoutSession(new Error("Session expired")), true);
});

test("一時的な失敗では会話の記憶を捨てない", () => {
  // 利用上限・通信断・タイムアウトで新しい会話を始めてしまうと文脈が消える
  assert.equal(
    shouldRetryWithoutSession(new Error("weekly usage limit reached")),
    false,
  );
  assert.equal(shouldRetryWithoutSession(new Error("fetch failed")), false);
  assert.equal(
    shouldRetryWithoutSession(
      new Error("タイムアウト(3600000ms)により中断しました"),
    ),
    false,
  );
});
