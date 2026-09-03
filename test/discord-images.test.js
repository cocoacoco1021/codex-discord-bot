import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  cleanupDownloadedImages,
  downloadDiscordImages,
  ImageAttachmentError,
  loadImageSettings,
} from "../discord-images.js";

const PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);
const IMAGE_SETTINGS = {
  maxCount: 2,
  maxBytes: 1024,
  downloadTimeoutMs: 1000,
};

/**
 * 役割: Discord画像添付を模したテスト情報を作る。
 * 入力: 上書きしたい添付プロパティ。
 * 出力: PNG画像の添付情報。
 */
function createAttachment(overrides = {}) {
  return {
    contentType: "image/png",
    size: PNG_BUFFER.length,
    url: "https://cdn.discordapp.com/attachments/1/2/image.png",
    ...overrides,
  };
}

/**
 * 役割: 指定Bufferを返すfetch互換関数を作る。
 * 入力: HTTPレスポンスとして返すBuffer。
 * 出力: fetch互換の非同期関数。
 */
function createFetchImage(imageBuffer) {
  return async () =>
    new Response(imageBuffer, {
      status: 200,
      headers: { "content-length": String(imageBuffer.length) },
    });
}

test("Discord公式CDNのPNG画像を一時保存できる", async () => {
  const downloadedImages = await downloadDiscordImages(
    [createAttachment()],
    IMAGE_SETTINGS,
    createFetchImage(PNG_BUFFER),
  );
  try {
    assert.equal(downloadedImages.imagePaths.length, 1);
    assert.deepEqual(readFileSync(downloadedImages.imagePaths[0]), PNG_BUFFER);
  } finally {
    cleanupDownloadedImages(downloadedImages.directoryPath);
  }
  assert.equal(existsSync(downloadedImages.directoryPath), false);
});

test("Discord公式CDN以外のURLを拒否する", async () => {
  await assert.rejects(
    downloadDiscordImages(
      [createAttachment({ url: "https://example.com/image.png" })],
      IMAGE_SETTINGS,
      createFetchImage(PNG_BUFFER),
    ),
    ImageAttachmentError,
  );
});

test("容量上限を超える画像を取得前に拒否する", async () => {
  await assert.rejects(
    downloadDiscordImages(
      [createAttachment({ size: IMAGE_SETTINGS.maxBytes + 1 })],
      IMAGE_SETTINGS,
      createFetchImage(PNG_BUFFER),
    ),
    ImageAttachmentError,
  );
});

test("申告形式と実ファイル形式が違う添付を拒否する", async () => {
  await assert.rejects(
    downloadDiscordImages(
      [createAttachment()],
      IMAGE_SETTINGS,
      createFetchImage(Buffer.from("not-an-image")),
    ),
    ImageAttachmentError,
  );
});

test("画像設定は環境変数で変更できる", () => {
  assert.deepEqual(
    loadImageSettings({
      DISCORD_IMAGE_MAX_COUNT: "3",
      DISCORD_IMAGE_MAX_BYTES: "2048",
      DISCORD_IMAGE_TIMEOUT_MS: "2500",
    }),
    { maxCount: 3, maxBytes: 2048, downloadTimeoutMs: 2500 },
  );
});

test("不正な画像設定を拒否する", () => {
  assert.throws(
    () => loadImageSettings({ DISCORD_IMAGE_MAX_COUNT: "0" }),
    ImageAttachmentError,
  );
});
