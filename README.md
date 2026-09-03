# codex-discord-bot

スマホのDiscordから **codex（OpenAI Codex CLI）** を呼べるAI秘書ボット。
`~/claude-discord-bot`（claude版）と同じ構図で、呼び出し先を `codex exec` に置き換えたもの。

## Context（役割）
- **役割**: Discord ⇄ codex CLI の薄い中継。ビジネスロジックは持たない
- **やること**: 持ち主のDiscordメッセージと添付画像を `codex exec` に渡し、最終メッセージをDiscordへ返す
- **やらないこと**: 持ち主以外への応答／取り消せない操作の無確認実行（歯止めをプロンプトに注入）

## 仕組み
```
スマホDiscord → Discord(クラウド) → このMacの bot.js → codex exec → 応答 → Discordへ返信
```
- 実行体は **ChatGPT.app 同梱の codex-cli**（`/Applications/ChatGPT.app/Contents/Resources/codex`。PATH未通のためフルパス指定）
- 1手目: `codex -C <CWD> exec --json --dangerously-bypass-approvals-and-sandbox -o <tmp> "<歯止め>+<本文>"`
- 2手目以降: `codex -C <CWD> exec resume <thread_id> …`（`thread.started` イベントから拾ったIDで文脈継続）
- 会話IDは `conversation.json` に保存し、BotやMacの再起動後も同じ会話を継続
- 返答本文は `--output-last-message`（`-o`）のファイルから取得（stdoutのJSONL解析に依存しない）
- 添付画像はCodex CLIの `--image` へ渡す。画像だけの投稿にも対応
- 画像はDiscord公式CDNから一時保存し、応答後に一時コピーを削除

## Structure（構成）
| ファイル | 責務 |
|---|---|
| `bot.js` | 本体。Discord受信 → codex実行 → 返信。ペアリング・許可ユーザー判定・直列キュー・分割送信 |
| `codex-command.js` | 現行Codex CLIに合う新規・継続コマンドの組み立て |
| `codex-response.js` | codex出力(stdout)からの会話ID・文脈量の抽出、再試行判定 |
| `session-policy.js` | 新規会話コマンド、自動更新の閾値、引き継ぎ文面 |
| `session-lifecycle.js` | 要約作成、新旧セッションの切替、利用量の更新 |
| `conversation-store.js` | Codex会話ID・会話数・文脈量・要約の保存と復元。再起動後の会話継続を担当 |
| `discord-images.js` | Discord添付画像の検証・取得・一時保存・後始末 |
| `test/codex-command.test.js` | 会話継続コマンドの引数順と初回安全指示のテスト |
| `test/codex-response.test.js` | 会話ID・文脈量の抽出と再試行判定のテスト |
| `test/session-policy.test.js` | コマンド判定・閾値・引き継ぎ文面のテスト |
| `test/session-lifecycle.test.js` | 継続・自動更新・手動更新・再試行のテスト |
| `test/conversation-store.test.js` | 会話状態の保存・復元・旧形式移行・異常系のテスト |
| `test/discord-images.test.js` | 画像取得・形式検証・容量制限・後始末のテスト |
| `.env` | 秘密設定（トークン等）。gitignore済み。雛形は `.env.example` |
| `paired.json` | 持ち主のDiscordユーザーID記憶（初回メッセージで自動登録） |
| `conversation.json` | Codex会話IDの記憶（自動生成・gitignore済み） |
| `com.cocoa-m3.codex-discord-bot.plist` | launchd用（ログイン時自動起動・クラッシュ復活） |
| `bot.log` | 標準出力/エラーのログ |

## セットアップ
1. `.env.example` を `.env` にコピーし、`DISCORD_TOKEN` に **codex用Discordアプリ**（アプリID `1541825962851835934`）のBotトークンを貼る
   - Discord Developer Portal の該当アプリ → **Bot** → **MESSAGE CONTENT INTENT を ON**（必須）
   - `chmod 600 .env`
2. 依存導入（導入済みなら不要）: `npm install`
3. 手動起動テスト: `node bot.js` → ログに `[READY] …としてログインしました` が出ればOK
4. スマホからBotにDMして応答を確認

## セッションの更新

- Discordで `!new` と送ると、現在の会話を3,000文字以内へ要約し、新しい会話へ切り替える。
- `!new fresh` は引き継ぎなしで切り替える。旧会話ログ自体は削除しない。
- 持ち主の依頼20件、または推定文脈量20万トークンへ到達すると、次の依頼前に自動更新する。
- 新しい会話へ渡す過去情報は引き継ぎ要約だけ。パスワード・APIキー・Botトークン・画像データを要約へ含めないようcodexへ明示する。
- 要約作成に失敗した場合は旧会話を維持し、履歴なしで勝手に切り替えない。
- 旧形式の `conversation.json`（会話IDのみ）は、そのまま会話を継続する（強制的な要約更新はしない）。

閾値は `.env` の `CODEX_SESSION_MAX_REQUESTS`、
`CODEX_SESSION_MAX_CONTEXT_TOKENS`、`CODEX_HANDOFF_MAX_CHARS` で変更できます。
文脈量による自動更新は、codexの出力からトークン量を取得できた場合のみ働きます（取得できないときは依頼件数のみで判定）。

## 画像添付

- 対応形式: PNG、JPEG、WebP
- 既定上限: 1投稿4枚、1枚10MB、取得15秒
- 本文＋画像、画像だけのどちらも対応
- 上限は `.env` の `DISCORD_IMAGE_MAX_COUNT`、`DISCORD_IMAGE_MAX_BYTES`、`DISCORD_IMAGE_TIMEOUT_MS` で変更可能
- Discord公式CDN以外のURLや、拡張子を偽装したファイルは拒否する
- 解析用の一時コピーは応答後に削除する。Discord上の元画像は削除しない

## テスト
```bash
npm test
```

## 常駐化（自動起動）
```bash
cp com.cocoa-m3.codex-discord-bot.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.cocoa-m3.codex-discord-bot.plist
```

## 運用コマンド
| やること | コマンド |
|---|---|
| 稼働確認 | `launchctl list \| grep codex-discord-bot` |
| ログ監視 | `tail -f ~/codex-discord-bot/bot.log` |
| 停止 | `launchctl unload ~/Library/LaunchAgents/com.cocoa-m3.codex-discord-bot.plist` |
| 起動 | `launchctl load -w ~/Library/LaunchAgents/com.cocoa-m3.codex-discord-bot.plist` |
| コード反映 | 上の unload→load |

## 注意
- claude版とは **別のDiscordアプリ/トークン**を使う（同一トークンで2プロセスは同時ログイン不可のため）
- フルモード（`--dangerously-bypass-approvals-and-sandbox`）で動くため、防御線は `ALLOWED_USER_ID` のみ。トークンは絶対に共有しない
- このMacが起動＆ログイン中のときだけ応答する（スリープ/シャットダウン中は不可）
