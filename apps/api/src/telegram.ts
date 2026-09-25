import { randomBytes } from "node:crypto";
import type { InboxFixtureItem as InboxFixtureItemValue } from "@procurement/contracts";
import { compileChangeAlert, compileTelegramText } from "@procurement/domain";
import type { Logger } from "@procurement/observability";
import type { TelegramLink, TelegramStore } from "@procurement/db";

/**
 * Specialist Telegram bot: announces inbox events and answers commands.
 * Delivery is at-most-once per (workspace, event) — the console inbox stays
 * the durable list, the chat is a heads-up, not a second source of truth.
 */

export interface TelegramButton {
  text: string;
  url?: string;
  callbackData?: string;
}

export interface TelegramUpdate {
  updateId: number;
  message?: {
    chatId: string;
    text: string;
    username?: string;
  };
  callbackQuery?: {
    id: string;
    chatId: string;
    data: string;
  };
}

/** Bot API surface — a stub in tests records the calls. */
export interface TelegramBot {
  getMe(): Promise<{ username: string }>;
  getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]>;
  sendMessage(input: { chatId: string; text: string; buttons?: TelegramButton[] }): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
}

const TELEGRAM_API = "https://api.telegram.org";
const LINK_CODE_TTL_MS = 10 * 60_000;
/** keep the callback payload short: "d:<changeId>" */
const DISMISS_PREFIX = "d:";

async function callBot(token: string, method: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(35_000),
  });
  const parsed = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
    result?: unknown;
  };
  if (!response.ok || parsed.ok !== true) {
    throw new Error(`Telegram ${method} failed: ${parsed.description ?? `HTTP ${response.status}`}`);
  }
  return parsed.result;
}

export function createTelegramBot(token: string): TelegramBot {
  const row = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  return {
    async getMe() {
      const result = row(await callBot(token, "getMe", {}));
      const username = text(result?.["username"]);
      if (username === undefined) throw new Error("Telegram getMe returned no username");
      return { username };
    },
    async getUpdates(offset, timeoutSec) {
      const result = await callBot(token, "getUpdates", {
        offset,
        timeout: timeoutSec,
        allowed_updates: ["message", "callback_query"],
      });
      if (!Array.isArray(result)) return [];
      const updates: TelegramUpdate[] = [];
      for (const raw of result) {
        const update = row(raw);
        const updateId = update?.["update_id"];
        if (update === undefined || typeof updateId !== "number") continue;
        const message = row(update["message"]);
        const callback = row(update["callback_query"]);
        const callbackMessage = row(callback?.["message"]);
        const from = row(message?.["from"]) ?? row(callback?.["from"]);
        const chat = row(message?.["chat"]) ?? row(callbackMessage?.["chat"]);
        const out: TelegramUpdate = { updateId };
        if (message !== undefined) {
          const chatId = chat?.["id"];
          const msgText = text(message["text"]);
          const username = text(from?.["username"]);
          if (typeof chatId === "number" && msgText !== undefined) {
            out.message = {
              chatId: String(chatId),
              text: msgText,
              ...(username === undefined ? {} : { username }),
            };
          }
        }
        if (callback !== undefined) {
          const data = text(callback["data"]);
          const id = text(callback["id"]);
          const chatId = chat?.["id"];
          if (id !== undefined && data !== undefined && typeof chatId === "number") {
            out.callbackQuery = { id, chatId: String(chatId), data };
          }
        }
        updates.push(out);
      }
      return updates;
    },
    async sendMessage(input) {
      await callBot(token, "sendMessage", {
        chat_id: input.chatId,
        text: input.text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(input.buttons === undefined || input.buttons.length === 0
          ? {}
          : {
              reply_markup: {
                inline_keyboard: [
                  input.buttons.map((button) => ({
                    text: button.text,
                    ...(button.url === undefined ? {} : { url: button.url }),
                    ...(button.callbackData === undefined
                      ? {}
                      : { callback_data: button.callbackData }),
                  })),
                ],
              },
            }),
      });
    },
    async answerCallbackQuery(id, answerText) {
      await callBot(token, "answerCallbackQuery", {
        callback_query_id: id,
        ...(answerText === undefined ? {} : { text: answerText }),
      });
    },
  };
}

export function createTelegramBotFromEnv(env: NodeJS.ProcessEnv): TelegramBot | undefined {
  const token = env["TELEGRAM_BOT_TOKEN"]?.trim() ?? "";
  return token.length === 0 ? undefined : createTelegramBot(token);
}

export interface TelegramNotifierOptions {
  bot: TelegramBot;
  store: TelegramStore;
  logger: Logger;
  /** Console base URL for the «Открыть» button — plain http is fine for a link. */
  publicUrl: string;
  botUsername?: string;
  /** Used by «/new» and the dismiss button; absent in fixture-only tests. */
  openCabinet?: (userId: string) => Promise<{
    workspaceId: string;
    inbox: { id: string; title: string; statusLabel: string; detail: string; url: string }[];
    dismiss(id: string): Promise<boolean>;
  } | undefined>;
}

