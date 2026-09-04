// Discord常駐ボット(codex版): Discordのメッセージを受け取り、このPCの codex CLI に渡して返答する。
// 役割: Discord ⇄ codex CLI(codex exec) の薄い中継。ビジネスロジックは持たない。
// 入力: 許可ユーザーからのDiscordメッセージ。出力: codex の最終メッセージをDiscordへ投稿。
// セキュリティ: ALLOWED_USER_ID 以外のメッセージは完全に無視する（フルモードの唯一の防御線）。
// 参考: claude版(~/claude-discord-bot/bot.js)と同じ構図。呼び出し先だけ codex exec に置換している。

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";

import { buildCodexArgs } from "./codex-command.js";
import {
  extractThreadId,
  estimateContextTokens,
  shouldRetryWithoutSession,
} from "./codex-response.js";
import {
  ConversationStoreError,
  EMPTY_SESSION_STATE,
  loadSessionState,
  saveSessionState,
} from "./conversation-store.js";
import {
  cleanupDownloadedImages,
  downloadDiscordImages,
  isSupportedImageAttachment,
  loadImageSettings,
} from "./discord-images.js";
import { saveHandoffSummary } from "./handoff-archive.js";
import {
  SessionLifecycle,
  SessionLifecycleError,
} from "./session-lifecycle.js";
import {
  loadSessionPolicy,
  parseSessionCommand,
} from "./session-policy.js";

const TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
// codex を動かす作業ディレクトリ（このPCの「あなた」の文脈。トレード研究リポジトリ）
const CODEX_CWD = process.env.CODEX_CWD || process.cwd();
// codex 実行体。このPCでは npm グローバル(@openai/codex)の実体をフルパスで指定する。
// ※お手本のPC(cocoa-m3)は ChatGPT.app 同梱版だったため、パスが異なる。
const CODEX_BIN =
  process.env.CODEX_BIN ||
  "/Users/nisijimk/.nvm/versions/node/v22.22.0/bin/codex";
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 3600000);
const IMAGE_SETTINGS = loadImageSettings(process.env);
const SESSION_POLICY = loadSessionPolicy(process.env);
const DEFAULT_IMAGE_PROMPT = "添付画像を確認して、内容を説明してください。";

// Discord経由で呼ばれるときの振る舞い（フルモードでも暴走させないための歯止め）。
// codex には --append-system-prompt が無いため、新規スレッド開始時にプロンプト冒頭へ注入する。
// 以降のメッセージは resume で文脈を引き継ぐので、毎回入れ直さない。
const GUARDRAIL =
  "あなたはDiscord経由で持ち主から呼ばれているAI秘書(codex)です。" +
  "返答は日本語で、スマホで読みやすいよう簡潔にする。" +
  "お金の支払い・購入、メールやメッセージの送信、ファイルの削除、外部への公開など" +
  "『取り消せない操作・外部に影響する操作』は、実行する前に必ずDiscordで内容を伝えて確認を取ること。" +
  "確認が取れるまでは実行しない。\n\n---\nここからが持ち主のメッセージです:\n";

// 起動時の設定チェック（早期に失敗させて原因を明示する）
if (!TOKEN) {
  console.error("[FATAL] DISCORD_TOKEN が未設定です。.env を確認してください。");
  process.exit(1);
}

// ペアリング（持ち主ID）の記憶ファイル。一度覚えたら再起動しても保持する。
const PAIR_FILE = new URL("./paired.json", import.meta.url);
// Codexの会話状態。再起動後も同じ会話をresumeするために保存する。
const CONVERSATION_FILE = new URL("./conversation.json", import.meta.url);
// codex の最終メッセージ受け取り用の一時ファイル（プロセス固有・毎回上書き）
const LAST_MSG_FILE = join(tmpdir(), `codex-discord-last-${process.pid}.txt`);
// 引き継ぎ要約の保管場所。過去の要約は消さずに残す。
const HANDOFF_DIR = fileURLToPath(new URL("./handoffs/", import.meta.url));

function loadPairedId() {
  try {
    if (existsSync(PAIR_FILE)) {
      return JSON.parse(readFileSync(PAIR_FILE, "utf8")).userId || null;
    }
  } catch {
    /* 壊れていても無視して未ペアリング扱い */
  }
  return null;
}

function savePairedId(id) {
  try {
    writeFileSync(PAIR_FILE, JSON.stringify({ userId: id }, null, 2));
  } catch (e) {
    console.error("[WARN] ペアリング情報の保存に失敗:", e.message);
  }
}

// 許可ユーザーの決定: .env で明示(AUTO以外) > 記憶済み > 未設定(=最初の1人を登録)
let allowedUserId =
  (ALLOWED_USER_ID && ALLOWED_USER_ID !== "AUTO" ? ALLOWED_USER_ID : null) ||
  loadPairedId();

/**
 * 役割: Bot起動時に前回のCodex会話状態を復元する。
 * 入力: なし。
 * 出力: 保存済み状態。未保存または読込失敗なら空状態。
 */
