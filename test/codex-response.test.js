import assert from "node:assert/strict";
import test from "node:test";

import {
  extractThreadId,
  shouldRetryWithoutSession,
} from "../codex-response.js";

const THREAD_ID = "123e4567-e89b-12d3-a456-426614174000";

// codex exec --json が実際に流す JSONL（codex 0.154.0 で実測した並び）
const STDOUT_WITH_EVENTS = [
  `{"type":"thread.started","thread_id":"${THREAD_ID}"}`,
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"完了"}}',
  '{"type":"turn.completed","usage":{"input_tokens":66666,"cached_input_tokens":2000,"cache_write_input_tokens":0,"output_tokens":14,"reasoning_output_tokens":4}}',
].join("\n");

test("最初のthread.startedから会話IDを取り出す", () => {
  assert.equal(extractThreadId(STDOUT_WITH_EVENTS), THREAD_ID);
});

test("会話IDが無ければnullにする", () => {
  assert.equal(extractThreadId('{"type":"item.completed"}'), null);
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
