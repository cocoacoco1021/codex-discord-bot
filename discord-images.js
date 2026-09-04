// Discord添付画像の取り込み。
// 役割: 持ち主が送った画像だけを、容量・形式・取得先を検証したうえで一時保存する。
// 方針: 拡張子やContent-Typeを信用しない。Discord公式CDN以外へは一切アクセスしない。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

const DEFAULT_MAX_IMAGE_COUNT = 4;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_IMAGE_DOWNLOAD_TIMEOUT_MS = 15000;

const DISCORD_CDN_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);
// Discordの添付ファイルはこのパス配下にしか置かれない。他は取りに行かない。
const DISCORD_ATTACHMENT_PATHS = ["/attachments/", "/ephemeral-attachments/"];

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const SUPPORTED_IMAGE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

export class ImageAttachmentError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "ImageAttachmentError";
  }
}

/**
 * 役割: 画像設定を正の整数として読み込む。
 * 入力: 設定名、環境変数の文字列、未設定時の初期値。
 * 出力: 正の整数。形式不正時はImageAttachmentErrorを送出する。
 */
function parsePositiveInteger(settingName, rawSetting, defaultSetting) {
  if (rawSetting === undefined || rawSetting === "") return defaultSetting;

  const parsedSetting = Number(rawSetting);
  if (!Number.isSafeInteger(parsedSetting) || parsedSetting <= 0) {
    throw new ImageAttachmentError(`${settingName}は正の整数で設定してください`);
  }
  return parsedSetting;
}

/**
 * 役割: Discord画像の枚数・容量・取得時間の設定を組み立てる。
 * 入力: process.env互換の設定オブジェクト。
 * 出力: 検証済みの画像設定。
 */
export function loadImageSettings(environment) {
  return {
    maxCount: parsePositiveInteger(
      "DISCORD_IMAGE_MAX_COUNT",
      environment.DISCORD_IMAGE_MAX_COUNT,
      DEFAULT_MAX_IMAGE_COUNT,
    ),
    maxBytes: parsePositiveInteger(
      "DISCORD_IMAGE_MAX_BYTES",
      environment.DISCORD_IMAGE_MAX_BYTES,
      DEFAULT_MAX_IMAGE_BYTES,
    ),
    downloadTimeoutMs: parsePositiveInteger(
      "DISCORD_IMAGE_TIMEOUT_MS",
      environment.DISCORD_IMAGE_TIMEOUT_MS,
      DEFAULT_IMAGE_DOWNLOAD_TIMEOUT_MS,
    ),
  };
}

function normalizedContentType(value) {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || "";
}

/**
 * 役割: Discordの表示情報上、対応画像として扱う添付かを判定する。
 * 入力: Discordの添付情報。出力: 画像として扱うならtrue。
 * 実装メモ: ここは「取り込み対象かどうか」の振り分けだけ。本物かどうかは実データで判定する。
 */
export function isSupportedImageAttachment(attachment) {
  const extension = extname(attachment.name || "").toLowerCase();
  return (
    SUPPORTED_IMAGE_EXTENSIONS.has(extension) ||
    SUPPORTED_IMAGE_CONTENT_TYPES.has(
      normalizedContentType(attachment.contentType),
    )
  );
}

/**
 * 役割: Discord公式の添付CDN URLだけを許可する（任意URL取得による事故を防ぐ）。
 * 入力: 検証したいURL文字列。出力: 許可できるならtrue。
 */
export function isAllowedDiscordCdnUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      DISCORD_CDN_HOSTS.has(url.hostname) &&
      DISCORD_ATTACHMENT_PATHS.some((prefix) => url.pathname.startsWith(prefix))
    );
  } catch {
    return false;
  }
}

function hasBytes(data, offset, bytes) {
  if (data.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => data[offset + index] === byte);
}

/**
 * 役割: ファイル先頭の構造から実形式を判定する（拡張子・Content-Typeは信用しない）。
 * 入力: ダウンロード済みのBuffer。
 * 出力: 形式と拡張子。対応画像でなければnull。
 * 実装メモ: 戻り値の拡張子を一時ファイル名に使うため、偽装された拡張子は引き継がない。
 */
export function detectImageFormat(data) {
  if (
    data.length >= 24 &&
    hasBytes(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) &&
    data.readUInt32BE(8) === 13 &&
    data.subarray(12, 16).toString("ascii") === "IHDR"
  ) {
    return { contentType: "image/png", extension: ".png" };
  }

  if (
    data.length >= 4 &&
    hasBytes(data, 0, [0xff, 0xd8, 0xff]) &&
    data[3] !== 0x00 &&
    data[3] !== 0xff
  ) {
    return { contentType: "image/jpeg", extension: ".jpg" };
  }

  if (
    data.length >= 16 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(data.subarray(12, 16).toString("ascii"))
  ) {
    return { contentType: "image/webp", extension: ".webp" };
  }

  return null;
}