function loadInitialSessionState() {
  try {
    return loadSessionState(CONVERSATION_FILE);
  } catch (error) {
    console.error("[WARN] 保存済みのCodex会話状態を読み込めません:", error.message);
    return { ...EMPTY_SESSION_STATE };
  }
}

/**
 * 役割: 実行中の状態を再起動後も使えるよう保存する。
 * 入力: セッション状態。出力: なし。失敗時は意味ある例外を維持する。
 */
function persistSessionState(nextSessionState) {
  try {
    saveSessionState(CONVERSATION_FILE, nextSessionState);
  } catch (error) {
    if (error instanceof ConversationStoreError) throw error;
    throw new ConversationStoreError("Codex会話状態を保存できません", error);
  }
}

const sessionLifecycle = new SessionLifecycle({
  initialState: loadInitialSessionState(),
  policy: SESSION_POLICY,
  persistState: persistSessionState,
  invokeCodex,
  shouldRetryWithoutSession,
  // 要約は日時つきで残す。古い要約には触らない。
  archiveHandoff: (summary) => saveHandoffSummary(HANDOFF_DIR, summary),
});

// 同時に複数の codex を走らせないための直列キュー（セッション競合を防ぐ）
let queue = Promise.resolve();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  // DM(ダイレクトメッセージ)を受け取るために必要
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[READY] ${c.user.tag} としてログインしました`);
  if (allowedUserId) {
    console.log(`[INFO] 許可ユーザーID: ${allowedUserId}`);
  } else {
    console.log("[INFO] ペアリング待ち: 最初に話しかけてきた人を持ち主として登録します");
  }
  console.log(`[INFO] codex 実行ディレクトリ: ${CODEX_CWD}`);
  console.log(`[INFO] codex 実行体: ${CODEX_BIN}`);
  const sessionState = sessionLifecycle.getState();
  console.log(
    sessionState.threadId
      ? sessionState.rotationPending
        ? "[INFO] 旧会話を次の依頼前に要約して更新します"
        : `[INFO] 保存済みのCodex会話を継続します: ${sessionState.threadId}` +
          `（依頼${sessionState.requestCount}件 / 文脈約${sessionState.contextTokens}トークン）`
      : "[INFO] 新しいCodex会話を開始します",
  );
  console.log(
    `[INFO] 自動更新: ${SESSION_POLICY.maxRequests}件 または ` +
      `${SESSION_POLICY.maxContextTokens}トークン`,
  );
  console.log(`[INFO] 引き継ぎ要約の保管先: ${HANDOFF_DIR}`);
});

/**
 * codex exec を1回実行する。
 * 入力: prompt(文字列), threadId(継続する会話ID。新規ならnull), imagePaths(画像パス配列)
 * 出力: 応答本文・会話ID・推定文脈量（Promise）
 * 実装メモ: 返答本文は --output-last-message のファイルから読む（stdoutのJSONL解析に依存しない）。
 *           会話IDと文脈量は stdout の JSONL から取り出す。
 */
function invokeCodex({ prompt, threadId, imagePaths }) {
  return new Promise((resolve, reject) => {
    const args = buildCodexArgs({
      codexCwd: CODEX_CWD,
      lastMessageFile: LAST_MSG_FILE,
      threadId,
      prompt,
      guardrail: GUARDRAIL,
      imagePaths,
    });

    // shell を介さず配列で渡すため、プロンプトによるコマンドインジェクションは起きない。
    // stdin は ignore（codex が stdin 待ちでハングするのを防ぐ）。
    const child = spawn(CODEX_BIN, args, {
      cwd: CODEX_CWD,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`タイムアウト(${CODEX_TIMEOUT_MS}ms)により中断しました`));
    }, CODEX_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(
          new Error(stderr.trim() || `codex が異常終了しました (code ${code})`),
        );
      }
      // 最終メッセージはファイルから取得（無ければ空扱い）
      let text = "";
      try {
        if (existsSync(LAST_MSG_FILE)) text = readFileSync(LAST_MSG_FILE, "utf8").trim();
      } catch {
        /* 読めなければ空のまま */
      } finally {
        try {
          rmSync(LAST_MSG_FILE, { force: true });
        } catch {
          /* 後始末失敗は無視 */
        }
      }
      resolve({
        threadId: extractThreadId(stdout),
        text: text || "(空の応答)",
        contextTokens: estimateContextTokens(stdout),
      });
    });
  });
}

/**
 * 役割: Discordの新規会話コマンドを実行する。
 * 入力: handoffまたはfresh。出力: 持ち主向け完了メッセージ。
 */
async function runSessionCommand(sessionCommand) {
  if (sessionCommand === "fresh") {
    sessionLifecycle.rotateFresh();
    return "🆕 引き継ぎなしの新しいセッションへ切り替えました。過去の会話の記録は消していません。";
  }

  try {
    const result = await sessionLifecycle.rotateWithHandoff();
    if (!result.rotated) return "ℹ️ すでに新しいセッションです。";
    return (
      `🆕 引き継ぎ要約（${result.summaryLength}文字）を作り、新しいセッションへ切り替えました。\n` +
      "前の会話の記録は消していません。" +
      (result.archivedPath ? `\n要約の保管先: ${result.archivedPath}` : "")
    );
  } catch (error) {
    if (error instanceof SessionLifecycleError) {
      console.error("[WARN] セッション更新に失敗:", error.message);
      return `⚠️ セッションを更新できませんでした。今の会話をそのまま続けます。\n理由: ${error.message}`;
    }
    throw error;
  }
}

/**
 * Discordの2000文字制限に合わせて分割送信する。
 * 入力: 返信対象message, 本文text。出力: なし（送信を行う）
 */
async function sendChunked(message, text) {
  const LIMIT = 1900;
  const body = text && text.length ? text : "(空の応答)";
  for (let i = 0; i < body.length; i += LIMIT) {
    const chunk = body.slice(i, i + LIMIT);
    if (i === 0) await message.reply(chunk);
    else await message.channel.send(chunk);
  }
}

/** 自動更新の結果を、返答の前置きにする。何も起きていなければ空文字。 */
function buildRotationNotice(rotation) {
  if (rotation.error) {
    return (
      "⚠️ セッションを更新できませんでした。今の会話をそのまま続けます。\n" +
      `理由: ${rotation.error.message}\n\n`
    );
  }
  if (rotation.rotated) {
    return (
      `♻️ 引き継ぎ要約（${rotation.summaryLength}文字）を渡して、新しいセッションに切り替えました。\n` +
      "前の会話の記録は消していません。\n\n"
    );
  }
  return "";
}

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return; // 自分や他ボットは無視

  // 診断用: 届いたメッセージを記録（原因調査が終わったら消してよい）
  console.log(
    `[MSG] guild=${message.guild?.name ?? "DM"} ch=${message.channelId} ` +
      `from=${message.author.tag}(${message.author.id}) len=${message.content?.length ?? 0} ` +
      `attachments=${message.attachments.size}`,
  );

  // まだ持ち主が未登録なら、最初に話しかけてきた本人を登録する（ペアリング）
  if (!allowedUserId) {
    allowedUserId = message.author.id;
    savePairedId(allowedUserId);
    console.log("[PAIR] 持ち主を登録しました:", allowedUserId);
    message
      .reply(
        `✅ ペアリング完了！これから、あなた専用の秘書(codex)として動きます。\nもう一度、聞きたいことを送ってみてください。`,
      )
      .catch(() => {});
    return;
  }

  if (message.author.id !== allowedUserId) return; // 許可ユーザー以外は完全無視
  const content = message.content?.trim() || "";
  const attachments = [...message.attachments.values()];
  // 対応外の添付は無視して本文だけ処理する（動画1本で依頼ごと落とさない）
  const imageAttachments = attachments.filter(isSupportedImageAttachment);
  if (!content && imageAttachments.length === 0) {
    if (attachments.length > 0) {
      message
        .reply("画像は PNG・JPEG・WebP 形式で送ってください。")
        .catch(() => {});
    }
    return;
  }
  const sessionCommand = parseSessionCommand(content);

  // 直列キューに積んで順番に処理（同時実行によるセッション競合を防ぐ）
  queue = queue.then(async () => {
    // 「入力中...」表示を維持（codexの応答は時間がかかることがある）
    await message.channel.sendTyping().catch(() => {});
    const keepTyping = setInterval(
      () => message.channel.sendTyping().catch(() => {}),
      8000,
    );
    let downloadedImages = { directoryPath: null, imagePaths: [] };
    try {
      if (sessionCommand) {
        const commandReply = await runSessionCommand(sessionCommand);
        await message.reply(commandReply);
        return;
      }

      downloadedImages = await downloadDiscordImages(
        imageAttachments,
        IMAGE_SETTINGS,
      );
      const prompt = content || DEFAULT_IMAGE_PROMPT;
      const codexResult = await sessionLifecycle.runOwnerPrompt(
        prompt,
        downloadedImages.imagePaths,
        {
          // 自動更新は数分かかることがあるので、始める前に途中経過を伝える
          onRotationStart: async (reason) => {
            await message.channel
              .send(
                `🔄 ${reason}。引き継ぎ要約を作って、新しいセッションに切り替えます…`,
              )
              .catch(() => {});
          },
        },
      );
      await sendChunked(
        message,
        buildRotationNotice(codexResult.rotation) + codexResult.text,
      );
    } catch (e) {
      const detail = String(e?.message || e).slice(0, 1800);
      await message.reply(`⚠️ エラーが発生しました:\n\`\`\`\n${detail}\n\`\`\``).catch(() => {});
      console.error("[ERROR]", e);
    } finally {
      clearInterval(keepTyping);
      try {
        cleanupDownloadedImages(downloadedImages.directoryPath);
      } catch (error) {
        console.error("[WARN] 一時画像を削除できません:", error.message);
      }
    }
  });
});

client.login(TOKEN).catch((e) => {
  console.error("[FATAL] Discordへのログインに失敗しました:", e.message);
  process.exit(1);
});
