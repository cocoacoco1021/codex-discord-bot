import {
  buildHandoffSummaryPrompt,
  buildPromptWithHandoff,
  describeRotationReason,
  normalizeHandoffSummary,
  shouldRotateSession,
} from "./session-policy.js";

// 自動更新に失敗したあと、次に再挑戦するまで空ける依頼件数。
// 失敗が続いても毎回要約を試して待たされることがないようにする。
export const DEFAULT_ROTATION_RETRY_GAP_REQUESTS = 5;

export class SessionLifecycleError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "SessionLifecycleError";
  }
}

/**
 * 役割: Discordの依頼とCodexセッションの更新・引き継ぎを管理する。
 * 入力: 初期状態、閾値、永続化・Codex呼出・再試行判定・要約保管の各関数。
 * 出力: セッション管理サービス。
 */
export class SessionLifecycle {
  constructor({
    initialState,
    policy,
    persistState,
    invokeCodex,
    shouldRetryWithoutSession,
    archiveHandoff = null,
    rotationRetryGapRequests = DEFAULT_ROTATION_RETRY_GAP_REQUESTS,
  }) {
    this.sessionState = { ...initialState };
    this.policy = policy;
    this.persistState = persistState;
    this.invokeCodex = invokeCodex;
    this.shouldRetryWithoutSession = shouldRetryWithoutSession;
    this.archiveHandoff = archiveHandoff;
    this.rotationRetryGapRequests = rotationRetryGapRequests;
    // 自動更新の再挑戦を控える件数。メモリ上だけで持つ（再起動すれば再挑戦する）。
    this.rotationBlockedUntilRequestCount = 0;
  }

  /** 入力なし / 出力：外部から変更できないセッション状態のコピー。 */
  getState() {
    return { ...this.sessionState };
  }

  /**
   * 役割: 通常依頼の前に必要なら要約更新し、応答後の利用量を保存する。
   * 入力: 持ち主の本文、画像パス、更新開始を知らせるフック。
   * 出力: 応答本文と自動更新の結果。
   * 重要: 自動更新に失敗しても依頼そのものは止めない（今の会話のまま続ける）。
   */
  async runOwnerPrompt(prompt, imagePaths = [], { onRotationStart } = {}) {
    const rotation = await this.rotateIfNeeded({ onRotationStart });
    const promptWithHandoff = buildPromptWithHandoff(
      prompt,
      this.sessionState.handoffSummary,
    );
    const codexResult = await this.invokeWithInvalidSessionRecovery(
      promptWithHandoff,
      imagePaths,
    );
    const nextSessionId = codexResult.threadId ?? this.sessionState.threadId;

    this.commitState({
      threadId: nextSessionId,
      requestCount: this.sessionState.requestCount + 1,
      contextTokens: normalizeContextTokens(codexResult.contextTokens),
      // 新しい会話IDへ要約を渡せた時点で、保存側からは取り除く。
      handoffSummary: nextSessionId ? null : this.sessionState.handoffSummary,
      rotationPending: false,
    });

    return { text: codexResult.text, rotation };
  }

  /**
   * 役割: 旧会話を要約して次回だけ使う状態へ切り替える。
   * 入力なし。出力: 更新の可否・要約の長さ・保管先。
   * 失敗時はSessionLifecycleErrorを送出し、今の会話はそのまま維持する。
   */
  async rotateWithHandoff() {
    if (!this.sessionState.threadId) {
      if (this.sessionState.rotationPending) {
        this.commitState({ ...this.sessionState, rotationPending: false });
      }
      return { rotated: false };
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
    if (!handoffSummary || handoffSummary === "(空の応答)") {
      throw new SessionLifecycleError(
        "引き継ぎ要約が空だったため、現在のセッションを維持しました",
      );
    }

    // 要約は過去ログとして必ず残す（古い要約は上書きも削除もしない）。
    // 保管に失敗しても要約自体は次の依頼へ渡せるので、更新は続行する。
    let archivedPath = null;
    try {
      archivedPath = this.archiveHandoff?.(handoffSummary) ?? null;
    } catch (error) {
      console.error("[WARN] 引き継ぎ要約を保管できません:", error.message);
    }

    this.commitState({
      threadId: null,
      requestCount: 0,
      contextTokens: 0,
      handoffSummary,
      rotationPending: false,
    });
    return {
      rotated: true,
      summaryLength: handoffSummary.length,
      archivedPath,
    };
  }

  /**
   * 役割: 要約せず新しい会話へ切り替える。
   * 入力なし。出力なし。
   */
  rotateFresh() {
    this.rotationBlockedUntilRequestCount = 0;
    this.commitState({
      threadId: null,
      requestCount: 0,
      contextTokens: 0,
      handoffSummary: null,
      rotationPending: false,
    });
  }

  /**
   * 役割: 閾値到達時だけ要約更新する。失敗しても例外にせず、今の会話を続けさせる。
   * 入力: 更新開始を知らせるフック。
   * 出力: { rotated, summaryLength, archivedPath, error }
   */
  async rotateIfNeeded({ onRotationStart } = {}) {
    if (!shouldRotateSession(this.sessionState, this.policy)) {
      return { rotated: false };
    }
    // 直前に失敗したばかりなら、しばらく間を空けてから再挑戦する。
    if (this.sessionState.requestCount < this.rotationBlockedUntilRequestCount) {
      return { rotated: false, skipped: true };
    }

    if (onRotationStart) {
      await onRotationStart(
        describeRotationReason(this.sessionState, this.policy),
      );
    }

    try {
      const result = await this.rotateWithHandoff();
      this.rotationBlockedUntilRequestCount = 0;
      return result;
    } catch (error) {
      // ここで例外を投げると、20件を超えたあと何を送ってもエラーになり続ける。
      // 更新を諦めて今の会話を続け、しばらくしてから再挑戦する。
      this.rotationBlockedUntilRequestCount =
        this.sessionState.requestCount + this.rotationRetryGapRequests;
      return { rotated: false, error };
    }
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
