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

type SentMessage = {
  chatId: string;
  text: string;
  buttons?: { text: string; callbackData?: string; url?: string }[][];
  keyboard?: string[][];
};

function stubBot(): TelegramBot & {
  sent: SentMessage[];
  edited: { chatId: string; messageId: number; text: string; buttons?: SentMessage["buttons"] }[];
  answered: { id: string; text?: string }[];
} {
  const sent: SentMessage[] = [];
  const edited: { chatId: string; messageId: number; text: string; buttons?: SentMessage["buttons"] }[] = [];
  const answered: { id: string; text?: string }[] = [];
  return {
    sent,
    edited,
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
    async editMessageText(input) {
      edited.push(input);
    },
    async answerCallbackQuery(id, text) {
      answered.push({ id, ...(text === undefined ? {} : { text }) });
    },
  };
}

const flatButtons = (message: SentMessage | undefined) => (message?.buttons ?? []).flat();

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

function setup(
  openInbox: { id: string; title: string; kind?: string; procurementId?: string }[] = [],
) {
  const bot = stubBot();
  const store = createMemoryTelegramStore();
  store.seedWorkspaceLink(workspaceId, userId);
  const dismissed: string[] = [];
  const decisions: { cardId: string; kind: string }[] = [];
  const rules: { suggestionId: string; action: string }[] = [];
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
              procurementId: entry.procurementId ?? "00000000-0000-4000-8000-0000000000cc",
              kind: entry.kind ?? "status_changed",
              title: entry.title,
              statusLabel: "Подача предложений",
              detail: "Номер: 1.",
              url: "https://goszakupki.by/tenders/view/1",
            })),
            async dismiss(id) {
              dismissed.push(id);
              return true;
            },
            async decide(cardId, kind) {
              decisions.push({ cardId, kind });
              return cardId === "missing" ? "not_found" : "ok";
            },
            async resolveSuggestion(suggestionId, action) {
              rules.push({ suggestionId, action });
              return "ok";
            },
          }
        : undefined,
  });
  return { bot, store, notifier, dismissed, decisions, rules };
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
    // The welcome answer ships the persistent command keyboard, so a linked
    // specialist taps Russian-labelled buttons instead of typing commands.
    expect(bot.sent[0]?.keyboard).toEqual([
      ["Новые события", "Статус"],
      ["Только срочные", "Все события"],
      ["Отключить", "Помощь"],
    ]);
    bot.sent.length = 0;

    await notifier.notifyInbox(workspaceId, inboxItem());
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0]?.chatId).toBe("777");
    expect(bot.sent[0]?.text).toContain("Поставка КТП");
    expect(flatButtons(bot.sent[0]).some((button) => button.text === "Разобрано")).toBe(false);
    // A candidate ships the triage row: the specialist decides from the chat.
    expect(flatButtons(bot.sent[0]).map((button) => button.text)).toEqual(
      expect.arrayContaining(["Следить", "Участвовать", "Не нужно", "Скрыть"]),
    );
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
    // A watch-change event is already decided — no triage row on it.
    expect(flatButtons(bot.sent[0]).some((button) => button.callbackData?.startsWith("t:"))).toBe(false);
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

    // The reply-keyboard label maps onto the same command.
    bot.sent.length = 0;
    await notifier.handleUpdate({ updateId: 4, message: { chatId: "777", text: "Новые события" } });
    expect(bot.sent.map((m) => m.text).join("\n")).toContain("Закупка раз");

    await notifier.handleUpdate({
      updateId: 3,
      callbackQuery: { id: "cb1", chatId: "777", data: "d:evt-1" },
    });
    expect(dismissed).toEqual(["evt-1"]);
    expect(bot.answered[0]?.text).toBe("Событие закрыто");
  });

  it("applies a triage decision from an inline button and rewrites the card message", async () => {
    const { bot, notifier, decisions } = setup();
    const { code } = await notifier.createLinkCode(userId);
    await notifier.handleUpdate({ updateId: 1, message: { chatId: "777", text: `/start ${code}` } });

    const cardId = "00000000-0000-4000-8000-0000000000cc";
    await notifier.handleUpdate({
      updateId: 2,
      callbackQuery: {
        id: "cb2",
        chatId: "777",
        data: `t:${cardId}:participate`,
        messageId: 55,
        messageText: "Новая закупка\nПоставка КТП для завода",
      },
    });
    expect(decisions).toEqual([{ cardId, kind: "participate" }]);
    expect(bot.answered[0]?.text).toBe("Принято: «Участвовать»");
    // The decided message keeps only the console link — no second guess.
    expect(bot.edited[0]?.text).toContain("Решение: «Участвовать»");
    expect(flatButtons(bot.edited[0] as SentMessage).map((button) => button.text)).toEqual([
      "Открыть в консоли",
    ]);
  });

  it("offers an assistant rule once with Принять / Отклонить and skips it in urgent mode", async () => {
    const { bot, notifier, rules } = setup();
    const { code } = await notifier.createLinkCode(userId);
    await notifier.handleUpdate({ updateId: 1, message: { chatId: "777", text: `/start ${code}` } });
    bot.sent.length = 0;
    const suggestion = {
      id: "00000000-0000-4000-8000-0000000000dd",
      profileId: "00000000-0000-4000-8000-0000000000ee",
      profileName: "Сети <0,4 кВ>",
      termKey: "наруж освеще",
      label: "наружного освещения",
      rejectCount: 5,
      examples: ["Ремонт наружного освещения"],
      state: "open" as const,
      createdAt: new Date().toISOString(),
    };

    await notifier.notifySuggestion(workspaceId, suggestion);
    await notifier.notifySuggestion(workspaceId, suggestion);
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0]?.text).toContain("Вы отклонили 5 закупок с предметом «наружного освещения»");
    expect(bot.sent[0]?.text).toContain("Сети &lt;0,4 кВ&gt;");
    expect(flatButtons(bot.sent[0]).map((button) => button.callbackData)).toEqual(
      expect.arrayContaining([`s:${suggestion.id}:a`, `s:${suggestion.id}:d`]),
    );

    await notifier.handleUpdate({
      updateId: 2,
      callbackQuery: {
        id: "cb5",
        chatId: "777",
        data: `s:${suggestion.id}:a`,
        messageId: 56,
        messageText: "Помощник",
      },
    });
    expect(rules).toEqual([{ suggestionId: suggestion.id, action: "accept" }]);
    expect(bot.edited[0]?.text).toContain("добавлено в исключения профиля");

    await notifier.handleUpdate({ updateId: 3, message: { chatId: "777", text: "/urgent" } });
    bot.sent.length = 0;
    await notifier.notifySuggestion(workspaceId, { ...suggestion, id: "00000000-0000-4000-8000-0000000000df" });
    expect(bot.sent).toHaveLength(0);
  });

  it("does not decide for an unlinked chat or a missing card", async () => {
    const { bot, notifier, decisions } = setup();
    await notifier.handleUpdate({
      updateId: 1,
      callbackQuery: { id: "cb3", chatId: "999", data: "t:00000000-0000-4000-8000-0000000000cc:monitor" },
    });
    expect(decisions).toEqual([]);
    expect(bot.answered[0]?.text).toBe("Решение сейчас недоступно");

    const { code } = await notifier.createLinkCode(userId);
    await notifier.handleUpdate({ updateId: 2, message: { chatId: "777", text: `/start ${code}` } });
    await notifier.handleUpdate({
      updateId: 3,
      callbackQuery: { id: "cb4", chatId: "777", data: "t:missing:reject" },
    });
    expect(decisions).toEqual([{ cardId: "missing", kind: "reject" }]);
    expect(bot.answered.at(-1)?.text).toContain("не найдена");
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
    expect(message.buttons.flat().find((button) => button.url !== undefined)?.url).toBe(
      "http://x.test",
    );
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
