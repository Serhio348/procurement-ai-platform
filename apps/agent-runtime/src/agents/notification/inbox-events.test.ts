import { InboxFixtureItem } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { HttpSpecialistInboxEvents } from "./inbox-events.js";

describe("HttpSpecialistInboxEvents", () => {
  it("posts the structured change to the specialist API", async () => {
    const posts: string[] = [];
    const events = new HttpSpecialistInboxEvents({
      baseUrl: "http://127.0.0.1:3001",
      fetchImpl: async (url, init) => {
        posts.push(`${String(init?.method)} ${String(url)}`);
        return new Response(JSON.stringify({ items: [] }), { status: 201 });
      },
    });

    await events.record(
      InboxFixtureItem.parse({
        procurement: {
          title: "Поставка КТПБ",
          status: "cancelled",
          url: "https://goszakupki.by/auction/view/001",
          sourceProcurementId: "auction/001",
        },
        change: {
          id: "00000000-0000-4000-8000-000000000201",
          procurementId: "00000000-0000-4000-8000-000000000020",
          kind: "status_changed",
          previous: "accepting_bids",
          current: "cancelled",
          detectedAt: "2026-09-03T11:00:00.000Z",
          urgent: true,
        },
      }),
    );

    expect(posts).toEqual(["POST http://127.0.0.1:3001/api/inbox/events"]);
  });
});
