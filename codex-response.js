const THREAD_ID_PATTERN =
  /"thread_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;

/**
 * 役割: codexのJSONL出力（stdout）から会話スレッドIDを取り出す。
 * 入力: codex exec --json の標準出力。
 * 出力: 会話スレッドID。thread.startedが無ければnull。
 */
export function extractThreadId(stdout) {
  const match = stdout.match(THREAD_ID_PATTERN);
  return match ? match[1] : null;
}

// 文脈量（いまの会話が抱えているトークン数）は stdout からは分からない。
// codex exec --json の turn.completed の usage はスレッドの累計値で、
// resume をまたいで加算され続けるため文脈量として使えない（2026-09-10に実測）。
// 現在の文脈量は codex-context.js がセッションログの last_token_usage から読む。

// codex exec --json は失敗の真因を stdout の JSONL に載せる（例: 利用上限）。
// 一方 stderr には "Reading additional input from stdin..." のような的外れな一文しか
// 出ないことがあり、それを表示すると真因が隠れる。type が error/failed のイベントだけを対象にする。
const CODEX_ERROR_TYPE_PATTERN = /error|failed/i;

/**
 * 役割: 1件のJSONLイベントから、失敗の真因メッセージを取り出す。
 * 入力: パース済みのイベントオブジェクト。
 * 出力: メッセージ文字列。該当しなければnull。
 * 実装メモ: turn.failed は error.message、error 型は message に真因が入る。
 *           形が揺れても拾えるよう error.message → error(文字列) → message の順で探す。
 */
function pickCodexErrorMessage(event) {
  if (!event || typeof event !== "object") return null;
  const type = typeof event.type === "string" ? event.type : "";
  if (!CODEX_ERROR_TYPE_PATTERN.test(type)) return null;
  const nested =
    event.error && typeof event.error === "object" ? event.error.message : null;
  const errorString = typeof event.error === "string" ? event.error : null;
  const flat = typeof event.message === "string" ? event.message : null;
  const candidate = nested || errorString || flat;
  const text = typeof candidate === "string" ? candidate.trim() : "";
  return text || null;
}

/**
 * 役割: codexのJSONL出力（stdout）から失敗の真因メッセージを取り出す。
 * 入力: codex exec --json の標準出力。
 * 出力: 見つかった最後のエラーメッセージ。無ければnull。
 * 実装メモ: 行ごとにJSONとして解析し、後ろ（＝最後のイベント＝真因に最も近い）から探す。
 *           JSONでない行やエラー以外のイベントは読み飛ばす。
 */
export function extractCodexError(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line || line[0] !== "{") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // JSONとして読めない行は無視する
    }
    const message = pickCodexErrorMessage(event);
    if (message) return message;
  }
  return null;
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
