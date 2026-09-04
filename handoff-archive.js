// 引き継ぎ要約の保管庫。
// 役割: セッション更新のたびに作られる要約を、日時つきファイルとして残す。
// 方針: 過去の要約は絶対に上書き・削除しない（持ち主の「消さずに残す」という決めごと）。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export class HandoffArchiveError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "HandoffArchiveError";
  }
}

/** URLでもパス文字列でも受け取れるようにする。 */
function toDirectoryPath(directory) {
  return directory instanceof URL ? fileURLToPath(directory) : String(directory);
}

/**
 * 役割: 保存日時から重複しないファイル名を作る。
 * 入力: 日時と、同じ日時が埋まっていた場合の連番。出力: ファイル名。
 */
export function buildHandoffFileName(now = new Date(), duplicateIndex = 0) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return duplicateIndex === 0
    ? `handoff-${stamp}.md`
    : `handoff-${stamp}-${duplicateIndex + 1}.md`;
}

/**
 * 役割: 引き継ぎ要約を過去ログとして保存する。
 * 入力: 保管ディレクトリ、要約本文、保存日時。
 * 出力: 保存したファイルのパス。
 * 実装メモ: flag "wx" で既存ファイルを絶対に上書きしない。名前が衝突したら連番を足す。
 */
export function saveHandoffSummary(directory, summary, now = new Date()) {
  const directoryPath = toDirectoryPath(directory);
  try {
    mkdirSync(directoryPath, { recursive: true });
    for (let duplicateIndex = 0; duplicateIndex < 100; duplicateIndex += 1) {
      const filePath = join(
        directoryPath,
        buildHandoffFileName(now, duplicateIndex),
      );
      try {
        writeFileSync(filePath, `${summary}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        return filePath;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    throw new Error("同じ日時のファイルが多すぎます");
  } catch (error) {
    if (error instanceof HandoffArchiveError) throw error;
    throw new HandoffArchiveError("引き継ぎ要約を保管できません", error);
  }
}
