import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NotificationId } from "@procurement/contracts";
import { createLogger } from "@procurement/observability";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryInboxStore } from "./inbox-store.js";
import { createNotificationMcpServer } from "./server.js";
import { RecordingTelegramSender } from "./telegram-port.js";

const now = "2026-09-03T12:00:00.000Z";
const id = NotificationId.parse("00000000-0000-4000-8000-000000000021");

describe("Notifications MCP", () => {
  let client: Client;
  let server: ReturnType<typeof createNotificationMcpServer>;
  let inbox: MemoryInboxStore;
  let telegram: RecordingTelegramSender;

  beforeEach(async () => {
    inbox = new MemoryInboxStore({
      clock: () => new Date(now),
      id: () => id,
    });
    telegram = new RecordingTelegramSender();
    server = createNotificationMcpServer({
      inbox,
      telegram,
      allowedChatIds: ["42"],
      clock: () => new Date(now),
      logger: createLogger({ sink: () => undefined }),
    });
    client = new Client({ name: "notifications-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await Promise.all([client.close(), server.close()]);
  });

  it("publishes inbox and telegram tools only", async () => {
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual(["notification.send", "telegram.send"]);
  });

  it("dedupes inbox delivery by key and does not rewrite the stored body", async () => {
    const first = await client.callTool({
      name: "notification.send",
      arguments: {
        title: "Изменение",
        body: "Статус: accepting_bids → cancelled.",
        urgency: "urgent",
        dedupeKey: "proc-1:status",
      },
    });
    const second = await client.callTool({
      name: "notification.send",
      arguments: {
        title: "Изменение",
        body: "rewritten",
        urgency: "urgent",
        dedupeKey: "proc-1:status",
      },
    });

    expect(first.structuredContent).toMatchObject({
      id,
      channel: "inbox",
      duplicate: false,
      deliveredAt: now,
    });
    expect(second.structuredContent).toMatchObject({ id, duplicate: true });
    expect(inbox.list()[0]?.body).toBe("Статус: accepting_bids → cancelled.");
  });

  it("sends telegram text to an allowed chat and skips a repeated dedupe key", async () => {
    const first = await client.callTool({
      name: "telegram.send",
      arguments: {
        chatId: "42",
        text: "Статус изменился",
        dedupeKey: "proc-1:status",
      },
    });
    const second = await client.callTool({
      name: "telegram.send",
      arguments: {
        chatId: "42",
        text: "should not send twice",
        dedupeKey: "proc-1:status",
      },
    });

    expect(first.structuredContent).toMatchObject({
      messageId: "1",
      chatId: "42",
      duplicate: false,
    });
    expect(second.structuredContent).toMatchObject({ messageId: "1", duplicate: true });
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]?.text).toBe("Статус изменился");
  });

  it("rejects a chat that is not on the allowlist", async () => {
    const result = await client.callTool({
      name: "telegram.send",
      arguments: {
        chatId: "99",
        text: "Статус изменился",
        dedupeKey: "proc-1:status",
      },
    });
    expect(result.isError).toBe(true);
    expect(result._meta).toMatchObject({ errorKind: "invalid_request" });
    expect(telegram.sent).toHaveLength(0);
  });
});

describe("Notifications MCP live allowlist", () => {
  it("refuses telegram.send when live mode has an empty allowlist", async () => {
    const server = createNotificationMcpServer({
      requireTelegramAllowlist: true,
      allowedChatIds: [],
      telegram: new RecordingTelegramSender(),
      logger: createLogger({ sink: () => undefined }),
    });
    const client = new Client({ name: "notifications-live-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "telegram.send",
      arguments: {
        chatId: "42",
        text: "Статус изменился",
        dedupeKey: "proc-1:status",
      },
    });
    expect(result.isError).toBe(true);
    expect(result._meta).toMatchObject({ errorKind: "invalid_request" });

    await Promise.all([client.close(), server.close()]);
  });
});
