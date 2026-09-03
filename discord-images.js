import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_MAX_IMAGE_COUNT = 4;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_IMAGE_DOWNLOAD_TIMEOUT_MS = 15000;
const DISCORD_CDN_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);
const IMAGE_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
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

/**
 * 役割: Discord添付URLが公式CDNを指していることを確認する。
 * 入力: Discordから受け取った添付URL。
 * 出力: 検証済みのURL文字列。
 */
function validateDiscordAttachmentUrl(attachmentUrl) {
  try {
    const parsedUrl = new URL(attachmentUrl);
    if (parsedUrl.protocol !== "https:" || !DISCORD_CDN_HOSTS.has(parsedUrl.hostname)) {
      throw new Error("Discord公式CDN以外のURLです");
    }
    return parsedUrl.href;
  } catch (error) {
    throw new ImageAttachmentError("添付画像のURLを安全に確認できません", error);
  }
}

/**
 * 役割: バイナリ先頭を使って実際の画像形式を判定する。
 * 入力: ダウンロード済みファイルのBuffer。
 * 出力: MIMEタイプ。対応画像でなければnull。
 */
function detectImageContentType(imageBuffer) {
  if (
    imageBuffer.length >= 8 &&
    imageBuffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (
    imageBuffer.length >= 3 &&
    imageBuffer[0] === 0xff &&
    imageBuffer[1] === 0xd8 &&
    imageBuffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    imageBuffer.length >= 12 &&
    imageBuffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    imageBuffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
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
 * 役割: Discord添付画像を検証し、安全な一時ファイルへ保存する。
 * 入力: 添付情報の配列、画像設定、テスト差し替え可能なfetch関数。
 * 出力: 画像パス配列と一時ディレクトリのパス。
 */
export async function downloadDiscordImages(
  attachments,
  imageSettings,
  fetchImage = fetch,
) {
  if (attachments.length === 0) {
    return { directoryPath: null, imagePaths: [] };
  }
  if (attachments.length > imageSettings.maxCount) {
    throw new ImageAttachmentError(
      `画像は1回につき${imageSettings.maxCount}枚までです`,
    );
  }

  const validatedAttachments = attachments.map((attachment) => {
    const declaredContentType = attachment.contentType?.toLowerCase();
    const extension = IMAGE_EXTENSIONS.get(declaredContentType);
    if (!extension) {
      throw new ImageAttachmentError(
        "対応画像はPNG・JPEG・WebPです",
      );
    }
    if (attachment.size > imageSettings.maxBytes) {
      throw new ImageAttachmentError(
        `画像1枚の上限は${imageSettings.maxBytes}バイトです`,
      );
    }
    return {
      declaredContentType:
        declaredContentType === "image/jpg" ? "image/jpeg" : declaredContentType,
      extension,
      url: validateDiscordAttachmentUrl(attachment.url),
    };
  });

  const directoryPath = mkdtempSync(join(tmpdir(), "discord-bot-images-"));
  try {
    const imagePaths = [];
    for (const [imageIndex, attachment] of validatedAttachments.entries()) {
      const response = await fetchImage(attachment.url, {
        signal: AbortSignal.timeout(imageSettings.downloadTimeoutMs),
      });
      if (!response.ok) {
        throw new ImageAttachmentError(
          `添付画像を取得できませんでした（HTTP ${response.status}）`,
        );
      }

      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > imageSettings.maxBytes) {
        throw new ImageAttachmentError("添付画像が容量上限を超えています");
      }

      const imageBuffer = Buffer.from(await response.arrayBuffer());
      if (imageBuffer.length > imageSettings.maxBytes) {
        throw new ImageAttachmentError("添付画像が容量上限を超えています");
      }
      const detectedContentType = detectImageContentType(imageBuffer);
      if (detectedContentType !== attachment.declaredContentType) {
        throw new ImageAttachmentError("添付ファイルの画像形式を確認できません");
      }

      const imagePath = join(
        directoryPath,
        `image-${imageIndex + 1}${attachment.extension}`,
      );
      writeFileSync(imagePath, imageBuffer, { mode: 0o600 });
      imagePaths.push(imagePath);
    }
    return { directoryPath, imagePaths };
  } catch (error) {
    cleanupDownloadedImages(directoryPath);
    if (error instanceof ImageAttachmentError) throw error;
    throw new ImageAttachmentError("添付画像の取得に失敗しました", error);
  }
}
