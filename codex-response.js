const THREAD_ID_PATTERN =
  /"thread_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;
// codexは各ターンの token_count イベントで last_token_usage を出す。
// 現在の文脈量の目安として、この input_tokens（キャッシュ込みの入力量）を使う。
const LAST_TOKEN_USAGE_INPUT_PATTERN =
  /"last_token_usage"\s*:\s*\{[^}]*?"input_tokens"\s*:\s*(\d+)/gi;

/**
 * 役割: codexのJSONL出力（stdout）から会話スレッドIDを取り出す。
 * 入力: codex exec --json の標準出力。
 * 出力: 会話スレッドID。thread.startedが無ければnull。
 */
export function extractThreadId(stdout) {
  const match = stdout.match(THREAD_ID_PATTERN);
  return match ? match[1] : null;
}

/**
 * 役割: codexの利用量から現在の文脈量を保守的に見積もる。
 * 入力: codex exec --json の標準出力。
 * 出力: 非負整数の推定トークン数。取得できなければ0。
 * 実装メモ: token_countの形式は環境差があるため、取れなければ0に縮退させ、
 *           依頼件数による自動更新のみに任せる（claude版のusage欠落時と同じ挙動）。
 */
export function estimateContextTokens(stdout) {
  let maxTokens = 0;
  for (const match of stdout.matchAll(LAST_TOKEN_USAGE_INPUT_PATTERN)) {
    const tokens = Number(match[1]);
    if (Number.isFinite(tokens) && tokens > maxTokens) maxTokens = tokens;
  }
  return maxTokens;
}

/**
 * 役割: 新規会話で一度だけ再試行すべきセッション不整合かを判定する。
 * 入力: codex実行が送出したエラー。
 * 出力: セッションを破棄して再試行する場合true。
 * 実装メモ: codexは期限切れ・存在しないスレッドを明確に分類しないため、
 *           スレッド継続中の失敗はすべて一度だけ新規で再試行する（従来のbot.jsと同じ）。
 */
export function shouldRetryWithoutSession() {
  return true;
}