/**
 * 役割: 画像用一時ディレクトリを削除する。
 * 入力: downloadDiscordImagesが返した一時ディレクトリのパス。
 * 出力: なし。削除失敗時はImageAttachmentErrorを送出する。
 */
export function cleanupDownloadedImages(directoryPath) {
  if (!directoryPath) return;

  try {
    rmSync(directoryPath, { recursive: true, force: true });
  } catch (error) {
    throw new ImageAttachmentError("一時画像の削除に失敗しました", error);
  }
}

/**
 * 役割: 本文を全部メモリに載せる前に、読みながら容量上限で打ち切る。
 * 入力: fetchのレスポンスと上限バイト数。出力: 受信済みBuffer。
 */
async function readResponseWithLimit(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new ImageAttachmentError(
      "画像データを読み取れませんでした。もう一度添付してください。",
    );
  }

  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ImageAttachmentError("添付画像が容量上限を超えています");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

/**
 * 役割: Discord添付画像を検証し、安全な一時ファイルへ保存する。
 * 入力: 添付情報の配列、画像設定、テスト差し替え可能なfetch関数。
 * 出力: 画像パス配列と一時ディレクトリのパス。
 */
export async function downloadDiscordImages(
  attachments,
  imageSettings,
  fetchImage = globalThis.fetch,
) {
  if (attachments.length === 0) {
    return { directoryPath: null, imagePaths: [] };
  }
  if (attachments.length > imageSettings.maxCount) {
    throw new ImageAttachmentError(
      `画像は1回につき${imageSettings.maxCount}枚までです`,
    );
  }
  if (typeof fetchImage !== "function") {
    throw new ImageAttachmentError(
      "このNode.jsでは画像を取得できません。Node.js 18以降が必要です。",
    );
  }

  // 取りに行く前に、URLと申告サイズをまとめて検査する。
  for (const attachment of attachments) {
    if (!isSupportedImageAttachment(attachment)) {
      throw new ImageAttachmentError("対応画像はPNG・JPEG・WebPです");
    }
    if (!isAllowedDiscordCdnUrl(attachment.url)) {
      throw new ImageAttachmentError(
        "Discord公式CDN以外の画像URLは受け付けられません",
      );
    }
    if (Number(attachment.size) > imageSettings.maxBytes) {
      throw new ImageAttachmentError(
        `画像1枚の上限は${imageSettings.maxBytes}バイトです`,
      );
    }
  }

  const directoryPath = mkdtempSync(join(tmpdir(), "discord-bot-images-"));
  try {
    const imagePaths = [];
    for (const [imageIndex, attachment] of attachments.entries()) {
      let response;
      try {
        // リダイレクト先へは追従しない。取得後のURLも念のため再検査する。
        response = await fetchImage(attachment.url, {
          redirect: "error",
          signal: AbortSignal.timeout(imageSettings.downloadTimeoutMs),
        });
      } catch (error) {
        throw new ImageAttachmentError(
          "画像をDiscordから取得できませんでした。もう一度添付してください。",
          error,
        );
      }
      if (
        !response.ok ||
        !isAllowedDiscordCdnUrl(response.url || attachment.url)
      ) {
        throw new ImageAttachmentError(
          "画像をDiscordから取得できませんでした。もう一度添付してください。",
        );
      }

      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > imageSettings.maxBytes) {
        throw new ImageAttachmentError("添付画像が容量上限を超えています");
      }

      const data = await readResponseWithLimit(response, imageSettings.maxBytes);
      const format = detectImageFormat(data);
      if (!format) {
        throw new ImageAttachmentError(
          "画像の実ファイル形式を確認できませんでした。PNG・JPEG・WebPを送ってください。",
        );
      }

      const imagePath = join(
        directoryPath,
        `image-${imageIndex + 1}${format.extension}`,
      );
      writeFileSync(imagePath, data, { mode: 0o600 });
      imagePaths.push(imagePath);
    }
    return { directoryPath, imagePaths };
  } catch (error) {
    cleanupDownloadedImages(directoryPath);
    if (error instanceof ImageAttachmentError) throw error;
    throw new ImageAttachmentError("添付画像の取得に失敗しました", error);
  }
}
