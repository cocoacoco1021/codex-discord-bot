import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildHandoffFileName,
  HandoffArchiveError,
  saveHandoffSummary,
} from "../handoff-archive.js";

/**
 * 役割: テスト専用ディレクトリを作り、終了後に片付ける。
 * 入力: 一時ディレクトリのパスを受け取るテスト処理。出力: なし。
 */
function withTemporaryDirectory(runTest) {
  const directoryPath = mkdtempSync(join(tmpdir(), "handoff-archive-test-"));
  try {
    runTest(directoryPath);
  } finally {
    rmSync(directoryPath, { recursive: true, force: true });
  }
}

test("要約を日時つきファイルとして保管する", () => {
  withTemporaryDirectory((directoryPath) => {
    const archiveDirectory = join(directoryPath, "handoffs");
    const savedPath = saveHandoffSummary(
      archiveDirectory,
      "決定事項だけの要約",
      new Date("2026-09-05T01:23:45.678Z"),
    );

    assert.equal(
      savedPath,
      join(archiveDirectory, "handoff-2026-09-05T01-23-45-678Z.md"),
    );
    assert.equal(readFileSync(savedPath, "utf8"), "決定事項だけの要約\n");
    // 秘密が混ざる可能性があるので本人だけが読める権限にする
    assert.equal(statSync(savedPath).mode & 0o777, 0o600);
  });
});

test("既にある要約は絶対に上書きしない", () => {
  withTemporaryDirectory((directoryPath) => {
    const now = new Date("2026-09-05T01:23:45.678Z");

    const firstPath = saveHandoffSummary(directoryPath, "1回目", now);
    const secondPath = saveHandoffSummary(directoryPath, "2回目", now);

    assert.notEqual(firstPath, secondPath);
    assert.equal(readFileSync(firstPath, "utf8"), "1回目\n");
    assert.equal(readFileSync(secondPath, "utf8"), "2回目\n");
    assert.equal(readdirSync(directoryPath).length, 2);
  });
});

test("同じ日時の2件目は連番を足したファイル名にする", () => {
  const now = new Date("2026-09-05T01:23:45.678Z");
  assert.equal(buildHandoffFileName(now), "handoff-2026-09-05T01-23-45-678Z.md");
  assert.equal(
    buildHandoffFileName(now, 1),
    "handoff-2026-09-05T01-23-45-678Z-2.md",
  );
});

test("保管先を作れない場合は意味あるエラーにする", () => {
  withTemporaryDirectory((directoryPath) => {
    // ファイルをディレクトリとして使おうとすると失敗する
    const blockedDirectory = saveHandoffSummary(directoryPath, "先客");
    assert.throws(
      () => saveHandoffSummary(blockedDirectory, "入れない"),
      HandoffArchiveError,
    );
  });
});
