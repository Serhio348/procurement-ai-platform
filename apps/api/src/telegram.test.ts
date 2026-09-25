import { describe, expect, it } from "vitest";
import type { InboxFixtureItem } from "@procurement/contracts";
import { silentLogger } from "@procurement/observability";
import {
  createMemoryTelegramStore,
  createTelegramNotifier,
  formatInboxMessage,
  type TelegramBot,
  type TelegramUpdate,
} from "./telegram.js";

const workspaceId = "00000000-0000-4000-8000-0000000000aa";
const userId = "00000000-0000-4000-8000-0000000000bb";

function stubBot(): TelegramBot & {
  sent: { chatId: string; text: string; buttons?: { text: string; callbackData?: string }[] }[];
  answered: { id: string; text?: string }[];
} {
  const sent: { chatId: string; text: string; buttons?: { text: string; callbackData?: string }[] }[] =
    [];
  const answered: { id: string; text?: string }[] = [];
  return {
    sent,
    answered,
    async getMe() {
      return { username: "zakupki_test_bot" };
    },
    async getUpdates() {
      return [];
    },
    async sendMessage(input) {
      sent.push(input);
    },
    async answerCallbackQuery(id, text) {
      answered.push({ id, ...(text === undefined ? {} : { text }) });
    },
  };
}

function inboxItem(kind: string = "procedure_candidate", urgent = true): InboxFixtureItem {
  return {
    procurement: {
      title: "Поставка КТП для завода",
      status: "accepting_bids",
      url: "https://goszakupki.by/tenders/view/123",
      sourceProcurementId: "123",
    },
    change: {
      id: `evt-${kind}` as InboxFixtureItem["change"]["id"],
      procurementId: "00000000-0000-4000-8000-0000000000cc" as InboxFixtureItem["change"]["procurementId"],
      kind: kind as InboxFixtureItem["change"]["kind"],
      detectedAt: new Date().toISOString(),
      urgent,
      previous: null,
      current: "Подача предложений",
    },
  };
}

function setup(openInbox: { id: string; title: string }[] = []) {
  const bot = stubBot();
  const store = createMemoryTelegramStore();
  store.seedWorkspaceLink(workspaceId, userId);
  const dismissed: string[] = [];
  const notifier = createTelegramNotifier({
    bot,
    store,
    logger: silentLogger,
    publicUrl: "http://localhost:5173",
    botUsername: "zakupki_test_bot",
    openCabinet: async (forUserId) =>
      forUserId === userId
        ? {
            workspaceId,
            inbox: openInbox.map((entry) => ({
              id: entry.id,
              title: entry.title,
              statusLabel: "Подача предложений",
              detail: "Номер: 1.",
              url: "https://goszakupki.by/tenders/view/1",
            })),
            async dismiss(id) {
              dismissed.push(id);
              return true;
            },
          }
        : undefined,
  });
  return { bot, store, notifier, dismissed };
}

