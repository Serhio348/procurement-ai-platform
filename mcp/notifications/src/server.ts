import {
  NotificationSendRequest,
  NotificationSendResponse,
  TelegramSendRequest,
  TelegramSendResponse,
} from "@procurement/contracts";
import type { Logger } from "@procurement/observability";
import { silentLogger } from "@procurement/observability";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZodError } from "zod";
import { MemoryInboxStore } from "./inbox-store.js";
import {
  RecordingTelegramSender,
  TelegramAllowlistEmptyError,
  TelegramChatNotAllowedError,
  TelegramSendError,
  type TelegramSenderPort,
} from "./telegram-port.js";

export interface NotificationMcpServerOptions {
  inbox?: MemoryInboxStore;
  telegram?: TelegramSenderPort;
  allowedChatIds?: readonly string[];
  /** Live Bot API must set this so an empty allowlist cannot fan out. */
  requireTelegramAllowlist?: boolean;
  logger?: Logger;
  clock?: () => Date;
}

const writeIdempotent = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function createNotificationMcpServer(options: NotificationMcpServerOptions = {}): McpServer {
  const inbox =
    options.inbox ??
    new MemoryInboxStore(options.clock === undefined ? {} : { clock: options.clock });
  const telegram = options.telegram ?? new RecordingTelegramSender();
  const allowedChatIds = new Set(options.allowedChatIds ?? []);
  const requireTelegramAllowlist = options.requireTelegramAllowlist ?? false;
  const logger = options.logger ?? silentLogger;
  const clock = options.clock ?? (() => new Date());
  const telegramByDedupe = new Map<string, { messageId: string; chatId: string; deliveredAt: string }>();
  const server = new McpServer({
    name: "notification",
    version: "0.1.0",
  });

  server.registerTool(
    "notification.send",
    {
      description: "Deliver already-formed specialist copy to the in-app inbox. Dedupe by key.",
      inputSchema: NotificationSendRequest,
      outputSchema: NotificationSendResponse,
      annotations: writeIdempotent,
    },
    async (input, extra) =>
      executeTool("notification.send", logger, correlationId(extra), () => {
        const request = NotificationSendRequest.parse(input);
        const { item, duplicate } = inbox.send(request);
        return NotificationSendResponse.parse({
          id: item.id,
          channel: "inbox",
          duplicate,
          deliveredAt: item.deliveredAt,
        });
      }),
  );

  server.registerTool(
    "telegram.send",
    {
      description: "Send already-formed text to an allowed Telegram chat. Dedupe by chat and key.",
      inputSchema: TelegramSendRequest,
      outputSchema: TelegramSendResponse,
      annotations: writeIdempotent,
    },
    async (input, extra) =>
      executeTool("telegram.send", logger, correlationId(extra), async () => {
        const request = TelegramSendRequest.parse(input);
        if (requireTelegramAllowlist && allowedChatIds.size === 0) {
          throw new TelegramAllowlistEmptyError();
        }
        if (allowedChatIds.size > 0 && !allowedChatIds.has(request.chatId)) {
          throw new TelegramChatNotAllowedError(request.chatId);
        }
        const dedupeKey = `${request.chatId}:${request.dedupeKey}`;
        const existing = telegramByDedupe.get(dedupeKey);
        if (existing !== undefined) {
          return TelegramSendResponse.parse({
            messageId: existing.messageId,
            chatId: existing.chatId,
            duplicate: true,
            deliveredAt: existing.deliveredAt,
          });
        }
        const sent = await telegram.send({ chatId: request.chatId, text: request.text });
        const deliveredAt = clock().toISOString();
        telegramByDedupe.set(dedupeKey, {
          messageId: sent.messageId,
          chatId: request.chatId,
          deliveredAt,
        });
        return TelegramSendResponse.parse({
          messageId: sent.messageId,
          chatId: request.chatId,
          duplicate: false,
          deliveredAt,
        });
      }),
  );

  return server;
}

const executeTool = async <Output extends Record<string, unknown>>(
  toolName: string,
  logger: Logger,
  requestId: string,
  operation: () => Output | Promise<Output>,
) => {
  const toolLogger = logger.child({
    requestId,
    toolName,
    component: "notifications-mcp",
  });
  const startedAt = Date.now();
  try {
    const output = await operation();
    toolLogger.info("Notification tool completed", { durationMs: Date.now() - startedAt });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output) }],
      structuredContent: output,
    };
  } catch (error) {
    toolLogger.error("Notification tool failed", error, { durationMs: Date.now() - startedAt });
    return {
      content: [{ type: "text" as const, text: publicErrorMessage(error) }],
      isError: true,
      _meta: { errorKind: classifyError(error) },
    };
  }
};

function correlationId(extra: { _meta?: Record<string, unknown>; requestId: string | number }): string {
  const requestId = extra._meta?.["requestId"];
  return typeof requestId === "string" && requestId.length > 0
    ? requestId
    : String(extra.requestId);
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Notification tool failed";
}

function classifyError(
  error: unknown,
): "not_found" | "source_unavailable" | "invalid_request" | "internal" {
  if (
    error instanceof TelegramChatNotAllowedError ||
    error instanceof TelegramAllowlistEmptyError ||
    error instanceof ZodError
  ) {
    return "invalid_request";
  }
  if (error instanceof TelegramSendError) return "source_unavailable";
  return "internal";
}
