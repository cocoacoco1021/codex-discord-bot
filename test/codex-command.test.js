import assert from "node:assert/strict";
import test from "node:test";

import { buildCodexArgs } from "../codex-command.js";

const BASE_INPUT = {
  codexCwd: "/workspace",
  lastMessageFile: "/tmp/last-message.txt",
  prompt: "前の話を覚えている？",
  guardrail: "安全指示:\n",
};

test("継続時は作業場所をresumeより前のグローバル引数に置く", () => {
  const args = buildCodexArgs({
    ...BASE_INPUT,
    threadId: "123e4567-e89b-12d3-a456-426614174000",
  });

  assert.deepEqual(args.slice(0, 4), ["-C", "/workspace", "exec", "resume"]);
  assert.equal(args.at(-1), BASE_INPUT.prompt);
  assert.equal(args.includes(BASE_INPUT.guardrail + BASE_INPUT.prompt), false);
});

test("新規時だけ安全指示を本文の先頭へ付ける", () => {
  const args = buildCodexArgs({ ...BASE_INPUT, threadId: null });

  assert.deepEqual(args.slice(0, 3), ["-C", "/workspace", "exec"]);
  assert.equal(args.includes("resume"), false);
  assert.equal(args.at(-1), BASE_INPUT.guardrail + BASE_INPUT.prompt);
});

test("新規会話の添付画像をCodexの画像引数へ渡す", () => {
  const imagePaths = ["/tmp/image-1.png", "/tmp/image-2.webp"];
  const args = buildCodexArgs({
    ...BASE_INPUT,
    threadId: null,
    imagePaths,
  });

  assert.deepEqual(
    args.slice(args.indexOf("--image"), args.indexOf("-o")),
    ["--image", imagePaths[0], "--image", imagePaths[1]],
  );
});

test("継続会話でも添付画像をCodexへ渡す", () => {
  const imagePath = "/tmp/image-1.jpg";
  const args = buildCodexArgs({
    ...BASE_INPUT,
    threadId: "123e4567-e89b-12d3-a456-426614174000",
    imagePaths: [imagePath],
  });

  assert.equal(args[args.indexOf("--image") + 1], imagePath);
  assert.ok(args.indexOf("--image") < args.indexOf("-o"));
});
