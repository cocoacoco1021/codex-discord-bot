const DEFAULT_MAX_REQUESTS = 20;
// claude版と同じ位置で自動更新する。codexの文脈窓（約25万）に対しては早めだが、
// codex自身の自動圧縮が始まる前に要約で引き継ぐほうが、消費トークンも文脈の質も安定する。
const DEFAULT_MAX_CONTEXT_TOKENS = 80_000;
const DEFAULT_MAX_HANDOFF_CHARS = 3_000;

export class SessionPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionPolicyError";
  }
}

/**
 * 役割: 環境変数の正整数を検証し、未設定なら既定値を返す。
 * 入力: 環境変数一覧・変数名・既定値。出力: 正整数。
 */
function readPositiveInteger(environment, key, fallback) {
  const rawValue = environment[key];
  if (rawValue === undefined || rawValue === "") return fallback;

  const parsedValue = Number(rawValue);
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new SessionPolicyError(`${key} は正整数で指定してください`);
  }
  return parsedValue;
}

/**
 * 役割: セッション更新の閾値を環境変数から読み込む。
 * 入力: process.env互換オブジェクト。出力: 検証済みポリシー。
 */
export function loadSessionPolicy(environment = process.env) {
  return {
    maxRequests: readPositiveInteger(
      environment,
      "CODEX_SESSION_MAX_REQUESTS",
      DEFAULT_MAX_REQUESTS,
    ),
    maxContextTokens: readPositiveInteger(
      environment,
      "CODEX_SESSION_MAX_CONTEXT_TOKENS",
      DEFAULT_MAX_CONTEXT_TOKENS,
    ),
    maxHandoffChars: readPositiveInteger(
      environment,
      "CODEX_HANDOFF_MAX_CHARS",
      DEFAULT_MAX_HANDOFF_CHARS,
    ),
  };
}

/**
 * 役割: Discord本文がセッション切替コマンドか判定する。
 * 入力: Discord本文。出力: handoff/fresh、通常文ならnull。
 */
export function parseSessionCommand(content) {
  const normalizedContent = content.trim().toLowerCase();
  if (normalizedContent === "!new") return "handoff";
  if (normalizedContent === "!new fresh") return "fresh";
  return null;
}

/**
 * 役割: 会話数・容量・移行印から自動更新の要否を判定する。
 * 入力: セッション状態とポリシー。出力: 更新が必要ならtrue。
 */
export function shouldRotateSession(sessionState, policy) {
  return (
    sessionState.rotationPending ||
    sessionState.requestCount >= policy.maxRequests ||
    sessionState.contextTokens >= policy.maxContextTokens
  );
}

/**
 * 役割: 旧会話から安全で短い引き継ぎ要約を作らせる指示を返す。
 * 入力: 最大文字数。出力: Codexへ渡す要約指示。
 */
export function buildHandoffSummaryPrompt(maxHandoffChars) {
  return (
    "新しいCodexセッションへ引き継ぐため、ここまでの会話を要約してください。" +
    `日本語で${maxHandoffChars}文字以内に収め、次だけを残してください。\n` +
    "- 持ち主の目的と継続中の作業\n" +
    "- 決定済みの仕様、重要な判断、未完了事項\n" +
    "- 必要なファイルパスや検証結果\n" +
    "- 外部操作について確認済みか未確認か\n" +
    "パスワード、APIキー、Botトークン、会話全文、画像データは含めないでください。" +
    "要約本文だけを返してください。"
  );
}

/**
 * 役割: Codexの要約を保存可能な長さへ整える。
 * 入力: 要約本文と最大文字数。出力: 整形済み要約。
 */
export function normalizeHandoffSummary(summary, maxHandoffChars) {
  return summary.trim().slice(0, maxHandoffChars);
}

/**
 * 役割: 新しい会話の最初の依頼へ、旧会話の要約だけを添える。
 * 入力: 持ち主の依頼と引き継ぎ要約。出力: Codexへ渡す本文。
 */
export function buildPromptWithHandoff(prompt, handoffSummary) {
  if (!handoffSummary) return prompt;

  return (
    "以下は直前のセッションからの引き継ぎ要約です。過去の会話として扱い、" +
    "現在の依頼を優先してください。\n\n" +
    `<handoff>\n${handoffSummary}\n</handoff>\n\n` +
    `持ち主の現在の依頼:\n${prompt}`
  );
}

/**
 * 役割: なぜ自動更新が走るのかを、持ち主向けの一言にする。
 * 入力: セッション状態とポリシー。出力: 説明文。
 */
export function describeRotationReason(sessionState, policy) {
  if (sessionState.requestCount >= policy.maxRequests) {
    return `ご依頼が${sessionState.requestCount}件になりました`;
  }
  if (sessionState.contextTokens >= policy.maxContextTokens) {
    return `会話が約${sessionState.contextTokens.toLocaleString(
      "ja-JP",
    )}トークンまで育ちました`;
  }
  return "前回やり残したセッションの更新があります";
}
