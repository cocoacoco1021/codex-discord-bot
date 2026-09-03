/**
 * 役割: Codex CLIを新規会話または継続会話で呼ぶ引数を組み立てる。
 * 入力: 作業場所、一時出力先、会話ID、持ち主の本文、初回用の安全指示、画像パス。
 * 出力: child_process.spawnへ渡せる引数配列。
 */
export function buildCodexArgs({
  codexCwd,
  lastMessageFile,
  threadId,
  prompt,
  guardrail,
  imagePaths = [],
}) {
  const globalOptions = ["-C", codexCwd];
  const executionOptions = [
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  for (const imagePath of imagePaths) {
    executionOptions.push("--image", imagePath);
  }
  // --imageは複数値を受け取るため、後続の-oで画像引数の終端を明確にする。
  executionOptions.push("-o", lastMessageFile);

  if (threadId) {
    return [
      ...globalOptions,
      "exec",
      "resume",
      ...executionOptions,
      threadId,
      prompt,
    ];
  }

  return [
    ...globalOptions,
    "exec",
    ...executionOptions,
    guardrail + prompt,
  ];
}
