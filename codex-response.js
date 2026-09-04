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

// 「そのスレッドはもう無い」と読み取れる文言だけを対象にする。
// 通信断・利用上限・タイムアウトで会話の記憶を捨てないため、ここは広げない。
const MISSING_THREAD_PATTERN =
  /(?:session|thread|conversation)[^\n]{0,40}(?:not found|does not exist|no longer|expired|invalid)|(?:not found|does not exist|expired)[^\n]{0,40}(?:session|thread|conversation)/i;

/**
 * 役割: 新規会話で一度だけ再試行すべきセッション不整合かを判定する。
 * 入力: codex実行が送出したエラー。
 * 出力: スレッドを破棄して再試行する場合true。
 * 実装メモ: 一時的な失敗（通信・利用上限・タイムアウト）では会話IDを捨てない。
 *           スレッドそのものが見つからない場合だけ、新しい会話を始め直す。
 */
export function shouldRetryWithoutSession(error) {
  return MISSING_THREAD_PATTERN.test(String(error?.message || error || ""));
}
