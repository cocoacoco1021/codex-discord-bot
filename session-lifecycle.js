import {
  buildHandoffSummaryPrompt,
  buildPromptWithHandoff,
  normalizeHandoffSummary,
  shouldRotateSession,
} from "./session-policy.js";

export class SessionLifecycleError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "SessionLifecycleError";
  }
}

/**
 * 役割: Discordの依頼とCodexセッションの更新・引き継ぎを管理する。
 * 入力: 初期状態、閾値、永続化・Codex呼出・再試行判定関数。
 * 出力: セッション管理サービス。
 */
export class SessionLifecycle {
  constructor({
    initialState,
    policy,
    persistState,
    invokeCodex,
    shouldRetryWithoutSession,
  }) {
    this.sessionState = { ...initialState };
    this.policy = policy;
    this.persistState = persistState;
    this.invokeCodex = invokeCodex;
    this.shouldRetryWithoutSession = shouldRetryWithoutSession;
  }

  /** 入力なし / 出力：外部から変更できないセッション状態のコピー。 */
  getState() {
    return { ...this.sessionState };
  }

  /**
   * 役割: 通常依頼の前に必要なら要約更新し、応答後の利用量を保存する。
   * 入力: 持ち主の本文と画像パス。出力: 応答本文と自動更新の有無。
   */
  async runOwnerPrompt(prompt, imagePaths = []) {
    const rotated = await this.rotateIfNeeded();
    const promptWithHandoff = buildPromptWithHandoff(
      prompt,
      this.sessionState.handoffSummary,
    );
    const codexResult = await this.invokeWithInvalidSessionRecovery(
      promptWithHandoff,
      imagePaths,
    );
    const nextThreadId = codexResult.threadId ?? this.sessionState.threadId;

    this.commitState({
      threadId: nextThreadId,
      requestCount: this.sessionState.requestCount + 1,
      contextTokens: normalizeContextTokens(codexResult.contextTokens),
      // 新しい会話IDへ要約を渡せた時点で、保存側からは取り除く。
      handoffSummary: nextThreadId ? null : this.sessionState.handoffSummary,
      rotationPending: false,
    });

    return { text: codexResult.text, rotated };
  }

  /**
   * 役割: 旧会話を要約して次回だけ使う状態へ切り替える。
   * 入力なし。出力: 実際に旧会話を更新した場合true。
   */
  async rotateWithHandoff() {
    if (!this.sessionState.threadId) {
      if (this.sessionState.rotationPending) {
        this.commitState({ ...this.sessionState, rotationPending: false });
      }
      return false;
    }

    let codexResult;
    try {
      codexResult = await this.invokeCodex({
        prompt: buildHandoffSummaryPrompt(this.policy.maxHandoffChars),
        threadId: this.sessionState.threadId,
        imagePaths: [],
      });
    } catch (error) {
      throw new SessionLifecycleError(
        "引き継ぎ要約を作れなかったため、現在のセッションを維持しました",
        error,
      );
    }

    const handoffSummary = normalizeHandoffSummary(
      codexResult.text,
      this.policy.maxHandoffChars,
    );
    if (!handoffSummary) {
      throw new SessionLifecycleError(
        "引き継ぎ要約が空だったため、現在のセッションを維持しました",
      );
    }

    this.commitState({
      threadId: null,
      requestCount: 0,
      contextTokens: 0,
      handoffSummary,
      rotationPending: false,
    });
    return true;
  }

  /**
   * 役割: 要約せず新しい会話へ切り替える。
   * 入力なし。出力なし。
   */
  rotateFresh() {
    this.commitState({
      threadId: null,
      requestCount: 0,
      contextTokens: 0,
      handoffSummary: null,
      rotationPending: false,
    });
  }

  /** 閾値到達時だけ要約更新する。入力なし / 出力：更新した場合true。 */
  async rotateIfNeeded() {
    if (!shouldRotateSession(this.sessionState, this.policy)) return false;
    return this.rotateWithHandoff();
  }

  /**
   * セッション不整合時だけ旧IDを外して一度再試行する。
   * 入力: Codex本文と画像パス。出力: Codex応答。
   */
  async invokeWithInvalidSessionRecovery(prompt, imagePaths) {
    try {
      return await this.invokeCodex({
        prompt,
        threadId: this.sessionState.threadId,
        imagePaths,
      });
    } catch (error) {
      if (
        !this.sessionState.threadId ||
        !this.shouldRetryWithoutSession(error)
      ) {
        throw error;
      }

      this.commitState({
        ...this.sessionState,
        threadId: null,
        requestCount: 0,
        contextTokens: 0,
        rotationPending: false,
      });
      return this.invokeCodex({ prompt, threadId: null, imagePaths });
    }
  }

  /** 永続化に成功した状態だけをメモリへ反映する。 */
  commitState(nextState) {
    this.persistState(nextState);
    this.sessionState = { ...nextState };
  }
}

/** 利用量欠落や小数を安全な非負整数へ整える。 */
function normalizeContextTokens(contextTokens) {
  const numericTokens = Number(contextTokens);
  if (!Number.isFinite(numericTokens) || numericTokens < 0) return 0;
  return Math.round(numericTokens);
}