export interface TelegramNotifier {
  botUsername(): string | undefined;
  status(userId: string): Promise<{ linked: boolean; username?: string; mode?: string }>;
  createLinkCode(userId: string): Promise<{ code: string; url?: string; expiresInSec: number }>;
  unlink(userId: string): Promise<void>;
  setMode(userId: string, mode: "all" | "urgent"): Promise<void>;
  /** Called when a new inbox event is recorded; never throws into the caller. */
  notifyInbox(workspaceId: string, item: InboxFixtureItemValue): Promise<void>;
  handleUpdate(update: TelegramUpdate): Promise<void>;
  pollOnce(offset: number): Promise<number>;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function formatInboxMessage(
  item: InboxFixtureItemValue,
  publicUrl: string,
): { text: string; buttons: TelegramButton[] } {
  const compiled = compileChangeAlert([item.change], {
    title: item.procurement.title,
    sourceProcurementId: item.procurement.sourceProcurementId,
    url: item.procurement.url,
  });
  const body = compiled?.body ?? item.procurement.title;
  return {
    text: compileTelegramText(
      `<b>${escapeHtml(compiled?.title ?? item.procurement.title)}</b>`,
      escapeHtml(body),
    ),
    buttons: [
      { text: "Открыть в консоли", url: publicUrl.replace(/\/$/, "") || publicUrl },
      { text: "Разобрано", callbackData: `${DISMISS_PREFIX}${item.change.id}` },
    ],
  };
}

export function createTelegramNotifier(options: TelegramNotifierOptions): TelegramNotifier {
  const { bot, store, logger } = options;
  const publicUrl = options.publicUrl.replace(/\/$/, "");

  const safeSend = async (
    link: TelegramLink,
    input: { text: string; buttons?: TelegramButton[] },
  ): Promise<void> => {
    try {
      await bot.sendMessage({ chatId: link.chatId, ...input });
    } catch (error) {
      logger.error("Telegram send failed", error, { chatId: link.chatId });
    }
  };

  const welcomeText =
    "Telegram подключён. Сюда будут приходить новые закупки и изменения по отслеживаемым.\n" +
    "Команды: /new — открытые события, /status — сводка, /urgent — только срочные, /all — все события, /stop — отключить.";

  const handleMessage = async (message: {
    chatId: string;
    text: string;
    username?: string;
  }): Promise<void> => {
    const [command = "", ...rest] = message.text.trim().split(/\s+/u);
    const verb = command.split("@")[0]?.toLowerCase() ?? "";
    if (verb === "/start") {
      const code = rest[0]?.trim() ?? "";
      const link = await store.consumeLinkCode(code);
      if (code.length === 0 || link === undefined) {
        await bot.sendMessage({
          chatId: message.chatId,
          text: "Это бот платформы закупок. Чтобы подключить уведомления, откройте консоль → Профили → «Подключить Telegram» и перейдите по ссылке.",
        });
        return;
      }
      await store.upsertLink({
        userId: link,
        chatId: message.chatId,
        ...(message.username === undefined ? {} : { username: message.username }),
      });
      await bot.sendMessage({ chatId: message.chatId, text: welcomeText });
      return;
    }
    const link = await store.linkByChat(message.chatId);
    if (link === undefined) {
      await bot.sendMessage({
        chatId: message.chatId,
        text: "Сначала подключите чат в консоли: Профили → «Подключить Telegram».",
      });
      return;
    }
    switch (verb) {
      case "/stop": {
        await store.deleteLink(link.userId);
        await bot.sendMessage({ chatId: message.chatId, text: "Уведомления отключены." });
        return;
      }
      case "/urgent": {
        await store.setMode(link.userId, "urgent");
        await bot.sendMessage({
          chatId: message.chatId,
          text: "Режим «только срочные»: приходят дедлайны и изменения отслеживаемых.",
        });
        return;
      }
      case "/all": {
        await store.setMode(link.userId, "all");
        await bot.sendMessage({
          chatId: message.chatId,
          text: "Режим «все события»: приходят и новые закупки, и изменения.",
        });
        return;
      }
      case "/new": {
        const cabinet = await options.openCabinet?.(link.userId);
        if (cabinet === undefined) {
          await bot.sendMessage({ chatId: message.chatId, text: "Кабинет недоступен." });
          return;
        }
        const items = cabinet.inbox.slice(0, 5);
        if (items.length === 0) {
          await bot.sendMessage({ chatId: message.chatId, text: "Открытых событий нет." });
          return;
        }
        for (const entry of items) {
          await bot.sendMessage({
            chatId: message.chatId,
            text: `<b>${escapeHtml(entry.statusLabel)}</b>\n${escapeHtml(entry.title)}\n${escapeHtml(entry.detail).slice(0, 300)}`,
            buttons: [
              { text: "Открыть в консоли", url: publicUrl },
              { text: "Разобрано", callbackData: `${DISMISS_PREFIX}${entry.id}` },
            ],
          });
        }
        return;
      }
      case "/status": {
        const cabinet = await options.openCabinet?.(link.userId);
        if (cabinet === undefined) {
          await bot.sendMessage({ chatId: message.chatId, text: "Кабинет недоступен." });
          return;
        }
        await bot.sendMessage({
          chatId: message.chatId,
          text: `Открытых событий во входящих: ${cabinet.inbox.length}. Консоль: ${publicUrl}`,
        });
        return;
      }
      case "/help":
      case "/start_": {
        await bot.sendMessage({ chatId: message.chatId, text: welcomeText });
        return;
      }
      default: {
        await bot.sendMessage({
          chatId: message.chatId,
          text: "Команды: /new — открытые события, /status — сводка, /urgent — только срочные, /all — все, /stop — отключить.",
        });
      }
    }
  };

  const notifier: TelegramNotifier = {
    botUsername: () => options.botUsername,
    async status(userId) {
      const link = await store.linkForUser(userId);
      if (link === undefined) return { linked: false };
      return {
        linked: true,
        ...(link.username === undefined ? {} : { username: link.username }),
        mode: link.mode,
      };
    },
    async createLinkCode(userId) {
      const code = randomBytes(8).toString("hex");
      await store.createLinkCode({
        userId,
        code,
        expiresAt: new Date(Date.now() + LINK_CODE_TTL_MS),
      });
      const bot = options.botUsername;
      return {
        code,
        ...(bot === undefined ? {} : { url: `https://t.me/${bot}?start=${code}` }),
        expiresInSec: Math.floor(LINK_CODE_TTL_MS / 1000),
      };
    },
    async unlink(userId) {
      await store.deleteLink(userId);
    },
    async setMode(userId, mode) {
      await store.setMode(userId, mode);
    },
    async notifyInbox(workspaceId, item) {
      try {
        const link = await store.linkForWorkspace(workspaceId);
        if (link === undefined) return;
        if (link.mode === "urgent" && item.change.urgent !== true) return;
        // Dedupe first: a restart between send and mark must not spam, so the
        // marker is written before the network call.
        const fresh = await store.markSent(workspaceId, item.change.id);
        if (!fresh) return;
        const message = formatInboxMessage(item, publicUrl);
        await safeSend(link, message);
      } catch (error) {
        logger.error("Telegram notify failed", error, { workspaceId });
      }
    },
    async handleUpdate(update) {
      try {
        if (update.message !== undefined) await handleMessage(update.message);
        if (update.callbackQuery !== undefined) {
          const { id, chatId, data } = update.callbackQuery;
          if (data.startsWith(DISMISS_PREFIX)) {
            const eventId = data.slice(DISMISS_PREFIX.length);
            const link = await store.linkByChat(chatId);
            const cabinet = link === undefined ? undefined : await options.openCabinet?.(link.userId);
            const done = cabinet === undefined ? false : await cabinet.dismiss(eventId);
            await bot.answerCallbackQuery(id, done ? "Событие закрыто" : "Событие уже закрыто");
          } else {
            await bot.answerCallbackQuery(id);
          }
        }
      } catch (error) {
        logger.error("Telegram update failed", error, { updateId: update.updateId });
      }
    },
    async pollOnce(offset) {
      const updates = await bot.getUpdates(offset, 25);
      let next = offset;
      for (const update of updates) {
        await notifier.handleUpdate(update);
        next = update.updateId + 1;
      }
      return next;
    },
  };

  return notifier;
}

/** In-memory TelegramStore: fixture mode and unit tests without postgres. */
export function createMemoryTelegramStore(): TelegramStore & {
  seedWorkspaceLink(workspaceId: string, userId: string): void;
} {
  const links = new Map<string, TelegramLink>();
  const codes = new Map<string, { userId: string; expiresAt: number }>();
  const sent = new Set<string>();
  const workspaceUsers = new Map<string, string>();
  return {
    seedWorkspaceLink(workspaceId, userId) {
      workspaceUsers.set(workspaceId, userId);
    },
    async linkForUser(userId) {
      return links.get(userId);
    },
    async linkByChat(chatId) {
      for (const link of links.values()) if (link.chatId === chatId) return link;
      return undefined;
    },
    async linkForWorkspace(workspaceId) {
      const userId = workspaceUsers.get(workspaceId);
      return userId === undefined ? undefined : links.get(userId);
    },
    async upsertLink(input) {
      for (const [key, link] of links) {
        if (link.chatId === input.chatId && key !== input.userId) links.delete(key);
      }
      links.set(input.userId, {
        userId: input.userId,
        chatId: input.chatId,
        username: input.username,
        mode: links.get(input.userId)?.mode ?? "all",
      });
    },
    async deleteLink(userId) {
      links.delete(userId);
    },
    async setMode(userId, mode) {
      const link = links.get(userId);
      if (link !== undefined) links.set(userId, { ...link, mode });
    },
    async createLinkCode(input) {
      codes.set(input.code, { userId: input.userId, expiresAt: input.expiresAt.getTime() });
    },
    async consumeLinkCode(code) {
      const entry = codes.get(code);
      codes.delete(code);
      if (entry === undefined || entry.expiresAt < Date.now()) return undefined;
      return entry.userId;
    },
    async markSent(workspaceId, eventKey) {
      const key = `${workspaceId}:${eventKey}`;
      if (sent.has(key)) return false;
      sent.add(key);
      return true;
    },
  };
}
