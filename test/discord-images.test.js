import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  cleanupDownloadedImages,
  detectImageFormat,
  downloadDiscordImages,
  ImageAttachmentError,
  isAllowedDiscordCdnUrl,
  isSupportedImageAttachment,
  loadImageSettings,
} from "../discord-images.js";

// 実在のPNGとして通る最小データ（署名 + 長さ13のIHDRチャンク見出し）
const PNG_BUFFER = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from("IHDR", "ascii"),
  Buffer.alloc(13),
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
    name: "image.png",
    contentType: "image/png",
    size: PNG_BUFFER.length,
    url: "https://cdn.discordapp.com/attachments/1/2/image.png",
    ...overrides,
  };
}

/**
 * 役割: 指定Bufferを返すfetch互換関数を作る。
 * 入力: HTTPレスポンスとして返すBuffer、レスポンスの上書き設定。
 * 出力: fetch互換の非同期関数。
 */
function createFetchImage(imageBuffer, responseInit = {}) {
  return async () =>
    new Response(imageBuffer, {
      status: 200,
      headers: { "content-length": String(imageBuffer.length) },
      ...responseInit,
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
    assert.match(downloadedImages.imagePaths[0], /image-1\.png$/);
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

test("公式CDNでも添付以外のパスは拒否する", () => {
  assert.equal(
    isAllowedDiscordCdnUrl("https://cdn.discordapp.com/avatars/1/2.png"),
    false,
  );
  assert.equal(
    isAllowedDiscordCdnUrl("http://cdn.discordapp.com/attachments/1/2/a.png"),
    false,
  );
  assert.equal(
    isAllowedDiscordCdnUrl("https://user:pw@cdn.discordapp.com/attachments/1/2/a.png"),
    false,
  );
  assert.equal(
    isAllowedDiscordCdnUrl("https://cdn.discordapp.com/attachments/1/2/a.png"),
    true,
  );
  assert.equal(
    isAllowedDiscordCdnUrl(
      "https://media.discordapp.net/ephemeral-attachments/1/2/a.png",
    ),
    true,
  );
});

test("リダイレクトで公式CDNの外へ出た応答を拒否する", async () => {
  await assert.rejects(
    downloadDiscordImages([createAttachment()], IMAGE_SETTINGS, async () => {
      const response = new Response(PNG_BUFFER, { status: 200 });
      Object.defineProperty(response, "url", {
        value: "https://example.com/image.png",
      });
      return response;
    }),
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

test("申告より大きい本文は読み取り途中で打ち切る", async () => {
  // content-length を出さないストリームでも、上限を超えた時点で中断する
  const oversizedChunk = new Uint8Array(IMAGE_SETTINGS.maxBytes + 1);
  await assert.rejects(
    downloadDiscordImages(
      [createAttachment()],
      IMAGE_SETTINGS,
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(oversizedChunk);
              controller.close();
            },
          }),
          { status: 200 },
        ),
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

test("実形式から拡張子を決めるので偽装拡張子は引き継がない", () => {
  assert.deepEqual(detectImageFormat(PNG_BUFFER), {
    contentType: "image/png",
    extension: ".png",
  });
  assert.equal(detectImageFormat(Buffer.from("not-an-image")), null);
});

test("対応画像かどうかは拡張子かContent-Typeで判定する", () => {
  assert.equal(isSupportedImageAttachment(createAttachment()), true);
  assert.equal(
    isSupportedImageAttachment({ name: "a.PNG", contentType: null }),
    true,
  );
  assert.equal(
    isSupportedImageAttachment({ name: "a.mov", contentType: "video/quicktime" }),
    false,
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
