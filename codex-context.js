// 役割: 「いまの会話がどれだけ文脈を抱えているか」をcodexのセッションログから読む。
// 入力: 会話スレッドID。出力: 直近リクエストの入力トークン数（読めなければ0）。
//
// なぜstdoutを使わないか（2026-09-10に実測して確定）:
//   codex exec --json の turn.completed が持つ usage は「スレッドの累計」で、
//   resume をまたいで加算され続ける（1回目 input_tokens=12,345 → 2回目 66,666）。
//   これを文脈量として使うと、会話を続けるほど実態から離れて必ず上限判定に当たる。
//   claude版が使っている usage（1応答ぶんの入力量＝いまの文脈量）と同じ意味を持つ数字は、
//   セッションログの token_count イベントの last_token_usage だけ。
//   （codex 0.154.0 の stdout には last_token_usage は出ない）
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// セッションログの末尾から読む量。直近のトークン記録は末尾から数KB以内に出る（実測1,158バイト）。
const TAIL_BYTES = 512 * 1024;
// sessions/<年>/<月>/<日>/rollout-*.jsonl まで潜る深さ。
const SESSIONS_MAX_DEPTH = 3;

// 会話IDごとのセッションログの場所。毎回フォルダを探し直さないために覚えておく。
const rolloutPathCache = new Map();
// 同じ会話で何度も同じ警告を出さないための記録。
const warnedThreadIds = new Set();

/**
 * 役割: codexのホーム（セッションログの置き場所）を決める。
 * 入力: 環境変数。出力: ホームのパス。
 */
export function resolveCodexHome(environment = process.env) {
  return environment.CODEX_HOME || join(homedir(), ".codex");
}

/**
 * 役割: 会話スレッドの現在の文脈量を読む。
 * 入力: 会話スレッドID、codexホーム。
 * 出力: 非負整数のトークン数。読めなければ0。
 * 実装メモ: 0に縮退した場合は依頼件数だけで自動更新を判定する（claude版のusage欠落時と同じ）。
 *           ただし気づけないまま放置されないよう、会話ごとに一度だけ警告を残す。
 */
export function readContextTokens(threadId, { codexHome } = {}) {
  if (!threadId) return 0;
  const home = codexHome || resolveCodexHome();

  const rolloutPath = findRolloutPath(threadId, home);
  const contextTokens = rolloutPath
    ? extractLastContextTokens(readTail(rolloutPath, TAIL_BYTES))
    : 0;

  if (contextTokens > 0) {
    warnedThreadIds.delete(threadId);
    return contextTokens;
  }
  if (!warnedThreadIds.has(threadId)) {
    warnedThreadIds.add(threadId);
    console.error(
      `[WARN] 文脈量を読めませんでした（会話 ${threadId}）。` +
        "自動更新は依頼件数だけで判定します。",
    );
  }
  return 0;
}

/**
 * 役割: 会話スレッドIDからセッションログの場所を突き止める。
 * 入力: 会話スレッドID、codexホーム。出力: ファイルパス。見つからなければnull。
 */
export function findRolloutPath(threadId, codexHome) {
  const cacheKey = `${codexHome}\n${threadId}`;
  const cachedPath = rolloutPathCache.get(cacheKey);
  if (cachedPath && existsSync(cachedPath)) return cachedPath;

  const foundPath = findFileWithSuffix(
    join(codexHome, "sessions"),
    `-${threadId}.jsonl`,
    SESSIONS_MAX_DEPTH,
  );
  if (foundPath) rolloutPathCache.set(cacheKey, foundPath);
  return foundPath;
}

/**
 * 役割: セッションログの末尾から、最後に記録されたトークン量を取り出す。
 * 入力: ログ末尾の文字列。出力: 非負整数のトークン数。無ければ0。
 */
export function extractLastContextTokens(tailText) {
  const lines = tailText.split("\n");
  // 先頭は行の途中から読み始めている可能性があるので捨てる。
  lines.shift();

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes("last_token_usage") && !line.includes("turn_token_usage")) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const tokens = readInputTokens(record);
    if (tokens > 0) return tokens;
  }
  return 0;
}

/**
 * 役割: トークン記録の行から、1リクエストぶんの入力トークン数を取り出す。
 * 入力: ログ1行分のオブジェクト。出力: 非負整数のトークン数。
 * 実装メモ: 累計値(total_token_usage / thread_token_usage)は文脈量ではないため使わない。
 */
function readInputTokens(record) {
  const payload = record?.payload ?? record;
  const usage =
    payload?.info?.last_token_usage ?? // token_count イベント
    payload?.usage ?? // token_usage_record（1レスポンスぶん）
    null;
  const inputTokens = Number(usage?.input_tokens);
  if (!Number.isFinite(inputTokens) || inputTokens < 0) return 0;
  return Math.round(inputTokens);
}

/**
 * 役割: 大きなログでも末尾だけを読む。
 * 入力: ファイルパス、読む最大バイト数。出力: 末尾の文字列（失敗時は空）。
 */
function readTail(filePath, maxBytes) {
  let fileDescriptor = null;
  try {
    fileDescriptor = openSync(filePath, "r");
    const { size } = fstatSync(fileDescriptor);
    const readBytes = Math.min(size, maxBytes);
    const buffer = Buffer.allocUnsafe(readBytes);
    readSync(fileDescriptor, buffer, 0, readBytes, size - readBytes);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fileDescriptor !== null) {
      try {
        closeSync(fileDescriptor);
      } catch {
        /* 後始末の失敗は無視する */
      }
    }
  }
}

/**
 * 役割: 指定フォルダ以下から、名前の末尾が一致するファイルを探す。
 * 入力: 探し始めるフォルダ、末尾の文字列、潜る深さ。出力: パスまたはnull。
 * 実装メモ: 日付順の名前なので降順に見て、新しい日付から先に当てる。
 */
function findFileWithSuffix(directory, suffix, maxDepth) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  entries.sort((left, right) => right.name.localeCompare(left.name));

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(suffix)) {
      return join(directory, entry.name);
    }
  }
  if (maxDepth <= 0) return null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const foundPath = findFileWithSuffix(
      join(directory, entry.name),
      suffix,
      maxDepth - 1,
    );
    if (foundPath) return foundPath;
  }
  return null;
}