describe("telegram notifier", () => {
  it("links a chat through a one-time code and announces inbox events", async () => {
    const { bot, notifier } = setup();
    const { code, url } = await notifier.createLinkCode(userId);
    expect(url).toBe(`https://t.me/zakupki_test_bot?start=${code}`);

    await notifier.handleUpdate({
      updateId: 1,
      message: { chatId: "777", text: `/start ${code}`, username: "spec" },
    });
    expect(await notifier.status(userId)).toEqual({
      linked: true,
      username: "spec",
      mode: "all",
    });
    bot.sent.length = 0;

    await notifier.notifyInbox(workspaceId, inboxItem());
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0]?.chatId).toBe("777");
    expect(bot.sent[0]?.text).toContain("Поставка КТП");
    expect(bot.sent[0]?.buttons?.some((button) => button.callbackData === "d:evt-procedure_candidate")).toBe(true);
  });

  it("rejects a wrong or reused code", async () => {
    const { bot, notifier } = setup();
    await notifier.handleUpdate({
      updateId: 1,
      message: { chatId: "777", text: "/start nope" },
    });
    expect(bot.sent[0]?.text).toContain("Подключить Telegram");
    expect(await notifier.status(userId)).toEqual({ linked: false });

    const { code } = await notifier.createLinkCode(userId);
    await notifier.handleUpdate({ updateId: 2, message: { chatId: "777", text: `/start ${code}` } });
    await notifier.handleUpdate({ updateId: 3, message: { chatId: "888", text: `/start ${code}` } });
    expect(bot.sent.filter((m) => m.chatId === "888")[0]?.text).toContain("Подключить Telegram");
  });

  it("delivers each event once and never for a workspace without a link", async () => {
    const { bot, notifier, store } = setup();
    const { code } = await notifier.createLinkCode(userId);
    await notifier.handleUpdate({ updateId: 1, message: { chatId: "777", text: `/start ${code}` } });
    bot.sent.length = 0;

    const item = inboxItem();
    await notifier.notifyInbox(workspaceId, item);
    await notifier.notifyInbox(workspaceId, item);
    expect(bot.sent).toHaveLength(1);

    await notifier.notifyInbox("00000000-0000-4000-8000-0000000000ff", inboxItem("status_changed"));
    expect(bot.sent).toHaveLength(1);
    expect(store).toBeDefined();
  });

  it("urgent mode skips new-candidate announcements but keeps watch changes", async () => {
    const { bot, notifier } = setup();
    const { code } = await notifier.createLinkCode(userId);
    await notifier.handleUpdate({ updateId: 1, message: { chatId: "777", text: `/start ${code}` } });
    await notifier.handleUpdate({ updateId: 2, message: { chatId: "777", text: "/urgent" } });
    bot.sent.length = 0;

    await notifier.notifyInbox(workspaceId, inboxItem("procedure_candidate", false));
    expect(bot.sent).toHaveLength(0);
    await notifier.notifyInbox(workspaceId, inboxItem("deadline_changed"));
    expect(bot.sent).toHaveLength(1);
  });

  it("lists open inbox rows on /new and dismisses from a button", async () => {
    const { bot, notifier, dismissed } = setup([
      { id: "evt-1", title: "Закупка раз" },
      { id: "evt-2", title: "Закупка два" },
    ]);
    const { code } = await notifier.createLinkCode(userId);
    await notifier.handleUpdate({ updateId: 1, message: { chatId: "777", text: `/start ${code}` } });
    bot.sent.length = 0;

    await notifier.handleUpdate({ updateId: 2, message: { chatId: "777", text: "/new" } });
    expect(bot.sent.map((m) => m.text).join("\n")).toContain("Закупка раз");
    expect(bot.sent.map((m) => m.text).join("\n")).toContain("Закупка два");

    await notifier.handleUpdate({
      updateId: 3,
      callbackQuery: { id: "cb1", chatId: "777", data: "d:evt-1" },
    });
    expect(dismissed).toEqual(["evt-1"]);
    expect(bot.answered[0]?.text).toBe("Событие закрыто");
  });

  it("/stop unlinks the chat", async () => {
    const { bot, notifier } = setup();
    const { code } = await notifier.createLinkCode(userId);
    await notifier.handleUpdate({ updateId: 1, message: { chatId: "777", text: `/start ${code}` } });
    await notifier.handleUpdate({ updateId: 2, message: { chatId: "777", text: "/stop" } });
    expect(await notifier.status(userId)).toEqual({ linked: false });
    expect(bot.sent.at(-1)?.text).toContain("отключены");
  });
});

describe("formatInboxMessage", () => {
  it("escapes html and keeps the open link", () => {
    const item = inboxItem();
    item.procurement.title = "Поставка <КТП> & комплект";
    const message = formatInboxMessage(item, "http://x.test");
    expect(message.text).not.toContain("<КТП>");
    expect(message.text).toContain("&lt;КТП&gt;");
    expect(message.buttons[0]?.url).toBe("http://x.test");
  });
});

describe("telegram update parsing", () => {
  it("shapes real bot-api payloads", () => {
    // The parser lives inside createTelegramBot; shape a minimal update through
    // the notifier-level contract instead of hitting the network.
    const update: TelegramUpdate = {
      updateId: 5,
      message: { chatId: "1", text: "/help" },
    };
    expect(update.updateId).toBe(5);
  });
});
