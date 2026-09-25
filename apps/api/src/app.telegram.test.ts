import { describe, expect, it } from "vitest";
import { SpecialistCatalog } from "@procurement/domain";
import { buildSpecialistApi } from "./app.js";
import type { TelegramNotifier } from "./telegram.js";

function stubTelegram(): TelegramNotifier & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    botUsername: () => "zakupki_test_bot",
    async status() {
      calls.push("status");
      return { linked: false };
    },
    async createLinkCode() {
      calls.push("link");
      return { code: "abc123", url: "https://t.me/zakupki_test_bot?start=abc123", expiresInSec: 600 };
    },
    async unlink() {
      calls.push("unlink");
    },
    async setMode() {
      calls.push("mode");
    },
    async notifyInbox() {
      calls.push("notify");
    },
    async handleUpdate() {},
    async pollOnce(offset) {
      return offset;
    },
  };
}

describe("telegram endpoints", () => {
  it("reports unavailable when no bot is wired", async () => {
    const app = await buildSpecialistApi({ catalog: new SpecialistCatalog() });
    const response = await app.inject({ method: "GET", url: "/api/telegram" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ available: false, linked: false });

    const link = await app.inject({ method: "POST", url: "/api/telegram/link" });
    expect(link.statusCode).toBe(503);
    await app.close();
  });

  it("links, switches mode and unlinks through the wired notifier", async () => {
    const telegram = stubTelegram();
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      telegram,
    });

    const status = await app.inject({ method: "GET", url: "/api/telegram" });
    expect(JSON.parse(status.body)).toEqual({ available: true, linked: false });

    const link = await app.inject({ method: "POST", url: "/api/telegram/link" });
    expect(link.statusCode).toBe(200);
    expect(JSON.parse(link.body).code).toBe("abc123");

    const mode = await app.inject({
      method: "POST",
      url: "/api/telegram/mode",
      payload: { mode: "urgent" },
    });
    expect(mode.statusCode).toBe(200);

    const bad = await app.inject({
      method: "POST",
      url: "/api/telegram/mode",
      payload: { mode: "sometimes" },
    });
    expect(bad.statusCode).toBe(400);

    const off = await app.inject({ method: "DELETE", url: "/api/telegram" });
    expect(JSON.parse(off.body)).toEqual({ available: true, linked: false });
    expect(telegram.calls).toEqual(["status", "link", "mode", "status", "unlink"]);
    await app.close();
  });

  it("announces a recorded inbox event to the linked chat", async () => {
    const telegram = stubTelegram();
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      telegram,
    });
    const event = {
      procurement: {
        title: "Поставка КТП",
        status: "cancelled",
        url: "https://goszakupki.by/tenders/view/1",
        sourceProcurementId: "auction/1",
      },
      change: {
        id: "00000000-0000-4000-8000-000000000301",
        procurementId: "00000000-0000-4000-8000-0000000000cc",
        kind: "status_changed",
        detectedAt: new Date().toISOString(),
        urgent: true,
        previous: "accepting_bids",
        current: "cancelled",
      },
    };
    const response = await app.inject({ method: "POST", url: "/api/inbox/events", payload: event });
    expect(response.statusCode).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(telegram.calls).toContain("notify");
    await app.close();
  });
});
