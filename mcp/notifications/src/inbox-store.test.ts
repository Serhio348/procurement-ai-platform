import { NotificationId, NotificationSendRequest } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { MemoryInboxStore } from "./inbox-store.js";

const now = "2026-09-03T12:00:00.000Z";
const id = NotificationId.parse("00000000-0000-4000-8000-000000000001");

describe("MemoryInboxStore", () => {
  it("stores a message once and returns the same item for a repeated dedupe key", () => {
    const store = new MemoryInboxStore({
      clock: () => new Date(now),
      id: () => id,
    });
    const request = NotificationSendRequest.parse({
      title: "Изменение закупки",
      body: "Статус: accepting_bids → cancelled.",
      urgency: "urgent",
      dedupeKey: "proc-1:status",
    });

    const first = store.send(request);
    const second = store.send({
      ...request,
      body: "this rewrite must not replace the stored body",
    });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.item.id).toBe(first.item.id);
    expect(second.item.body).toBe("Статус: accepting_bids → cancelled.");
    expect(store.list()).toHaveLength(1);
  });
});
