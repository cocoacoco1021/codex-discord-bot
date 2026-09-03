import { existsSync, readFileSync, writeFileSync } from "node:fs";

const CODEX_CONVERSATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_STATE_VERSION = 2;

export const EMPTY_SESSION_STATE = Object.freeze({
  threadId: null,
  requestCount: 0,
  contextTokens: 0,
  handoffSummary: null,
  rotationPending: false,
});

export class ConversationStoreError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "ConversationStoreError";
  }
}

/**
 * 役割: 保存済みのCodex会話状態を読み込む。
 * 入力: 保存ファイルのパスまたはURL。
 * 出力: 検証済み状態。未作成なら空状態、旧形式は会話IDを引き継いだ空状態。
 */
export function loadSessionState(filePath) {
  if (!existsSync(filePath)) return { ...EMPTY_SESSION_STATE };

  try {
    const savedSession = JSON.parse(readFileSync(filePath, "utf8"));

    // 旧形式({conversationId})は会話数・文脈量を持たないため、会話IDだけ引き継ぐ。
    // 稼働中の会話を驚かせないよう、強制的な要約更新は行わない(rotationPendingは立てない)。
    if (savedSession.version !== SESSION_STATE_VERSION) {
      const legacyThreadId = savedSession.conversationId ?? null;
      validateThreadId(legacyThreadId);
      return {
        ...EMPTY_SESSION_STATE,
        threadId: legacyThreadId,
      };
    }

    const sessionState = {
      threadId: savedSession.threadId,
      requestCount: savedSession.requestCount,
      contextTokens: savedSession.contextTokens,
      handoffSummary: savedSession.handoffSummary,
      rotationPending: savedSession.rotationPending,
    };
    validateSessionState(sessionState);
    return sessionState;
  } catch (error) {
    throw new ConversationStoreError("Codex会話状態の読み込みに失敗しました", error);
  }
}

/**
 * 役割: Codex会話状態を再起動後も使えるよう保存する。
 * 入力: 保存ファイルのパスまたはURL、検証対象の状態。
 * 出力: なし。保存失敗時はConversationStoreErrorを送出する。
 */
export function saveSessionState(filePath, sessionState) {
  try {
    validateSessionState(sessionState);
    writeFileSync(
      filePath,
      `${JSON.stringify(
        { version: SESSION_STATE_VERSION, ...sessionState },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch (error) {
    throw new ConversationStoreError("Codex会話状態の保存に失敗しました", error);
  }
}

/**
 * 役割: 旧API互換で会話IDだけを読み込む。
 * 入力: 保存ファイルのパスまたはURL。出力: 会話IDまたはnull。
 */
export function loadConversationId(filePath) {
  return loadSessionState(filePath).threadId;
}

/**
 * 役割: 旧API互換で会話IDだけを初期状態として保存する。
 * 入力: 保存先と会話ID。出力なし。
 */
export function saveConversationId(filePath, conversationId) {
  saveSessionState(filePath, { ...EMPTY_SESSION_STATE, threadId: conversationId });
}

/** 入力: 会話ID / 出力なし。形式が不正なら例外にする。 */
function validateThreadId(threadId) {
  if (threadId === null) return;
  if (
    typeof threadId !== "string" ||
    !CODEX_CONVERSATION_ID_PATTERN.test(threadId)
  ) {
    throw new Error("threadIdの形式が不正です");
  }
}

/** 入力: 会話状態 / 出力なし。永続化できない値なら例外にする。 */
function validateSessionState(sessionState) {
  if (!sessionState || typeof sessionState !== "object") {
    throw new Error("会話状態がオブジェクトではありません");
  }
  validateThreadId(sessionState.threadId);
  validateNonNegativeInteger(sessionState.requestCount, "requestCount");
  validateNonNegativeInteger(sessionState.contextTokens, "contextTokens");
  if (
    sessionState.handoffSummary !== null &&
    typeof sessionState.handoffSummary !== "string"
  ) {
    throw new Error("handoffSummaryの形式が不正です");
  }
  if (typeof sessionState.rotationPending !== "boolean") {
    throw new Error("rotationPendingの形式が不正です");
  }
}

/** 入力: 数値・項目名 / 出力なし。非負整数でなければ例外にする。 */
function validateNonNegativeInteger(numericValue, label) {
  if (!Number.isSafeInteger(numericValue) || numericValue < 0) {
    throw new Error(`${label}は0以上の整数で指定してください`);
  }
}
