import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConversationStoreError,
  EMPTY_SESSION_STATE,
  loadConversationId,
  loadSessionState,
  saveConversationId,
  saveSessionState,
} from "../conversation-store.js";

const CONVERSATION_ID = "123e4567-e89b-12d3-a456-426614174000";

/**
 * 役割: テスト専用ディレクトリを作り、終了後に片付ける。
 * 入力: 一時ディレクトリのパスを受け取るテスト処理。
 * 出力: なし。テスト処理の例外はそのまま送出する。
 */
function withTemporaryDirectory(runTest) {
  const directoryPath = mkdtempSync(join(tmpdir(), "codex-discord-test-"));
  try {
    runTest(directoryPath);
  } finally {
    rmSync(directoryPath, { recursive: true, force: true });
  }
}

test("保存した会話IDを再読込できる", () => {
  withTemporaryDirectory((directoryPath) => {
    const filePath = join(directoryPath, "conversation.json");

    saveConversationId(filePath, CONVERSATION_ID);

    assert.equal(loadConversationId(filePath), CONVERSATION_ID);
  });
});

test("保存ファイルが未作成なら会話IDなしとして扱う", () => {
  withTemporaryDirectory((directoryPath) => {
    const filePath = join(directoryPath, "conversation.json");

    assert.equal(loadConversationId(filePath), null);
  });
});

test("会話IDをnullにすると次回起動時は新規会話になる", () => {
  withTemporaryDirectory((directoryPath) => {
    const filePath = join(directoryPath, "conversation.json");
    saveConversationId(filePath, CONVERSATION_ID);

    saveConversationId(filePath, null);

    assert.equal(loadConversationId(filePath), null);
  });
});

test("壊れた保存ファイルは明示的なエラーにする", () => {
  withTemporaryDirectory((directoryPath) => {
    const filePath = join(directoryPath, "conversation.json");
    writeFileSync(filePath, "not-json", "utf8");

    assert.throws(
      () => loadConversationId(filePath),
      ConversationStoreError,
    );
  });
});

test("不正な会話IDは保存しない", () => {
  withTemporaryDirectory((directoryPath) => {
    const filePath = join(directoryPath, "conversation.json");

    assert.throws(
      () => saveConversationId(filePath, "invalid-id"),
      ConversationStoreError,
    );
    assert.throws(() => readFileSync(filePath, "utf8"));
  });
});

test("会話数・文脈量・引き継ぎ要約をまとめて保存できる", () => {
  withTemporaryDirectory((directoryPath) => {
    const filePath = join(directoryPath, "conversation.json");
    const sessionState = {
      threadId: CONVERSATION_ID,
      requestCount: 12,
      contextTokens: 45678,
      handoffSummary: "決定事項だけの要約",
      rotationPending: false,
    };

    saveSessionState(filePath, sessionState);

    assert.deepEqual(loadSessionState(filePath), sessionState);
  });
});

test("旧形式の会話IDは会話数を初期化しつつ会話を継続する", () => {
  withTemporaryDirectory((directoryPath) => {
    const filePath = join(directoryPath, "conversation.json");
    // 旧bot.jsが書いた {conversationId} 形式（versionなし）
    writeFileSync(
      filePath,
      JSON.stringify({ conversationId: CONVERSATION_ID }),
      "utf8",
    );

    assert.deepEqual(loadSessionState(filePath), {
      ...EMPTY_SESSION_STATE,
      threadId: CONVERSATION_ID,
    });
  });
});

test("保存ファイルが未作成なら空状態として扱う", () => {
  withTemporaryDirectory((directoryPath) => {
    const filePath = join(directoryPath, "conversation.json");

    assert.deepEqual(loadSessionState(filePath), { ...EMPTY_SESSION_STATE });
  });
});

test("負の会話数や文字列の文脈量は保存しない", () => {
  withTemporaryDirectory((directoryPath) => {
    const filePath = join(directoryPath, "conversation.json");

    assert.throws(
      () =>
        saveSessionState(filePath, {
          ...EMPTY_SESSION_STATE,
          requestCount: -1,
        }),
      ConversationStoreError,
    );
    assert.throws(
      () =>
        saveSessionState(filePath, {
          ...EMPTY_SESSION_STATE,
          contextTokens: "80000",
        }),
      ConversationStoreError,
    );
  });
});
