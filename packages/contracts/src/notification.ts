import { z } from "zod";
import { IsoDateTime } from "./common.js";
import { NotificationId, ProcurementId } from "./ids.js";
import { ChangeEvent } from "./procurement.js";

export const NotificationUrgency = z.enum(["normal", "urgent"]);
export type NotificationUrgency = z.infer<typeof NotificationUrgency>;

export const NotificationChannel = z.enum(["inbox", "telegram"]);
export type NotificationChannel = z.infer<typeof NotificationChannel>;

export const NotificationSendRequest = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(20_000),
    urgency: NotificationUrgency.default("normal"),
    procurementId: ProcurementId.optional(),
    dedupeKey: z.string().min(1).max(255),
  })
  .strict();
export type NotificationSendRequest = z.infer<typeof NotificationSendRequest>;

export const NotificationSendResponse = z.object({
  id: NotificationId,
  channel: z.literal("inbox"),
  duplicate: z.boolean(),
  deliveredAt: IsoDateTime,
});
export type NotificationSendResponse = z.infer<typeof NotificationSendResponse>;

/** Telegram Bot API hard limit for sendMessage text. Truncate in domain code. */
export const TELEGRAM_MAX_TEXT_LENGTH = 4096;

export const TelegramSendRequest = z
  .object({
    chatId: z.string().min(1).max(64),
    text: z.string().min(1).max(TELEGRAM_MAX_TEXT_LENGTH),
    urgency: NotificationUrgency.default("normal"),
    dedupeKey: z.string().min(1).max(255),
  })
  .strict();
export type TelegramSendRequest = z.infer<typeof TelegramSendRequest>;

export const TelegramSendResponse = z.object({
  messageId: z.string().min(1),
  chatId: z.string().min(1),
  duplicate: z.boolean(),
  deliveredAt: IsoDateTime,
});
export type TelegramSendResponse = z.infer<typeof TelegramSendResponse>;

/**
 * Already-formed specialist copy, or ChangeEvents the domain may render.
 * The agent never asks a model to rewrite this text.
 */
export const NotificationInput = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(20_000).optional(),
  urgent: z.boolean().optional(),
  telegramChatIds: z.array(z.string().min(1).max(64)).default([]),
  dedupeKey: z.string().min(1).max(255).optional(),
  changes: z.array(ChangeEvent).default([]),
});
export type NotificationInput = z.infer<typeof NotificationInput>;

export const NotificationDelivery = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("inbox"),
    destination: z.literal("inbox"),
    notificationId: NotificationId,
    duplicate: z.boolean(),
  }),
  z.object({
    channel: z.literal("telegram"),
    destination: z.string().min(1),
    messageId: z.string().min(1),
    duplicate: z.boolean(),
  }),
]);
export type NotificationDelivery = z.infer<typeof NotificationDelivery>;

export const NotificationSkipReason = z.enum(["not_urgent", "no_chat_ids", "tool_not_allowed"]);
export type NotificationSkipReason = z.infer<typeof NotificationSkipReason>;

export const NotificationSkipped = z.object({
  channel: z.literal("telegram"),
  reason: NotificationSkipReason,
});
export type NotificationSkipped = z.infer<typeof NotificationSkipped>;

export const NotificationOutput = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  urgent: z.boolean(),
  deliveries: z.array(NotificationDelivery).min(1),
  skipped: z.array(NotificationSkipped).default([]),
  deliveredAt: IsoDateTime,
});
export type NotificationOutput = z.infer<typeof NotificationOutput>;
