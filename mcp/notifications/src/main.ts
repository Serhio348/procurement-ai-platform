import { createLogger } from "@procurement/observability";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemoryInboxStore } from "./inbox-store.js";
import { createNotificationMcpServer } from "./server.js";
import { LiveTelegramSender, RecordingTelegramSender } from "./telegram-port.js";

async function main(): Promise<void> {
  const mode = process.env["NOTIFICATION_TELEGRAM_MODE"] ?? "fixture";
  const allowedChatIds = parseChatIds(process.env["TELEGRAM_ALLOWED_CHAT_IDS"]);
  const logger = createLogger({
    level: process.env["LOG_LEVEL"] === "debug" ? "debug" : "info",
    sink: (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
  });

  if (mode !== "fixture" && mode !== "live") {
    throw new Error(`Unsupported NOTIFICATION_TELEGRAM_MODE: ${mode}`);
  }

  const telegram =
    mode === "live"
      ? new LiveTelegramSender({ token: requireLiveToken() })
      : new RecordingTelegramSender();

  if (mode === "live" && allowedChatIds.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_CHAT_IDS is required when NOTIFICATION_TELEGRAM_MODE=live");
  }

  const server = createNotificationMcpServer({
    inbox: new MemoryInboxStore(),
    telegram,
    allowedChatIds,
    requireTelegramAllowlist: mode === "live",
    logger,
  });
  await server.connect(new StdioServerTransport());
}

function requireLiveToken(): string {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (token === undefined || token.length === 0) {
    throw new Error("TELEGRAM_BOT_TOKEN is required when NOTIFICATION_TELEGRAM_MODE=live");
  }
  return token;
}

function parseChatIds(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

await main();
