import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ProcedureCard,
  SearchHit,
  SearchIntentPlan,
  SpecialistProcurementCard,
  electricalEquipmentSeedV1,
  type InboxFixtureItem,
} from "@procurement/contracts";
import {
  LISTING_PENDING_REASON,
  SpecialistCatalog,
  SpecialistWorkspace,
  inferSearchIntentPlan,
  scoreSearchIntentFromProcedure,
  type ReviewOutcome,
} from "@procurement/domain";
import { McpToolCallError, type McpToolCaller } from "@procurement/mcp-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryAdminJournal } from "./admin/journal.js";
import { buildSpecialistApi } from "./app.js";
import { putBlob } from "./blobs.js";
import { createMemoryCabinetRegistry } from "./cabinets.js";
import { loadFixtureCatalog } from "./load-fixture.js";
import { createProcurementSearchReview } from "./search-review.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function waitForCase(
  app: Awaited<ReturnType<typeof buildSpecialistApi>>,
  id: string,
  assert: (body: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  return vi.waitFor(async () => {
    const response = await app.inject({ method: "GET", url: `/api/procurements/${id}` });
    const body = JSON.parse(response.body) as Record<string, unknown>;
    assert(body);
    return body;
  });
}

describe("specialist API", () => {
  it("lists seeded urgent inbox items without the non-urgent household panel", async () => {
    const app = await buildSpecialistApi({ catalog: await loadFixtureCatalog() });

    const response = await app.inject({ method: "GET", url: "/api/inbox" });
    const body = JSON.parse(response.body) as { items: Array<{ title: string }> };

    expect(response.statusCode).toBe(200);
    expect(body.items.map((item) => item.title)).toEqual([
      "Поставка КТПБ",
      "НКУ и щитовое оборудование",
    ]);

    await app.close();
  });

  it("shows a newly posted urgent change on the next inbox read", async () => {
    const app = await buildSpecialistApi({ catalog: new SpecialistCatalog() });
    const event = {
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
    };

    const created = await app.inject({ method: "POST", url: "/api/inbox/events", payload: event });
    const listed = await app.inject({ method: "GET", url: "/api/inbox" });
    const duplicate = await app.inject({ method: "POST", url: "/api/inbox/events", payload: event });

    expect(created.statusCode).toBe(201);
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body).items).toHaveLength(1);
    expect(JSON.parse(listed.body).items[0]?.title).toBe("Поставка КТПБ");
    expect(duplicate.statusCode).toBe(200);

    await app.close();
  });

  it("refreshes a card from a status message and then drops that inbox row", async () => {
    const app = await buildSpecialistApi({ catalog: await loadFixtureCatalog() });
    const before = await app.inject({ method: "GET", url: "/api/inbox" });
    const statusId = JSON.parse(before.body).items.find(
      (item: { topic: string }) => item.topic === "card_update",
    )?.id as string;

    const resolved = await app.inject({
      method: "POST",
      url: `/api/inbox/${statusId}/resolve`,
      payload: { action: "refresh" },
    });
    const after = await app.inject({ method: "GET", url: "/api/inbox" });
    const card = JSON.parse(resolved.body).card as { status: string; title: string };

    expect(resolved.statusCode).toBe(200);
    expect(card.title).toBe("Поставка КТПБ");
    expect(card.status).toBe("cancelled");
    expect(JSON.parse(after.body).items.map((item: { title: string }) => item.title)).toEqual([
      "НКУ и щитовое оборудование",
    ]);

    await app.close();
  });

  it("deletes an inbox row and does not invent a procurement case from it", async () => {
    const app = await buildSpecialistApi({ catalog: await loadFixtureCatalog() });
    const listed = await app.inject({ method: "GET", url: "/api/inbox" });
    const id = JSON.parse(listed.body).items[0]?.id as string;
    const removed = await app.inject({ method: "DELETE", url: `/api/inbox/${id}` });
    const inbox = await app.inject({ method: "GET", url: "/api/inbox" });
    const cases = await app.inject({ method: "GET", url: "/api/procurements" });

    expect(removed.statusCode).toBe(200);
    expect(JSON.parse(inbox.body).items).toHaveLength(1);
    expect(
      (JSON.parse(cases.body).items as Array<{ title: string }>).some(
        (item) => item.title === "Поставка КТПБ",
      ),
    ).toBe(false);

    await app.close();
  });

  it("lists procurement cases including a non-urgent latest change", async () => {
    const app = await buildSpecialistApi({ catalog: await loadFixtureCatalog() });

    const list = await app.inject({ method: "GET", url: "/api/procurements" });
    const card = await app.inject({
      method: "GET",
      url: "/api/procurements/00000000-0000-4000-8000-000000000022",
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/procurements/00000000-0000-4000-8000-000000000099",
    });

    const items = JSON.parse(list.body).items as Array<{ title: string }>;
    expect(items.some((item) => item.title === "Бытовой щиток")).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(card.statusCode).toBe(200);
    expect(JSON.parse(card.body).title).toBe("Бытовой щиток");
    expect(missing.statusCode).toBe(404);

    await app.close();
  });

  it("does not dump search hits into My procurements", async () => {
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/page-1",
            url: "https://goszakupki.by/auction/view/page-1",
            title: "КТПБ из поиска",
          }),
        ],
      },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "КТПБ", keywords: ["КТПБ"] },
    });
    const searched = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: {},
    });
    const listed = await app.inject({ method: "GET", url: "/api/procurements" });
    const mine = await app.inject({ method: "GET", url: "/api/procurements?tab=all" });
    const id = (JSON.parse(searched.body).items as Array<{ id: string }>)[0]?.id ?? "";
    await app.inject({
      method: "POST",
      url: `/api/procurements/${id}/decision`,
      payload: { kind: "monitor" },
    });
    const mineAfter = await app.inject({ method: "GET", url: "/api/procurements?tab=all" });
    const one = await app.inject({ method: "GET", url: `/api/procurements/${id}` });
    const badTab = await app.inject({ method: "GET", url: "/api/procurements?tab=nope" });

    expect(JSON.parse(listed.body).items).toHaveLength(1);
    expect(JSON.parse(mine.body).items).toEqual([]);
    expect(JSON.parse(mineAfter.body).items[0]?.triage).toBe("monitor");
    expect(JSON.parse(one.body).id).toBe(id);
    expect(JSON.parse(one.body).title).toBe("КТПБ из поиска");
    expect(badTab.statusCode).toBe(400);

    await app.close();
  });

  it("search tab is this run, not every stored case in the cabinet", async () => {
    const catalog = new SpecialistCatalog();
    catalog.upsertCase(
      SpecialistProcurementCard.parse({
        id: "00000000-0000-4000-8000-000000000701",
        title: "Закупка взрывозащищенной пусковой аппаратуры",
        status: "completed",
        statusLabel: "Завершен",
        url: "https://goszakupki.by/request/view/old-1",
        sourceProcurementId: "request/old-1",
        foundAs: "match",
        live: true,
      }),
    );
    const app = await buildSpecialistApi({
      catalog,
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/page-1",
            url: "https://goszakupki.by/auction/view/page-1",
            title: "КТПБ из поиска",
          }),
        ],
      },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "КТПБ", keywords: ["КТПБ"] },
    });
    const searched = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: {},
    });
    const queue = await app.inject({ method: "GET", url: "/api/procurements?tab=search" });
    const queueTitles = (JSON.parse(queue.body).items as Array<{ title: string }>).map(
      (item) => item.title,
    );

    expect(JSON.parse(searched.body).items).toHaveLength(1);
    expect(queueTitles).toEqual(["КТПБ из поиска"]);
    expect(queueTitles).not.toContain("Закупка взрывозащищенной пусковой аппаратуры");

    await app.close();
  });

  it("keeps each profile search queue when the specialist switches profile", async () => {
    const search = vi.fn(async (query: { keywords: string[] }) => {
      if (query.keywords.includes("кабель")) {
        return [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/cable-1",
            url: "https://goszakupki.by/auction/view/cable-1",
            title: "Поставка кабеля",
          }),
        ];
      }
      return [
        SearchHit.parse({
          sourceId: "goszakupki_by",
          sourceProcurementId: "auction/ktp-1",
          url: "https://goszakupki.by/auction/view/ktp-1",
          title: "Поставка КТПБ",
        }),
      ];
    });
    const persistCases = vi.fn(async (_cards: readonly unknown[]) => undefined);
    const persistWorkspace = vi.fn(async (_state: unknown) => undefined);
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search },
      persistCases,
      persistWorkspace,
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"] },
    });
    const first = await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    const firstId = (
      JSON.parse((await app.inject({ method: "GET", url: "/api/profile" })).body) as { id: string }
    ).id;
    const second = JSON.parse((await app.inject({ method: "POST", url: "/api/profiles" })).body) as {
      id: string;
    };
    await app.inject({
      method: "PUT",
      url: `/api/profiles/${second.id}`,
      payload: { name: "КТПБ", keywords: ["КТПБ"] },
    });
    await app.inject({ method: "POST", url: `/api/profiles/${second.id}/activate` });
    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    const secondQueue = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/procurements?tab=search" })).body,
    ) as { items: Array<{ title: string }> };
    expect(secondQueue.items.map((item) => item.title)).toEqual(["Поставка КТПБ"]);

    await app.inject({ method: "POST", url: `/api/profiles/${firstId}/activate` });
    const firstQueue = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/procurements?tab=search" })).body,
    ) as { items: Array<{ title: string }> };
    expect(JSON.parse(first.body).items.map((item: { title: string }) => item.title)).toEqual([
      "Поставка кабеля",
    ]);
    expect(firstQueue.items.map((item) => item.title)).toEqual(["Поставка кабеля"]);
    const saved = persistWorkspace.mock.calls.at(-1)?.[0] as {
      searchIdsByProfile?: Record<string, string[]>;
    };
    expect(Object.keys(saved.searchIdsByProfile ?? {}).length).toBeGreaterThanOrEqual(2);

    await app.close();
  });

  it("does not show a listing stub before the platform card is scored", async () => {
    const catalog = new SpecialistCatalog();
    catalog.upsertCase(
      SpecialistProcurementCard.parse({
        id: "00000000-0000-4000-8000-000000000801",
        title: "Поставка КТП 10 кВ для жилого дома",
        status: "accepting_bids",
        statusLabel: "Приём предложений",
        url: "https://goszakupki.by/auction/view/ktp-1",
        sourceProcurementId: "auction/ktp-1",
        foundAs: "match",
        live: true,
        relevanceScore: 0,
        relevanceReason: LISTING_PENDING_REASON,
      }),
    );
    let releaseReview!: () => void;
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    const review = vi.fn(async (reviewed: readonly SearchHit[]) => {
      await reviewGate;
      return reviewed.map(
        (): ReviewOutcome => ({
          verdict: "relevant",
          decidedBy: "card",
          reason: "В лотах есть КТП.",
          matchedTerms: ["КТП"],
          confidence: 1,
        }),
      );
    });
    const app = await buildSpecialistApi({
      catalog,
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/ktp-1",
            url: "https://goszakupki.by/auction/view/ktp-1",
            title: "Поставка КТП 10 кВ для жилого дома",
          }),
        ],
      },
      searchReview: { review },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "КТП", keywords: ["КТП"] },
    });
    const searched = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: {},
    });
    const before = await app.inject({ method: "GET", url: "/api/procurements?tab=search" });
    expect(JSON.parse(searched.body).items).toEqual([]);
    expect(JSON.parse(before.body).items).toEqual([]);

    releaseReview();
    await vi.waitFor(async () => {
      const queue = await app.inject({ method: "GET", url: "/api/procurements?tab=search" });
      const items = JSON.parse(queue.body).items as Array<{
        title: string;
        relevanceReason?: string;
      }>;
      expect(items).toHaveLength(1);
      expect(items[0]?.relevanceReason).toBe("В лотах есть КТП.");
    });

    await app.close();
  });

  it("shows a watched case in My procurements even when live-only listing is on", async () => {
    const catalog = new SpecialistCatalog();
    const stored = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000501",
      title: "КТПБ без отметки live",
      status: "accepting_bids",
      statusLabel: "Прием предложений",
      url: "https://goszakupki.by/auction/view/live-flag",
      sourceProcurementId: "auction/live-flag",
      live: false,
      foundAs: "match",
    });
    catalog.upsertCase(stored);
    const app = await buildSpecialistApi({
      catalog,
      liveProcurementsOnly: true,
    });

    const before = await app.inject({ method: "GET", url: "/api/procurements?tab=all" });
    await app.inject({
      method: "POST",
      url: `/api/procurements/${stored.id}/decision`,
      payload: { kind: "monitor" },
    });
    const after = await app.inject({ method: "GET", url: "/api/procurements?tab=all" });
    const watching = await app.inject({ method: "GET", url: "/api/procurements?tab=monitor" });

    expect(JSON.parse(before.body).items).toEqual([]);
    expect(JSON.parse(after.body).items).toEqual([
      expect.objectContaining({ id: stored.id, triage: "monitor" }),
    ]);
    expect(JSON.parse(watching.body).items[0]?.id).toBe(stored.id);

    await app.close();
  });

  it("does not seed fixture stubs or the captured dump when only live cases are listed", async () => {
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      liveProcurementsOnly: true,
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/3629820",
            url: "https://goszakupki.by/auction/view/3629820",
            title: "2БКТПБ 400кВА-10/0,4 кВ",
          }),
        ],
      },
    });

    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "КТПБ", keywords: ["2БКТПБ"] },
    });
    const inbox = await app.inject({ method: "GET", url: "/api/inbox" });
    const before = await app.inject({ method: "GET", url: "/api/procurements" });
    const searched = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: { limit: 5 },
    });
    const items = JSON.parse(searched.body).items as Array<{
      title: string;
      live?: boolean;
      sourceProcurementId: string;
    }>;

    expect(JSON.parse(inbox.body).items).toEqual([]);
    expect(JSON.parse(before.body).items).toEqual([]);
    expect(searched.statusCode).toBe(200);
    expect(items).toEqual([
      expect.objectContaining({
        live: true,
        sourceProcurementId: "auction/3629820",
        title: "2БКТПБ 400кВА-10/0,4 кВ",
      }),
    ]);
    expect(items.some((item) => item.title === "Бытовой щиток")).toBe(false);

    await app.close();
  });

  it("does not persist inbox stubs as cabinet cases", async () => {
    const catalog = new SpecialistCatalog();
    catalog.record({
      procurement: {
        title: "Поставка КТПБ",
        status: "cancelled",
        url: "https://goszakupki.by/auction/view/001",
        sourceProcurementId: "auction/001",
      },
      change: {
        id: "00000000-0000-4000-8000-000000000101",
        procurementId: "00000000-0000-4000-8000-000000000020",
        kind: "status_changed",
        previous: "accepting_bids",
        current: "cancelled",
        detectedAt: "2026-09-03T08:15:00.000Z",
        urgent: true,
      },
    });
    const persistCases = vi.fn(async () => undefined);
    const persistWorkspace = vi.fn(async () => undefined);
    const app = await buildSpecialistApi({
      catalog,
      persistCases,
      persistWorkspace,
    });

    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"] },
    });

    // Profile save must not rewrite case cards (and must not promote inbox stubs).
    expect(persistCases).not.toHaveBeenCalled();
    expect(persistWorkspace).toHaveBeenCalled();
    expect(catalog.procurements()).toHaveLength(1);

    await app.close();
  });

  it("persists an unused search hit while it stays in the profile queue", async () => {
    const persistCases = vi.fn(async () => undefined);
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      persistCases,
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/persist-1",
            url: "https://goszakupki.by/auction/view/persist-1",
            title: "Кабель силовой",
          }),
        ],
      },
    });

    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"] },
    });
    const searched = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: { limit: 5 },
    });

    expect(searched.statusCode).toBe(200);
    expect(JSON.parse(searched.body).items).toHaveLength(1);
    const stored = (persistCases.mock.calls as unknown[][]).flatMap((call) => {
      const cards = call[0];
      return Array.isArray(cards) ? (cards as Array<{ sourceProcurementId?: string }>) : [];
    });
    expect(stored.some((card) => card.sourceProcurementId === "auction/persist-1")).toBe(true);

    await app.close();
  });

  it("keeps review cases out of the list until opened, and prunes untouched stale cases", async () => {
    const removeCases = vi.fn(async (_ids: readonly string[]) => undefined);
    let now = "2026-09-01T10:00:00.000Z";
    let hits = [
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/exact-1",
        url: "https://goszakupki.by/auction/view/exact-1",
        title: "Поставка НКУ для насосов",
      }),
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "etrade/review-1",
        url: "https://goszakupki.by/etrade/view/review-1",
        title: "Поставка НКУ 0,4 кВ",
      }),
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "single-source/none-1",
        url: "https://goszakupki.by/single-source/view/none-1",
        title: "СО2-инкубатор (термостат электронный)",
      }),
    ];
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      removeCases,
      clock: () => now,
      searchHits: { search: async () => hits },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "НКУ для управления насосами", keywords: ["НКУ"] },
    });
    const first = await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    const listedAfterFirst = await app.inject({ method: "GET", url: "/api/procurements" });
    const inboxAfterFirst = await app.inject({ method: "GET", url: "/api/inbox" });
    const titles = (body: string) =>
      (JSON.parse(body).items as Array<{ title: string }>).map((item) => item.title);

    expect(first.statusCode).toBe(200);
    expect(titles(first.body)).toEqual(["Поставка НКУ для насосов"]);
    // Review is missing purpose, not substring noise. The incubator is discarded.
    expect(titles(listedAfterFirst.body)).toEqual(["Поставка НКУ для насосов"]);
    expect(titles(inboxAfterFirst.body)).toEqual(["Поставка НКУ 0,4 кВ"]);

    // Opening the review case from the inbox takes it on: it joins the list.
    const reviewRow = (JSON.parse(inboxAfterFirst.body).items as Array<{ id: string; title: string }>)
      .find((item) => item.title.includes("0,4"));
    const opened = await app.inject({
      method: "POST",
      url: `/api/inbox/${reviewRow?.id ?? ""}/resolve`,
      payload: { action: "open" },
    });
    expect(opened.statusCode).toBe(200);
    expect(JSON.parse(opened.body).card?.foundAs).toBe("match");
    const listedAfterOpen = await app.inject({ method: "GET", url: "/api/procurements" });
    expect(titles(listedAfterOpen.body).sort()).toEqual(
      ["Поставка НКУ 0,4 кВ", "Поставка НКУ для насосов"].sort(),
    );

    // A later empty search replaces this profile's unread queue. The
    // incubator was never stored.
    now = "2026-09-09T10:00:00.000Z";
    hits = [];
    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    const searchAfterPrune = await app.inject({
      method: "GET",
      url: "/api/procurements?tab=search",
    });
    const inboxAfterPrune = await app.inject({ method: "GET", url: "/api/inbox" });
    expect(titles(searchAfterPrune.body)).toEqual([]);
    expect(titles(inboxAfterPrune.body)).toEqual([]);

    await app.close();
  });

  it("spends the model budget once per search run, not once per card (R13)", async () => {
    // Two hits stay unclear at the card stage, so both would ask the model.
    // The run-level budget allows one call; the second waits for a human.
    const hits = [
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/quota-1",
        url: "https://goszakupki.by/auction/view/quota-1",
        title: "Закупка НКУ",
      }),
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/quota-2",
        url: "https://goszakupki.by/auction/view/quota-2",
        title: "Реализация НКУ",
      }),
    ];
    const classify = vi.fn(async () => ({
      verdict: "irrelevant" as const,
      confidence: 0.9,
      reason: "Не подходит.",
      needDeeper: false,
      matchedTerms: [] as string[],
    }));
    const caller: McpToolCaller = {
      callTool: vi.fn(async (_name, input) => ({
        structuredContent: ProcedureCard.parse({
          sourceId: "goszakupki_by",
          sourceProcurementId: String(
            (input as { sourceProcurementId?: unknown }).sourceProcurementId,
          ),
          url: "https://goszakupki.by/auction/view/x",
          title: "Закупка оборудования",
          lots: [{ number: "1", title: "НКУ-0,4 кВ" }],
          fetchedAt: "2026-09-09T00:00:00.000Z",
        }),
      })) as McpToolCaller["callTool"],
    };
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search: async () => hits },
      searchReview: createProcurementSearchReview({
        caller,
        classifier: { classify },
        maxModelCalls: 1,
        concurrency: 1,
      }),
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "НКУ для управления насосами", keywords: ["НКУ"] },
    });
    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });

    await vi.waitFor(async () => {
      const progress = await app.inject({
        method: "GET",
        url: "/api/procurements/search/progress",
      });
      expect(JSON.parse(progress.body).status).toBe("done");
    });
    expect(classify).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("lets the review port promote a checked hit, drop an unrelated one and ask about the rest", async () => {
    const hits = [
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/lot-1",
        url: "https://goszakupki.by/auction/view/lot-1",
        title: "Поставка НКУ 0,4 кВ",
      }),
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/drop-1",
        url: "https://goszakupki.by/auction/view/drop-1",
        title: "НКУ щитовое",
      }),
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/unclear-1",
        url: "https://goszakupki.by/auction/view/unclear-1",
        title: "Закупка НКУ",
      }),
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/incubator-1",
        url: "https://goszakupki.by/auction/view/incubator-1",
        title: "СО2-инкубатор (термостат электронный)",
      }),
    ];
    const verdicts: Record<string, ReviewOutcome> = {
      "auction/lot-1": {
        verdict: "relevant",
        decidedBy: "card",
        reason: "В лотах есть насосная станция.",
        matchedTerms: ["насос"],
        confidence: 1,
      },
      "auction/drop-1": {
        verdict: "irrelevant",
        decidedBy: "model",
        reason: "Щит не для насосов.",
        matchedTerms: [],
        confidence: 0.95,
      },
      "auction/unclear-1": {
        verdict: "needs_human",
        decidedBy: "model",
        reason: "Модель склоняется к «подходит», но не уверена.",
        matchedTerms: [],
        confidence: 0.5,
      },
    };
    let releaseReview!: () => void;
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    const review = vi.fn(async (reviewed: readonly SearchHit[]) => {
      await reviewGate;
      return reviewed.map((item) => verdicts[item.sourceProcurementId] as ReviewOutcome);
    });
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search: async () => hits },
      searchReview: { review },
      clock: () => "2026-09-01T10:00:00.000Z",
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "НКУ для управления насосами", keywords: ["НКУ"] },
    });

    const searched = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: {},
    });
    const body = JSON.parse(searched.body) as {
      relevantCount: number;
      ambiguousCount: number;
      discardedCount: number;
      items: Array<{ title: string }>;
      run?: { status: string; retrievedCount: number; scoredCount: number };
    };
    expect(body.items).toEqual([]);
    expect(body.relevantCount).toBe(0);
    expect(body.discardedCount).toBe(1);
    expect(body.ambiguousCount).toBe(3);
    expect(body.run).toMatchObject({
      status: "retrieving",
      retrievedCount: 3,
      scoredCount: 0,
      discardedCount: 0,
      listingDiscardedCount: 1,
    });
    const progress = await app.inject({ method: "GET", url: "/api/procurements/search/progress" });
    expect(JSON.parse(progress.body)).toMatchObject({
      status: "retrieving",
      retrievedCount: 3,
    });
    expect(
      (JSON.parse((await app.inject({ method: "GET", url: "/api/inbox" })).body).items as Array<{ title: string }>)
        .map((item) => item.title)
        .sort(),
    ).toEqual([]);

    releaseReview();
    await vi.waitFor(async () => {
      expect(review.mock.calls.flatMap((call) => call[0]).map((item) => item.sourceProcurementId).sort()).toEqual([
        "auction/drop-1",
        "auction/lot-1",
        "auction/unclear-1",
      ]);
    });

    await vi.waitFor(async () => {
      const inbox = await app.inject({ method: "GET", url: "/api/inbox" });
      const inboxTitles = (JSON.parse(inbox.body).items as Array<{ title: string }>).map(
        (item) => item.title,
      );
      const listed = await app.inject({ method: "GET", url: "/api/procurements" });
      const listedItems = JSON.parse(listed.body).items as Array<{
        id: string;
        title: string;
        foundAs?: string;
      }>;
      expect(inboxTitles).toEqual(["Закупка НКУ"]);
      expect(listedItems.map((item) => item.title)).toContain("Поставка НКУ 0,4 кВ");
      const lotId = listedItems.find((item) => item.title === "Поставка НКУ 0,4 кВ")?.id ?? "";
      const lot = JSON.parse((await app.inject({ method: "GET", url: `/api/procurements/${lotId}` })).body) as {
        foundAs?: string;
        actions: Array<{ detail: string }>;
      };
      expect(lot.foundAs).toBe("match");
      expect(lot.actions.at(-1)?.detail).toContain("насосная");
    });

    await app.close();
  });

  it("starts the site listing before the plan model returns", async () => {
    let listingStarted = false;
    let releasePlan!: () => void;
    const planGate = new Promise<void>((resolve) => {
      releasePlan = resolve;
    });
    const search = vi.fn(async () => {
      listingStarted = true;
      return [
        SearchHit.parse({
          sourceId: "goszakupki_by",
          sourceProcurementId: "auction/ktpb-1",
          url: "https://goszakupki.by/auction/view/ktpb-1",
          title: "Поставка КТПБ-250",
        }),
      ];
    });
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search },
      searchIntent: {
        plan: async (profile) => {
          await planGate;
          return inferSearchIntentPlan({
            name: profile.name,
            keywords: profile.keywords,
            excludeKeywords: profile.excludeKeywords,
          });
        },
      },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "КТПБ", keywords: ["КТПБ"] },
    });

    const pending = app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    await vi.waitFor(() => expect(listingStarted).toBe(true));
    expect(search).toHaveBeenCalledTimes(1);
    releasePlan();
    const searched = await pending;

    expect(searched.statusCode).toBe(200);
    expect(JSON.parse(searched.body).items.map((item: { title: string }) => item.title)).toEqual([
      "Поставка КТПБ-250",
    ]);
    expect(search).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("sends every filled advanced-search window on the source query", async () => {
    const search = vi.fn(async (_query: Record<string, unknown>) => [
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/3664806",
        url: "https://goszakupki.by/auction/view/3664806",
        title: "Выбор поставщика блочной комплектной подстанции (БКТПБ №3)",
        sourceStatus: "Подача предложений",
        status: "accepting_bids",
      }),
    ]);
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: {
        name: "КТПБ",
        keywords: ["КТПБ"],
        statuses: ["accepting_bids"],
        excludeSingleSource: true,
        filters: {
          buyerUnp: "123456789",
          buyerText: "Гродноэнерго",
          procurementNumber: "auc0003664806",
          priceFrom: 1000,
          priceTo: 500000,
          publishedFrom: "2026-09-01",
          publishedTo: "2026-09-30",
          requestEndFrom: "2026-09-16",
          requestEndTo: "2026-10-01",
          auctionFrom: "2026-09-20",
          auctionTo: "2026-09-25",
          typeIds: ["Auction", "singleSource"],
          regionIds: ["4"],
        },
      },
    });
    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });

    expect(search.mock.calls[0]?.[0]).toMatchObject({
      statuses: ["accepting_bids"],
      typeIds: ["Auction"],
      regionIds: ["4"],
      buyerUnp: "123456789",
      buyerText: "Гродноэнерго",
      procurementNumber: "auc0003664806",
      priceFrom: 1000,
      priceTo: 500000,
      publishedFrom: "2026-09-01T00:00:00+03:00",
      publishedTo: "2026-09-30T00:00:00+03:00",
      requestEndFrom: "2026-09-16T00:00:00+03:00",
      requestEndTo: "2026-10-01T00:00:00+03:00",
      auctionFrom: "2026-09-20T00:00:00+03:00",
      auctionTo: "2026-09-25T00:00:00+03:00",
    });

    await app.close();
  });

  it("saves a profile whose advanced-search windows were left empty", async () => {
    const app = await buildSpecialistApi({ catalog: new SpecialistCatalog() });
    const saved = await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: {
        name: "КТПБ",
        keywords: ["КТПБ"],
        filters: { buyerUnp: "", publishedFrom: "", priceFrom: null },
      },
    });

    expect(saved.statusCode).toBe(200);
    const body = JSON.parse(saved.body) as { filters: { buyerUnp?: string; publishedFrom?: string } };
    expect(body.filters.buyerUnp).toBeUndefined();
    expect(body.filters.publishedFrom).toBeUndefined();

    await app.close();
  });

  it("queries extra objects the model added after the cheap listing", async () => {
    const search = vi.fn(async (query: { keywords: string[] }) => {
      if (query.keywords.includes("шкаф управления")) {
        return [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/cabinet-1",
            url: "https://goszakupki.by/auction/view/cabinet-1",
            title: "Поставка шкафа управления насосами",
          }),
        ];
      }
      return [
        SearchHit.parse({
          sourceId: "goszakupki_by",
          sourceProcurementId: "auction/nku-1",
          url: "https://goszakupki.by/auction/view/nku-1",
          title: "Поставка НКУ для насосов",
        }),
      ];
    });
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search },
      searchIntent: {
        plan: async () =>
          SearchIntentPlan.parse({
            objects: ["НКУ", "шкаф управления"],
            required_context: ["насос"],
            desired_actions: ["поставка"],
            excluded_actions: ["монтаж"],
            intent: "equipment_purchase",
          }),
      },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "НКУ для управления насосами", keywords: ["НКУ"] },
    });

    const searched = await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    const titles = (JSON.parse(searched.body).items as Array<{ title: string }>).map((item) => item.title);

    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[0]?.[0].keywords).toEqual(["НКУ"]);
    expect(search.mock.calls[1]?.[0].keywords).toEqual(["шкаф управления"]);
    expect(titles).toEqual(["Поставка НКУ для насосов", "Поставка шкафа управления насосами"]);

    await app.close();
  });

  it("stores the card-level code score on a matched case, not the listing zero (R06)", async () => {
    const hit = SearchHit.parse({
      sourceId: "goszakupki_by",
      sourceProcurementId: "auction/score-1",
      url: "https://goszakupki.by/auction/view/score-1",
      title: "Закупка НКУ",
    });
    const fetchedCard = ProcedureCard.parse({
      sourceId: "goszakupki_by",
      sourceProcurementId: "auction/score-1",
      url: "https://goszakupki.by/auction/view/score-1",
      title: "Поставка НКУ для насосов",
      lots: [{ number: "1", title: "НКУ-0,4 кВ, 2 шт." }],
      fetchedAt: "2026-09-09T00:00:00.000Z",
    });
    const caller: McpToolCaller = {
      callTool: vi.fn(async () => ({ structuredContent: fetchedCard })) as McpToolCaller["callTool"],
    };
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search: async () => [hit] },
      searchReview: createProcurementSearchReview({ caller }),
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "НКУ для управления насосами", keywords: ["НКУ"] },
    });
    const plan = inferSearchIntentPlan({
      name: "НКУ для управления насосами",
      keywords: ["НКУ"],
      excludeKeywords: [],
    });
    const expected = scoreSearchIntentFromProcedure(fetchedCard, plan).score;

    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    await vi.waitFor(async () => {
      const listed = await app.inject({ method: "GET", url: "/api/procurements" });
      const items = JSON.parse(listed.body).items as Array<{
        title: string;
        relevanceScore?: number;
        relevanceReason?: string;
      }>;
      // The stored platform card replaces the listing title with the live one.
      const card = items.find((item) => item.title === "Поставка НКУ для насосов");
      expect(card?.relevanceScore).toBe(expected);
      expect(card?.relevanceScore).toBeGreaterThan(0);
    });

    await app.close();
  });

  it("re-checks a saved review candidate on the next search instead of just restoring it (R05)", async () => {
    const hit = SearchHit.parse({
      sourceId: "goszakupki_by",
      sourceProcurementId: "auction/re-1",
      url: "https://goszakupki.by/auction/view/re-1",
      title: "Закупка НКУ",
    });
    const review = vi
      .fn()
      .mockImplementationOnce(async (reviewed: readonly SearchHit[]) =>
        reviewed.map(
          (): ReviewOutcome => ({
            verdict: "needs_human",
            decidedBy: "none",
            reason: "Модель недоступна — проверьте по смыслу.",
            matchedTerms: [],
            confidence: 0,
          }),
        ),
      )
      .mockImplementation(async (reviewed: readonly SearchHit[]) =>
        reviewed.map(
          (): ReviewOutcome => ({
            verdict: "relevant",
            decidedBy: "model",
            reason: "В лотах есть НКУ.",
            matchedTerms: ["НКУ"],
            confidence: 0.95,
          }),
        ),
      );
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search: async () => [hit] },
      searchReview: { review },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "НКУ для управления насосами", keywords: ["НКУ"] },
    });

    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    await vi.waitFor(async () => {
      const inbox = await app.inject({ method: "GET", url: "/api/inbox" });
      expect(
        (JSON.parse(inbox.body).items as Array<{ title: string }>).map((item) => item.title),
      ).toEqual(["Закупка НКУ"]);
    });
    expect(review).toHaveBeenCalledTimes(1);

    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => {
      const listed = await app.inject({ method: "GET", url: "/api/procurements" });
      expect(
        (JSON.parse(listed.body).items as Array<{ title: string }>).map((item) => item.title),
      ).toContain("Закупка НКУ");
    });

    await app.close();
  });

  it("puts a dismissed review hit back in the inbox on the next search", async () => {
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/again-1",
            url: "https://goszakupki.by/auction/view/again-1",
            title: "Поставка НКУ 0,4 кВ",
          }),
        ],
      },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "НКУ для управления насосами", keywords: ["НКУ"] },
    });

    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    const firstInbox = await app.inject({ method: "GET", url: "/api/inbox" });
    const rowId = (JSON.parse(firstInbox.body).items as Array<{ id: string }>)[0]?.id ?? "";
    expect(rowId.length).toBeGreaterThan(0);
    await app.inject({ method: "DELETE", url: `/api/inbox/${rowId}` });
    expect(JSON.parse((await app.inject({ method: "GET", url: "/api/inbox" })).body).items).toEqual([]);

    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    const restored = (JSON.parse((await app.inject({ method: "GET", url: "/api/inbox" })).body).items as Array<{
      title: string;
    }>).map((item) => item.title);
    expect(restored).toEqual(["Поставка НКУ 0,4 кВ"]);

    await app.close();
  });

  it("reviews background discovery hits too, and counts only the accepted ones as added", async () => {
    const hits = [
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/night-1",
        url: "https://goszakupki.by/auction/view/night-1",
        title: "Поставка НКУ 0,4 кВ",
      }),
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/night-2",
        url: "https://goszakupki.by/auction/view/night-2",
        title: "СО2-инкубатор",
      }),
    ];
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search: async () => hits },
      searchReview: {
        review: async (reviewed) =>
          reviewed.map((item) =>
            item.sourceProcurementId === "auction/night-1"
              ? {
                  verdict: "relevant" as const,
                  decidedBy: "card" as const,
                  reason: "В лотах есть насосная станция.",
                  matchedTerms: ["насос"],
                  confidence: 1,
                }
              : {
                  verdict: "irrelevant" as const,
                  decidedBy: "model" as const,
                  reason: "Лабораторный инкубатор.",
                  matchedTerms: [],
                  confidence: 0.95,
                },
          ),
      },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "НКУ для управления насосами", keywords: ["НКУ"] },
    });
    await app.inject({
      method: "POST",
      url: "/api/profile/watch",
      payload: { watchNewProcurements: true },
    });

    const ran = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const body = JSON.parse(ran.body) as {
      ran: boolean;
      addedCount: number;
      items: Array<{ title: string }>;
    };

    expect(body.ran).toBe(true);
    expect(body.addedCount).toBe(1);
    expect(body.items.map((item) => item.title)).toEqual(["Поставка НКУ 0,4 кВ"]);

    await app.close();
  });

  it("watches extra objects the model added, with the same watermark on both queries", async () => {
    const search = vi.fn(async (query: { keywords: string[]; publishedFrom?: string | undefined }) => {
      if (query.keywords.includes("шкаф управления")) {
        return [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/watch-cabinet",
            url: "https://goszakupki.by/auction/view/watch-cabinet",
            title: "Поставка шкафа управления насосами",
          }),
        ];
      }
      return [
        SearchHit.parse({
          sourceId: "goszakupki_by",
          sourceProcurementId: "auction/watch-nku",
          url: "https://goszakupki.by/auction/view/watch-nku",
          title: "Поставка НКУ для насосов",
        }),
      ];
    });
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search },
      searchIntent: {
        plan: async () =>
          SearchIntentPlan.parse({
            objects: ["НКУ", "шкаф управления"],
            required_context: ["насос"],
            desired_actions: ["поставка"],
            excluded_actions: ["монтаж"],
            intent: "equipment_purchase",
          }),
      },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "НКУ для управления насосами", keywords: ["НКУ"] },
    });
    await app.inject({
      method: "POST",
      url: "/api/profile/watch",
      payload: { watchNewProcurements: true },
    });

    const ran = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const body = JSON.parse(ran.body) as { addedCount: number; items: Array<{ title: string }> };

    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[0]?.[0].keywords).toEqual(["НКУ"]);
    expect(search.mock.calls[1]?.[0].keywords).toEqual(["шкаф управления"]);
    expect(search.mock.calls.map((call) => call[0].publishedFrom)).toEqual([undefined, undefined]);
    expect(body.addedCount).toBe(2);
    expect(body.items.map((item) => item.title).sort()).toEqual(
      ["Поставка НКУ для насосов", "Поставка шкафа управления насосами"].sort(),
    );

    await app.close();
  });

  it("does not let a later watch pass re-review a match the specialist already has", async () => {
    const hits = [
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/keep-match",
        url: "https://goszakupki.by/auction/view/keep-match",
        title: "Поставка НКУ 0,4 кВ",
      }),
    ];
    const review = vi.fn(async (reviewed: readonly SearchHit[]) =>
      reviewed.map(
        (): ReviewOutcome => ({
          verdict: "relevant",
          decidedBy: "card",
          reason: "В лотах есть насосная станция.",
          matchedTerms: ["насос"],
          confidence: 1,
        }),
      ),
    );
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search: async () => hits },
      searchReview: { review },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "НКУ для управления насосами", keywords: ["НКУ"] },
    });
    await app.inject({
      method: "POST",
      url: "/api/profile/watch",
      payload: { watchNewProcurements: true },
    });
    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    await vi.waitFor(async () => {
      const listed = await app.inject({ method: "GET", url: "/api/procurements" });
      expect(
        (JSON.parse(listed.body).items as Array<{ title: string }>).map((item) => item.title),
      ).toContain("Поставка НКУ 0,4 кВ");
    });
    review.mockClear();
    review.mockImplementation(async (reviewed: readonly SearchHit[]) =>
      reviewed.map(
        (): ReviewOutcome => ({
          verdict: "irrelevant",
          decidedBy: "model",
          reason: "Не для насосов.",
          matchedTerms: [],
          confidence: 0.95,
        }),
      ),
    );

    const ran = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const listed = await app.inject({ method: "GET", url: "/api/procurements" });

    expect(JSON.parse(ran.body).ran).toBe(true);
    expect(review).not.toHaveBeenCalled();
    expect((JSON.parse(listed.body).items as Array<{ title: string }>).map((item) => item.title)).toContain(
      "Поставка НКУ 0,4 кВ",
    );

    await app.close();
  });

  it("puts a shared discovery hit on the second profile without clearing the first queue", async () => {
    const hits = [
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/shared-nku",
        url: "https://goszakupki.by/auction/view/shared-nku",
        title: "Поставка НКУ 0,4 кВ",
      }),
    ];
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search: async () => hits },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "НКУ", keywords: ["НКУ"] },
    });
    const firstId = (
      JSON.parse((await app.inject({ method: "GET", url: "/api/profile" })).body) as { id: string }
    ).id;
    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    const firstQueue = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/procurements?tab=search" })).body,
    ) as { items: Array<{ title: string }> };
    expect(firstQueue.items.map((item) => item.title)).toEqual(["Поставка НКУ 0,4 кВ"]);

    const second = JSON.parse((await app.inject({ method: "POST", url: "/api/profiles" })).body) as {
      id: string;
    };
    await app.inject({
      method: "PUT",
      url: `/api/profiles/${second.id}`,
      payload: { name: "Насосы", keywords: ["НКУ"] },
    });
    await app.inject({ method: "POST", url: `/api/profiles/${second.id}/activate` });
    await app.inject({
      method: "POST",
      url: `/api/profiles/${second.id}/watch`,
      payload: { watchNewProcurements: true },
    });

    const ran = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    expect(JSON.parse(ran.body).ran).toBe(true);
    const secondQueue = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/procurements?tab=search" })).body,
    ) as { items: Array<{ title: string }> };
    expect(secondQueue.items.map((item) => item.title)).toEqual(["Поставка НКУ 0,4 кВ"]);

    await app.inject({ method: "POST", url: `/api/profiles/${firstId}/activate` });
    const firstAgain = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/procurements?tab=search" })).body,
    ) as { items: Array<{ title: string }> };
    expect(firstAgain.items.map((item) => item.title)).toEqual(["Поставка НКУ 0,4 кВ"]);

    await app.close();
  });

  it("does not drop another profile queue when discovery scores the same hit as irrelevant", async () => {
    const hits = [
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/keep-other",
        url: "https://goszakupki.by/auction/view/keep-other",
        title: "Поставка НКУ 0,4 кВ",
      }),
    ];
    const removeCases = vi.fn(async (_ids: readonly string[]) => undefined);
    const review = vi.fn(async (reviewed: readonly SearchHit[], profile: { name: string }) =>
      reviewed.map(
        (): ReviewOutcome =>
          profile.name === "Насосы"
            ? {
                verdict: "irrelevant",
                decidedBy: "model",
                reason: "Не для насосов.",
                matchedTerms: [],
                confidence: 0.95,
              }
            : {
                verdict: "relevant",
                decidedBy: "card",
                reason: "В лотах есть НКУ.",
                matchedTerms: ["НКУ"],
                confidence: 1,
              },
      ),
    );
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search: async () => hits },
      searchReview: { review },
      removeCases,
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "НКУ", keywords: ["НКУ"] },
    });
    const firstId = (
      JSON.parse((await app.inject({ method: "GET", url: "/api/profile" })).body) as { id: string }
    ).id;
    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    await vi.waitFor(async () => {
      const listed = await app.inject({ method: "GET", url: "/api/procurements?tab=search" });
      expect(
        (JSON.parse(listed.body).items as Array<{ title: string }>).map((item) => item.title),
      ).toEqual(["Поставка НКУ 0,4 кВ"]);
    });

    const second = JSON.parse((await app.inject({ method: "POST", url: "/api/profiles" })).body) as {
      id: string;
    };
    await app.inject({
      method: "PUT",
      url: `/api/profiles/${second.id}`,
      payload: { name: "Насосы", keywords: ["НКУ"] },
    });
    await app.inject({ method: "POST", url: `/api/profiles/${second.id}/activate` });
    await app.inject({
      method: "POST",
      url: `/api/profiles/${second.id}/watch`,
      payload: { watchNewProcurements: true },
    });

    const ran = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    expect(JSON.parse(ran.body).ran).toBe(true);
    expect(review.mock.calls.some((call) => call[1]?.name === "Насосы")).toBe(true);
    const secondQueue = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/procurements?tab=search" })).body,
    ) as { items: Array<{ title: string }> };
    expect(secondQueue.items).toEqual([]);
    expect(removeCases).not.toHaveBeenCalled();

    await app.inject({ method: "POST", url: `/api/profiles/${firstId}/activate` });
    const firstAgain = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/procurements?tab=search" })).body,
    ) as { items: Array<{ title: string }> };
    expect(firstAgain.items.map((item) => item.title)).toEqual(["Поставка НКУ 0,4 кВ"]);

    await app.close();
  });

  it("asks the source only for procedures posted since the previous pass, and starts over when phrases change", async () => {
    const search = vi.fn(async (_query: { publishedFrom?: string | undefined }) => [] as SearchHit[]);
    let now = "2026-09-09T10:00:00.000Z";
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search },
      clock: () => now,
    });
    await app.inject({ method: "PUT", url: "/api/profile", payload: { name: "КТПБ", keywords: ["КТПБ"] } });
    await app.inject({ method: "POST", url: "/api/profile/watch", payload: { watchNewProcurements: true } });

    await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    now = "2026-09-09T11:00:00.000Z";
    await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    // A save that keeps the phrases keeps the watermark; new phrases drop it.
    await app.inject({ method: "PUT", url: "/api/profile", payload: { name: "КТПБ и НКУ", keywords: ["КТПБ"] } });
    await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    await app.inject({ method: "PUT", url: "/api/profile", payload: { name: "КТПБ и НКУ", keywords: ["КТПБ", "НКУ"] } });
    await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    // Manual search never narrows by the watermark: the specialist asked for everything.
    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });

    const froms = search.mock.calls.map((call) => call[0].publishedFrom);
    expect(froms).toEqual([
      undefined,
      "2026-09-08T00:00:00+03:00",
      "2026-09-08T00:00:00+03:00",
      undefined,
      undefined,
    ]);
    const profile = JSON.parse((await app.inject({ method: "GET", url: "/api/profile" })).body) as {
      lastDiscoveryAt?: string;
    };
    expect(profile.lastDiscoveryAt).toBe("2026-09-09T11:00:00.000Z");

    await app.close();
  });

  it("keeps searching the other profiles when one fails, and reports the failure by name", async () => {
    const journal = createMemoryAdminJournal();
    const search = vi.fn(async (query: { keywords: string[] }) => {
      if (query.keywords.includes("кабель")) {
        throw new McpToolCallError("source_unavailable", "procurement.search", "blocked");
      }
      return [
        SearchHit.parse({
          sourceId: "goszakupki_by",
          sourceProcurementId: "auction/ok-1",
          url: "https://goszakupki.by/auction/view/ok-1",
          title: "Поставка КТПБ-250",
        }),
      ];
    });
    const persistCases = vi.fn(async (_cards: readonly unknown[]) => undefined);
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search },
      journal,
      persistCases,
    });
    await app.inject({ method: "PUT", url: "/api/profile", payload: { name: "Кабель", keywords: ["кабель"] } });
    await app.inject({ method: "POST", url: "/api/profile/watch", payload: { watchNewProcurements: true } });
    const second = JSON.parse((await app.inject({ method: "POST", url: "/api/profiles" })).body) as { id: string };
    await app.inject({ method: "PUT", url: `/api/profiles/${second.id}`, payload: { name: "КТПБ", keywords: ["КТПБ"] } });
    await app.inject({ method: "POST", url: `/api/profiles/${second.id}/watch`, payload: { watchNewProcurements: true } });

    const ran = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const body = JSON.parse(ran.body) as { ran: boolean; addedCount: number; items: Array<{ title: string }> };
    const log = await journal.list();

    expect(ran.statusCode).toBe(200);
    expect(body.addedCount).toBe(1);
    expect(body.items.map((item) => item.title)).toEqual(["Поставка КТПБ-250"]);
    expect(persistCases).toHaveBeenCalled();
    expect(log.some((item) => item.level === "error" && item.message.includes("(Кабель)"))).toBe(true);
    expect(log.some((item) => item.level === "info" && item.message.includes("(КТПБ)"))).toBe(true);
    expect(log.some((item) => item.level === "info" && item.message.includes("Кабель"))).toBe(false);

    // Only when every profile fails does the pass itself fail.
    search.mockRejectedValue(new McpToolCallError("source_unavailable", "procurement.search", "blocked"));
    const allFailed = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    expect(allFailed.statusCode).toBe(503);

    await app.close();
  });

  it("does not ask the card or the model twice about the same hit", async () => {
    const hits = [
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/incubator-2",
        url: "https://goszakupki.by/auction/view/incubator-2",
        title: "СО2-инкубатор",
      }),
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/drop-2",
        url: "https://goszakupki.by/auction/view/drop-2",
        title: "НКУ щитовое",
      }),
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/unclear-2",
        url: "https://goszakupki.by/auction/view/unclear-2",
        title: "Поставка НКУ 0,4 кВ",
      }),
    ];
    const review = vi.fn(async (reviewed: readonly SearchHit[]) =>
      reviewed.map(
        (item): ReviewOutcome =>
          item.sourceProcurementId === "auction/drop-2"
            ? { verdict: "irrelevant", decidedBy: "model", reason: "Щит не для насосов.", matchedTerms: [], confidence: 0.95 }
            : { verdict: "needs_human", decidedBy: "model", reason: "Неясно.", matchedTerms: [], confidence: 0.5 },
      ),
    );
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search: async () => hits },
      searchReview: { review },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "НКУ для управления насосами", keywords: ["НКУ"] },
    });

    const first = await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    expect(JSON.parse(first.body)).toMatchObject({ discardedCount: 1, ambiguousCount: 2 });
    await vi.waitFor(() =>
      expect(
        review.mock.calls.flatMap((call) => call[0]).map((item) => item.sourceProcurementId).sort(),
      ).toEqual(["auction/drop-2", "auction/unclear-2"]),
    );
    await vi.waitFor(async () => {
      const latest = await app.inject({ method: "GET", url: "/api/inbox" });
      expect((JSON.parse(latest.body).items as Array<{ title: string }>).map((item) => item.title)).toEqual([
        "Поставка НКУ 0,4 кВ",
      ]);
    });

    const reviewedAfterFirst = review.mock.calls.length;
    const second = await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    expect(JSON.parse(second.body).ambiguousCount).toBeGreaterThan(0);
    await vi.waitFor(() => expect(review.mock.calls.length).toBeGreaterThan(reviewedAfterFirst));

    // Changing the phrases forgets the irrelevant verdict: the next search asks again.
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "НКУ для управления насосами", keywords: ["НКУ", "ЩО"] },
    });
    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    await vi.waitFor(() => expect(review.mock.calls.length).toBeGreaterThan(reviewedAfterFirst));

    await app.close();
  });

  it("persists inbox rows and restores review cases into the inbox after a restart", async () => {
    const hits = [
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/restart-1",
        url: "https://goszakupki.by/auction/view/restart-1",
        title: "Поставка НКУ 0,4 кВ",
      }),
    ];
    let storedCases: readonly SpecialistProcurementCard[] = [];
    let storedInbox: readonly InboxFixtureItem[] = [];
    const first = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search: async () => hits },
      persistCases: async (cards) => {
        storedCases = cards;
      },
      persistInbox: async (items) => {
        storedInbox = items;
      },
    });
    await first.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "НКУ для управления насосами", keywords: ["НКУ"] },
    });
    await first.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    const workspaceState = JSON.parse(
      (await first.inject({ method: "GET", url: "/api/profile" })).body,
    ) as { id: string };
    await first.close();

    expect(storedCases.map((item) => item.foundAs)).toEqual(["review"]);
    expect(storedInbox).toHaveLength(1);

    // "Restart": a fresh catalog hydrated the way persist.ts does it.
    const catalog = new SpecialistCatalog();
    for (const card of storedCases) catalog.upsertCase(card);
    for (const item of storedInbox) catalog.record(item);
    const second = await buildSpecialistApi({
      catalog,
      workspace: SpecialistWorkspace.parse({
        profiles: [{ id: workspaceState.id, name: "НКУ для управления насосами", keywords: ["НКУ"] }],
        activeProfileId: workspaceState.id,
      }),
      searchHits: { search: async () => hits },
    });
    const inbox = await second.inject({ method: "GET", url: "/api/inbox" });
    const listed = await second.inject({ method: "GET", url: "/api/procurements" });

    // The review case is reachable again through the inbox and still out of the list.
    expect((JSON.parse(inbox.body).items as Array<{ title: string }>).map((item) => item.title)).toEqual([
      "Поставка НКУ 0,4 кВ",
    ]);
    expect(JSON.parse(listed.body).items).toEqual([]);

    await second.close();
  });

  it("does not prune a case the specialist decided on", async () => {
    let now = "2026-09-01T10:00:00.000Z";
    let hits = [
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/keep-1",
        url: "https://goszakupki.by/auction/view/keep-1",
        title: "Поставка КТПБ-250",
      }),
    ];
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      clock: () => now,
      searchHits: { search: async () => hits },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "КТПБ", keywords: ["КТПБ"] },
    });
    const first = await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    const id = (JSON.parse(first.body).items as Array<{ id: string }>)[0]?.id ?? "";
    await app.inject({
      method: "POST",
      url: `/api/procurements/${id}/decision`,
      payload: { kind: "monitor" },
    });

    now = "2026-10-01T10:00:00.000Z";
    hits = [];
    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    const listed = await app.inject({ method: "GET", url: "/api/procurements" });
    const items = JSON.parse(listed.body).items as Array<{ title: string; triage?: string }>;
    expect(items).toEqual([expect.objectContaining({ title: "Поставка КТПБ-250", triage: "monitor" })]);

    await app.close();
  });

  it("drops a finished unused case from the cabinet and keeps one the specialist watches", async () => {
    const catalog = new SpecialistCatalog();
    const closed = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000b01",
      title: "Завершённые взрывчатые вещества",
      status: "completed",
      statusLabel: "завершена",
      url: "https://goszakupki.by/auction/view/closed-dump",
      sourceProcurementId: "auction/closed-dump",
      live: true,
      foundAs: "match",
      lastSeenAt: "2026-09-16T10:00:00.000Z",
    });
    const watched = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000b02",
      title: "Слежу за завершённой КТПБ",
      status: "completed",
      statusLabel: "завершена",
      url: "https://goszakupki.by/auction/view/closed-watch",
      sourceProcurementId: "auction/closed-watch",
      live: true,
      foundAs: "match",
      triage: "monitor",
      lastSeenAt: "2026-09-16T10:00:00.000Z",
    });
    catalog.upsertCase(closed);
    catalog.upsertCase(watched);
    const removeCases = vi.fn(async (_ids: readonly string[]) => undefined);
    const app = await buildSpecialistApi({
      catalog,
      removeCases,
      clock: () => "2026-09-16T12:00:00.000Z",
    });

    const listed = await app.inject({ method: "GET", url: "/api/procurements" });
    const items = JSON.parse(listed.body).items as Array<{ title: string; triage?: string }>;

    expect(items.map((item) => item.title)).toEqual(["Слежу за завершённой КТПБ"]);
    expect(removeCases).toHaveBeenCalledWith([closed.id], expect.any(String));

    await app.close();
  });

  it("shows an explicitly requested finished match and keeps it in the search queue", async () => {
    const persistCases = vi.fn(async (_cards: readonly unknown[]) => undefined);
    const review = vi.fn(async (): Promise<ReviewOutcome[]> => [
      {
        verdict: "relevant",
        decidedBy: "card",
        reason: "В лотах есть НКУ.",
        matchedTerms: ["НКУ"],
        confidence: 1,
        status: "completed",
      },
    ]);
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      persistCases,
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/closed-hit",
            url: "https://goszakupki.by/auction/view/closed-hit",
            title: "Поставка НКУ для насосов",
          }),
        ],
      },
      searchReview: { review },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: {
        name: "НКУ для управления насосами",
        keywords: ["НКУ"],
        statuses: ["completed"],
      },
    });
    persistCases.mockClear();
    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    await vi.waitFor(async () => {
      const progress = JSON.parse(
        (await app.inject({ method: "GET", url: "/api/procurements/search/progress" })).body,
      ) as { status: string };
      expect(progress.status).toBe("done");
    });
    const searched = await app.inject({ method: "GET", url: "/api/procurements?tab=search" });
    const stored = (persistCases.mock.calls as unknown[][]).flatMap((call) => {
      const cards = call[0];
      return Array.isArray(cards) ? (cards as Array<{ sourceProcurementId?: string }>) : [];
    });

    expect(JSON.parse(searched.body).items).toEqual([
      expect.objectContaining({
        sourceProcurementId: "auction/closed-hit",
        status: "completed",
      }),
    ]);
    expect(stored.some((card) => card.sourceProcurementId === "auction/closed-hit")).toBe(true);

    await app.close();
  });

  it("returns delivery and warranty from the live Word TZ and does not treat 99.5% cap as advance", async () => {
    const catalog = await loadFixtureCatalog();
    const live = catalog
      .procurements()
      .find((item) => item.sourceProcurementId === "auction/3629820");
    expect(live).toBeDefined();
    const app = await buildSpecialistApi({ catalog });
    const card = await app.inject({ method: "GET", url: `/api/procurements/${live?.id ?? ""}` });
    const body = JSON.parse(card.body) as { termsDetail?: string; paymentQuote?: string };

    expect(card.statusCode).toBe(200);
    expect(body.termsDetail).toContain("Аванс: до 99,5%.");
    expect(body.termsDetail).toContain("Гарантия: 60 мес.");
    expect(body.termsDetail ?? "").not.toMatch(/Аванс:\s*99,5%\./);
    expect(body.paymentQuote).toContain("предоплата до 99,5");
    expect(body.paymentQuote ?? "").not.toMatch(/_/);

    await app.close();
  });

  it("searches by the saved profile and ignores keywords in the request body", async () => {
    const app = await buildSpecialistApi({ catalog: await loadFixtureCatalog() });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: {
        name: "Электротехническое оборудование",
        keywords: electricalEquipmentSeedV1.keywords,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: { keywords: ["кабель"], limit: 20 },
    });
    const body = JSON.parse(response.body) as {
      profileName: string;
      relevantCount: number;
      discardedCount: number;
      ambiguousCount: number;
      items: Array<{ title: string; sourceProcurementId: string }>;
    };

    expect(response.statusCode).toBe(200);
    expect(body.profileName).toBe("Электротехническое оборудование");
    expect(body.relevantCount).toBe(1);
    // Cable has no profile object. It is not a match; review may still open
    // the card because the platform can return a row matched on lot subject.
    // Finished or announced hits are dropped by the default status filter.
    expect(body.ambiguousCount).toBe(1);
    expect(body.discardedCount).toBe(2);
    expect(body.items.map((item) => item.title)).toEqual([
      "Комплектная трансформаторная подстанция",
    ]);
    const inbox = await app.inject({ method: "GET", url: "/api/inbox" });
    const inboxTitles = (JSON.parse(inbox.body).items as Array<{ title: string }>).map(
      (item) => item.title,
    );
    expect(inboxTitles).toContain("Кабель силовой");

    const listed = await app.inject({ method: "GET", url: "/api/procurements" });
    const titles = (JSON.parse(listed.body).items as Array<{ title: string }>).map(
      (item) => item.title,
    );
    expect(titles).toContain("Комплектная трансформаторная подстанция");
    expect(titles).toContain("Бытовой щиток");

    const invalid = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: { limit: 0 },
    });
    expect(invalid.statusCode).toBe(400);

    await app.close();
  });

  it("searches with saved profile keywords and does not re-list a rejected procedure", async () => {
    const app = await buildSpecialistApi({ catalog: new SpecialistCatalog() });

    const saved = await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"], excludeKeywords: [] },
    });
    const watchOff = await app.inject({ method: "GET", url: "/api/profile" });
    const searched = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: { limit: 20 },
    });
    const found = JSON.parse(searched.body).items as Array<{
      id: string;
      title: string;
      sourceProcurementId: string;
    }>;
    const cable = found.find((item) => item.title === "Кабель силовой");
    const rejected = await app.inject({
      method: "POST",
      url: `/api/procurements/${cable?.id ?? ""}/decision`,
      payload: { kind: "reject" },
    });
    const afterReject = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: { limit: 20 },
    });
    const remaining = JSON.parse(afterReject.body).items as Array<{ title: string }>;

    expect(saved.statusCode).toBe(200);
    expect(JSON.parse(watchOff.body).watchNewProcurements).toBe(false);
    expect(JSON.parse(watchOff.body).keywords).toEqual(["кабель"]);
    expect(JSON.parse(saved.body).keywords).toEqual(["кабель"]);
    expect(searched.statusCode).toBe(200);
    // A title without the object is not a match. It may wait in review so
    // procurement.get can read lot subject; it is not listed as found.
    expect(found.some((item) => item.title === "Комплектная трансформаторная подстанция")).toBe(
      false,
    );
    const inbox = await app.inject({ method: "GET", url: "/api/inbox" });
    expect(
      (JSON.parse(inbox.body).items as Array<{ title: string }>).some(
        (item) => item.title === "Комплектная трансформаторная подстанция",
      ),
    ).toBe(true);
    expect(cable).toBeDefined();
    expect(rejected.statusCode).toBe(200);
    expect(remaining.some((item) => item.title === "Кабель силовой")).toBe(false);

    await app.close();
  });

  it("ingests documents only after participate, not after monitor", async () => {
    const found = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/401",
      sourceProcurementId: "auction/401",
      live: true,
    });
    const catalog = new SpecialistCatalog();
    catalog.upsertCase(found);
    const ingest = vi.fn(async (card: typeof found) =>
      SpecialistProcurementCard.parse({
        ...card,
        documents: [
          {
            name: "ТЗ.pdf",
            sourceUrl: "https://goszakupki.by/files/401",
            hash: "a".repeat(64),
            sizeBytes: 12,
            status: "hashed",
          },
        ],
        actions: [
          ...card.actions,
          {
            step: 2,
            actor: "DocumentAgent",
            status: "done",
            detail: "procurement.get_documents: 1 файл(ов), скачано: 1, ошибок: 0, разобрано: 0.",
          },
        ],
      }),
    );
    const app = await buildSpecialistApi({
      catalog,
      documentIngest: { ingest },
    });

    const monitored = await app.inject({
      method: "POST",
      url: `/api/procurements/${found.id}/decision`,
      payload: { kind: "monitor" },
    });
    const participated = await app.inject({
      method: "POST",
      url: `/api/procurements/${found.id}/decision`,
      payload: { kind: "participate" },
    });
    const stored = await waitForCase(app, found.id, (body) => {
      expect(body["documents"]).toEqual([
        expect.objectContaining({ name: "ТЗ.pdf", status: "hashed" }),
      ]);
    });

    expect(monitored.statusCode).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(participated.statusCode).toBe(200);
    expect(JSON.parse(participated.body).items[0]?.triage).toBe("participate");
    expect(stored["documents"]).toEqual([
      expect.objectContaining({ name: "ТЗ.pdf", status: "hashed" }),
    ]);

    await app.close();
  });

  it("stores the platform card on participate before documents are ingested", async () => {
    const found = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Строка из поиска",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/request/view/3545600",
      sourceProcurementId: "request/3545600",
      live: true,
      amountLabel: "105 292.65 BYN",
    });
    const catalog = new SpecialistCatalog();
    catalog.upsertCase(found);
    const live = ProcedureCard.parse({
      sourceId: "goszakupki_by",
      sourceProcurementId: "request/3545600",
      url: "https://goszakupki.by/request/view/3545600",
      title: "Реконструкция ВЛ-0,4 кВ от КТП-129",
      fetchedAt: "2026-09-11T00:00:00.000Z",
      status: "accepting_bids",
      buyer: {
        name: "Брестэнерго",
        registrationNumber: "200050653",
        address: "г. Брест, ул. Воровского, 13/1",
        contact: "Головко Р. Г., +375333869267",
      },
      amount: { kind: "indicative", amount: 160651.42, currency: "BYN", raw: "160 651.42 BYN" },
    });
    const ingest = vi.fn(async (card: typeof found) => {
      expect(card.sourceCard?.buyer?.registrationNumber).toBe("200050653");
      return SpecialistProcurementCard.parse({
        ...card,
        documents: [
          {
            name: "ТЗ.pdf",
            sourceUrl: "https://goszakupki.by/files/1",
            hash: "a".repeat(64),
            status: "hashed",
          },
        ],
      });
    });
    const app = await buildSpecialistApi({
      catalog,
      documentIngest: { ingest },
      cardWatch: { read: async () => live },
    });

    const participated = await app.inject({
      method: "POST",
      url: `/api/procurements/${found.id}/decision`,
      payload: { kind: "participate" },
    });
    const items = JSON.parse(participated.body).items as Array<{
      amountLabel?: string;
      sourceCard?: { buyer?: { registrationNumber?: string } };
      documents?: Array<{ name: string }>;
    }>;
    await waitForCase(app, found.id, (body) => {
      expect(body["documents"]).toEqual([expect.objectContaining({ name: "ТЗ.pdf" })]);
    });

    expect(participated.statusCode).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(items[0]?.amountLabel).toBe("160 651.42 BYN");
    expect(items[0]?.sourceCard?.buyer?.registrationNumber).toBe("200050653");

    await app.close();
  });

  it("downloads documents even when reading the platform card fails", async () => {
    const found = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/401",
      sourceProcurementId: "auction/401",
      live: true,
    });
    const catalog = new SpecialistCatalog();
    catalog.upsertCase(found);
    const ingest = vi.fn(async (card: typeof found) =>
      SpecialistProcurementCard.parse({
        ...card,
        documents: [
          {
            name: "ТЗ.pdf",
            sourceUrl: "https://goszakupki.by/files/401",
            hash: "a".repeat(64),
            status: "hashed",
          },
        ],
      }),
    );
    const app = await buildSpecialistApi({
      catalog,
      documentIngest: { ingest },
      cardWatch: {
        read: async () => {
          throw new Error("source down");
        },
      },
    });

    const participated = await app.inject({
      method: "POST",
      url: `/api/procurements/${found.id}/decision`,
      payload: { kind: "participate" },
    });
    await waitForCase(app, found.id, (body) => {
      expect(body["documents"]).toEqual([expect.objectContaining({ name: "ТЗ.pdf" })]);
    });

    expect(participated.statusCode).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("exposes ingest progress while participate is still running", async () => {
    const found = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/401",
      sourceProcurementId: "auction/401",
      live: true,
    });
    const catalog = new SpecialistCatalog();
    catalog.upsertCase(found);
    const holder: { app?: Awaited<ReturnType<typeof buildSpecialistApi>> } = {};
    const ingest = vi.fn(async (card: typeof found) => {
      const mid = await holder.app?.inject({
        method: "GET",
        url: `/api/procurements/${found.id}/ingest-progress`,
      });
      expect(mid?.statusCode).toBe(200);
      expect(JSON.parse(mid?.body ?? "{}").phase).toBe("listing");
      return card;
    });
    const app = await buildSpecialistApi({
      catalog,
      documentIngest: { ingest },
    });
    holder.app = app;

    const idle = await app.inject({
      method: "GET",
      url: `/api/procurements/${found.id}/ingest-progress`,
    });
    const participated = await app.inject({
      method: "POST",
      url: `/api/procurements/${found.id}/decision`,
      payload: { kind: "participate" },
    });
    await vi.waitFor(async () => {
      const done = await app.inject({
        method: "GET",
        url: `/api/procurements/${found.id}/ingest-progress`,
      });
      expect(JSON.parse(done.body).phase).toBe("done");
      expect(JSON.parse(done.body).percent).toBe(100);
    });

    expect(JSON.parse(idle.body).phase).toBe("idle");
    expect(participated.statusCode).toBe(200);

    await app.close();
  });

  it("keeps participate ingest running after the decision request returns", async () => {
    const found = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/401",
      sourceProcurementId: "auction/401",
      live: true,
    });
    const catalog = new SpecialistCatalog();
    catalog.upsertCase(found);
    let release: ((card: typeof found) => void) | undefined;
    const ingest = vi.fn(
      () =>
        new Promise<typeof found>((resolve) => {
          release = resolve;
        }),
    );
    const app = await buildSpecialistApi({
      catalog,
      documentIngest: { ingest },
    });

    const participated = await app.inject({
      method: "POST",
      url: `/api/procurements/${found.id}/decision`,
      payload: { kind: "participate" },
    });
    const mid = await app.inject({
      method: "GET",
      url: `/api/procurements/${found.id}/ingest-progress`,
    });

    expect(participated.statusCode).toBe(200);
    expect(JSON.parse(participated.body).items[0]?.documents).toEqual([]);
    expect(JSON.parse(participated.body).items[0]?.triage).toBe("participate");
    expect(JSON.parse(mid.body).phase).toBe("listing");

    release?.(
      SpecialistProcurementCard.parse({
        ...found,
        triage: "participate",
        documents: [
          {
            name: "ТЗ.pdf",
            sourceUrl: "https://goszakupki.by/files/401",
            hash: "a".repeat(64),
            status: "hashed",
          },
        ],
      }),
    );
    await waitForCase(app, found.id, (body) => {
      expect(body["documents"]).toEqual([expect.objectContaining({ name: "ТЗ.pdf" })]);
    });

    await app.close();
  });

  it("reindexes stored files on refresh without downloading again", async () => {
    const found = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/401",
      sourceProcurementId: "auction/401",
      live: true,
      triage: "participate",
      documents: [
        {
          name: "ТЗ.pdf",
          sourceUrl: "https://goszakupki.by/files/401",
          hash: "a".repeat(64),
          status: "hashed",
        },
      ],
    });
    const catalog = new SpecialistCatalog();
    catalog.upsertCase(found);
    const ingest = vi.fn(async (card: typeof found) => card);
    const reindex = vi.fn(async (card: typeof found) =>
      SpecialistProcurementCard.parse({
        ...card,
        documents: [
          {
            name: "ТЗ.pdf",
            sourceUrl: "https://goszakupki.by/files/401",
            hash: "a".repeat(64),
            status: "hashed",
            note: "reindexed",
          },
        ],
      }),
    );
    const app = await buildSpecialistApi({
      catalog,
      documentIngest: { ingest, reindex },
    });

    const refreshed = await app.inject({
      method: "POST",
      url: `/api/procurements/${found.id}/reindex`,
    });
    await waitForCase(app, found.id, (body) => {
      expect(body["documents"]).toEqual([
        expect.objectContaining({ name: "ТЗ.pdf", note: "reindexed" }),
      ]);
    });

    expect(refreshed.statusCode).toBe(200);
    expect(ingest).not.toHaveBeenCalled();
    expect(reindex).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("downloads files on refresh when the participate case has none hashed", async () => {
    const found = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/401",
      sourceProcurementId: "auction/401",
      live: true,
      triage: "participate",
    });
    const catalog = new SpecialistCatalog();
    catalog.upsertCase(found);
    const ingest = vi.fn(async (card: typeof found) =>
      SpecialistProcurementCard.parse({
        ...card,
        documents: [
          {
            name: "ТЗ.pdf",
            sourceUrl: "https://goszakupki.by/files/401",
            hash: "a".repeat(64),
            status: "hashed",
          },
        ],
      }),
    );
    const reindex = vi.fn(async (card: typeof found) => card);
    const app = await buildSpecialistApi({
      catalog,
      documentIngest: { ingest, reindex },
    });

    const refreshed = await app.inject({
      method: "POST",
      url: `/api/procurements/${found.id}/reindex`,
    });
    await waitForCase(app, found.id, (body) => {
      expect(body["documents"]).toEqual([expect.objectContaining({ name: "ТЗ.pdf" })]);
    });

    expect(refreshed.statusCode).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(reindex).not.toHaveBeenCalled();

    await app.close();
  });

  it("does not reindex files when refreshing a watched case", async () => {
    const found = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/401",
      sourceProcurementId: "auction/401",
      live: true,
      triage: "monitor",
      documents: [
        {
          name: "ТЗ.pdf",
          sourceUrl: "https://goszakupki.by/files/401",
          hash: "a".repeat(64),
          status: "hashed",
        },
      ],
    });
    const catalog = new SpecialistCatalog();
    catalog.upsertCase(found);
    const ingest = vi.fn(async (card: typeof found) => card);
    const reindex = vi.fn(async (card: typeof found) => card);
    const app = await buildSpecialistApi({
      catalog,
      documentIngest: { ingest, reindex },
    });

    const refreshed = await app.inject({
      method: "POST",
      url: `/api/procurements/${found.id}/reindex`,
    });

    expect(refreshed.statusCode).toBe(200);
    expect(ingest).not.toHaveBeenCalled();
    expect(reindex).not.toHaveBeenCalled();

    await app.close();
  });

  it("starts with an empty profile and can add a second empty direction", async () => {
    const app = await buildSpecialistApi({ catalog: new SpecialistCatalog() });

    const first = await app.inject({ method: "GET", url: "/api/profile" });
    const created = await app.inject({ method: "POST", url: "/api/profiles" });
    const listed = await app.inject({ method: "GET", url: "/api/profiles" });
    const body = JSON.parse(listed.body) as {
      items: Array<{ id: string; name: string; keywords: string[] }>;
      activeProfileId: string;
    };

    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body).name).toBe("");
    expect(JSON.parse(first.body).keywords).toEqual([]);
    expect(created.statusCode).toBe(200);
    expect(JSON.parse(created.body).keywords).toEqual([]);
    expect(body.items).toHaveLength(2);
    expect(body.activeProfileId).toBe(JSON.parse(created.body).id);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/profiles/${JSON.parse(created.body).id}`,
    });
    const afterRemove = JSON.parse(removed.body) as {
      items: Array<{ id: string }>;
      activeProfileId: string;
    };
    const last = await app.inject({
      method: "DELETE",
      url: `/api/profiles/${afterRemove.activeProfileId}`,
    });

    expect(removed.statusCode).toBe(200);
    expect(afterRemove.items).toHaveLength(1);
    expect(afterRemove.activeProfileId).toBe(JSON.parse(first.body).id);
    expect(last.statusCode).toBe(409);

    await app.close();
  });

  it("ties a found case to the profile that searched for it", async () => {
    const app = await buildSpecialistApi({ catalog: new SpecialistCatalog() });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: {
        name: "Подстанции",
        keywords: electricalEquipmentSeedV1.keywords,
      },
    });
    const profile = JSON.parse((await app.inject({ method: "GET", url: "/api/profile" })).body) as {
      id: string;
    };
    const searched = await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    const items = JSON.parse(searched.body).items as Array<{
      title: string;
      profileIds: string[];
    }>;
    const station = items.find((item) => item.title.includes("подстанция"));

    expect(searched.statusCode).toBe(200);
    expect(station?.profileIds).toEqual([profile.id]);
    await app.close();
  });

  it("keeps edited platform keywords and fills them from looking-for when empty", async () => {
    const app = await buildSpecialistApi({ catalog: new SpecialistCatalog() });

    const edited = await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: {
        name: "Кабель",
        description: "кабель силовой",
        keywords: ["кабель"],
        excludeKeywords: [],
      },
    });
    const derived = await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: {
        name: "Кабель",
        description: "кабель",
        keywords: [],
        excludeKeywords: [],
      },
    });

    expect(edited.statusCode).toBe(200);
    expect(JSON.parse(edited.body).keywords).toEqual(["кабель"]);
    expect(derived.statusCode).toBe(200);
    expect(JSON.parse(derived.body).keywords).toEqual(["кабель"]);

    await app.close();
  });

  it("does not discover new procurements until watch is turned on and then skips judged ids", async () => {
    const journal = createMemoryAdminJournal();
    const app = await buildSpecialistApi({ catalog: new SpecialistCatalog(), journal });

    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: {
        name: "Электротехническое оборудование",
        keywords: electricalEquipmentSeedV1.keywords,
      },
    });
    const idle = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const enabled = await app.inject({
      method: "POST",
      url: "/api/profile/watch",
      payload: { watchNewProcurements: true },
    });
    const first = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const items = JSON.parse(first.body).items as Array<{ id: string; title: string }>;
    const substation = items.find((item) => item.title === "Комплектная трансформаторная подстанция");
    const inboxAfterFind = await app.inject({ method: "GET", url: "/api/inbox" });
    const decided = await app.inject({
      method: "POST",
      url: `/api/procurements/${substation?.id ?? ""}/decision`,
      payload: { kind: "monitor" },
    });
    const second = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });

    expect(idle.statusCode).toBe(200);
    expect(JSON.parse(idle.body).ran).toBe(false);
    expect(JSON.parse(idle.body).reason).toBe("watch_off");
    expect(JSON.parse(idle.body).items).toEqual([]);
    expect(enabled.statusCode).toBe(200);
    expect(JSON.parse(enabled.body).watchNewProcurements).toBe(true);
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body).ran).toBe(true);
    expect(JSON.parse(first.body).addedCount).toBeGreaterThanOrEqual(1);
    expect(substation).toBeDefined();
    expect(decided.statusCode).toBe(200);
    expect(JSON.parse(second.body).ran).toBe(true);
    expect(JSON.parse(second.body).addedCount).toBe(0);
    expect(JSON.parse(second.body).skippedDecidedCount).toBeGreaterThanOrEqual(1);
    const foundRows = JSON.parse(inboxAfterFind.body).items as Array<{
      topic: string;
      procurementId: string;
    }>;
    expect(foundRows.some((item) => item.topic === "new_found")).toBe(true);
    const inboxAfterDecide = await app.inject({ method: "GET", url: "/api/inbox" });
    expect(
      (JSON.parse(inboxAfterDecide.body).items as Array<{ procurementId: string }>).some(
        (item) => item.procurementId === substation?.id,
      ),
    ).toBe(false);
    const log = await journal.list();
    expect(log.some((item) => item.kind === "discovery" && item.message.includes("Фоновый поиск выполнен"))).toBe(
      true,
    );
    expect(log.some((item) => item.message.includes("watch_off"))).toBe(false);

    await app.close();
  });

  it("monitors a decided case and reports a real change once", async () => {
    const journal = createMemoryAdminJournal();
    const accepting = ProcedureCard.parse({
      sourceId: "goszakupki_by",
      sourceProcurementId: "auction/777",
      url: "https://goszakupki.by/auction/view/auction-777",
      title: "Поставка кабеля",
      fetchedAt: "2026-09-10T00:00:00.000Z",
      status: "accepting_bids",
      amount: { kind: "limit", amount: null, raw: "1 000,00 BYN" },
    });
    const cancelled = ProcedureCard.parse({
      sourceId: "goszakupki_by",
      sourceProcurementId: "auction/777",
      url: "https://goszakupki.by/auction/view/auction-777",
      title: "Поставка кабеля",
      fetchedAt: "2026-09-11T00:00:00.000Z",
      status: "cancelled",
      amount: { kind: "limit", amount: null, raw: "1 000.00 BYN" },
    });
    const read = vi
      .fn()
      .mockResolvedValueOnce(accepting)
      .mockResolvedValueOnce(accepting)
      .mockResolvedValueOnce(cancelled);
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      journal,
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/777",
            url: "https://goszakupki.by/auction/view/auction-777",
            title: "Кабель ВВГнг 4х50",
            status: "accepting_bids",
          }),
        ],
      },
      cardWatch: { read },
    });

    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"] },
    });
    await app.inject({
      method: "POST",
      url: "/api/profile/watch",
      payload: { watchNewProcurements: true },
    });
    const found = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const cardId = (JSON.parse(found.body).items as Array<{ id: string }>)[0]?.id;
    const decided = await app.inject({
      method: "POST",
      url: `/api/procurements/${cardId ?? ""}/decision`,
      payload: { kind: "monitor" },
    });
    const decidedItems = JSON.parse(decided.body).items as Array<{ triage?: string }>;
    expect(decidedItems[0]?.triage).toBe("monitor");

    const second = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const third = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const inbox = await app.inject({ method: "GET", url: "/api/inbox" });
    const rows = JSON.parse(inbox.body).items as Array<{
      topic: string;
      summary: string;
      detail: string;
    }>;

    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).monitoredCount).toBe(1);
    expect(JSON.parse(second.body).changedCount).toBe(0);
    expect(third.statusCode).toBe(200);
    expect(JSON.parse(third.body).monitoredCount).toBe(1);
    expect(JSON.parse(third.body).changedCount).toBe(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(rows.some((item) => item.topic === "card_update")).toBe(true);
    expect(rows.some((item) => item.summary.includes("Статус"))).toBe(true);
    const log = await journal.list();
    expect(log.some((item) => item.message.includes("Проверено отслеживаемых"))).toBe(true);

    await app.close();
  });

  it("routes the watch pass to monitorWatch and interactive reads to cardWatch", async () => {
    const live = ProcedureCard.parse({
      sourceId: "goszakupki_by",
      sourceProcurementId: "auction/778",
      url: "https://goszakupki.by/auction/view/auction-778",
      title: "Поставка трансформатора",
      fetchedAt: "2026-09-10T00:00:00.000Z",
      status: "accepting_bids",
      amount: { kind: "limit", amount: null, raw: "1 000,00 BYN" },
    });
    const interactiveRead = vi.fn().mockResolvedValue(live);
    const monitorRead = vi.fn().mockResolvedValue(live);
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      journal: createMemoryAdminJournal(),
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/778",
            url: "https://goszakupki.by/auction/view/auction-778",
            title: "Трансформатор",
            status: "accepting_bids",
          }),
        ],
      },
      cardWatch: { read: interactiveRead },
      monitorWatch: { read: monitorRead },
    });

    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Трансформаторы", keywords: ["трансформатор"] },
    });
    await app.inject({
      method: "POST",
      url: "/api/profile/watch",
      payload: { watchNewProcurements: true },
    });
    const found = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const cardId = (JSON.parse(found.body).items as Array<{ id: string }>)[0]?.id;
    await app.inject({
      method: "POST",
      url: `/api/procurements/${cardId ?? ""}/decision`,
      payload: { kind: "monitor" },
    });
    // Decision hydrate is interactive: it must not hit the background lane.
    expect(interactiveRead).toHaveBeenCalledTimes(1);
    expect(monitorRead).not.toHaveBeenCalled();

    const monitored = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    expect(JSON.parse(monitored.body).monitoredCount).toBe(1);
    expect(monitorRead).toHaveBeenCalledTimes(1);
    expect(interactiveRead).toHaveBeenCalledTimes(1);

    // A stored platform card opens without another live read; ?fresh=1 is
    // the explicit refresh and goes to the interactive lane.
    const stored = await app.inject({ method: "GET", url: `/api/procurements/${cardId ?? ""}/card` });
    expect(stored.statusCode).toBe(200);
    expect(interactiveRead).toHaveBeenCalledTimes(1);

    await app.inject({ method: "GET", url: `/api/procurements/${cardId ?? ""}/card?fresh=1` });
    expect(interactiveRead).toHaveBeenCalledTimes(2);
    expect(monitorRead).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("serves the platform card fetched during review on open and refetches only on fresh", async () => {
    const reviewed = ProcedureCard.parse({
      sourceId: "goszakupki_by",
      sourceProcurementId: "auction/ktp-stored",
      url: "https://goszakupki.by/auction/view/ktp-stored",
      title: "Поставка КТП — карточка, прочитанная при проверке",
      fetchedAt: "2026-09-10T00:00:00.000Z",
      status: "accepting_bids",
    });
    const refetched = ProcedureCard.parse({
      ...reviewed,
      title: "Поставка КТП — свежее чтение",
      fetchedAt: "2026-09-10T01:00:00.000Z",
    });
    const read = vi.fn().mockResolvedValue(refetched);
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/ktp-stored",
            url: "https://goszakupki.by/auction/view/ktp-stored",
            title: "Поставка КТП",
            status: "accepting_bids",
          }),
        ],
      },
      searchReview: {
        review: async (hits) =>
          hits.map(
            (): ReviewOutcome => ({
              verdict: "relevant",
              decidedBy: "card",
              reason: "Профильный предмет в лоте.",
              matchedTerms: ["КТП"],
              confidence: 1,
              score: 90,
              card: reviewed,
            }),
          ),
      },
      cardWatch: { read },
    });

    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "КТП", keywords: ["КТП"] },
    });
    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });

    let cardId: string | undefined;
    await vi.waitFor(async () => {
      const queue = await app.inject({ method: "GET", url: "/api/procurements?tab=search" });
      const items = JSON.parse(queue.body).items as Array<{ id: string }>;
      expect(items).toHaveLength(1);
      cardId = items[0]?.id;
    });

    const opened = await app.inject({ method: "GET", url: `/api/procurements/${cardId ?? ""}/card` });
    expect(opened.statusCode).toBe(200);
    expect(JSON.parse(opened.body).title).toBe("Поставка КТП — карточка, прочитанная при проверке");
    expect(read).not.toHaveBeenCalled();

    const fresh = await app.inject({
      method: "GET",
      url: `/api/procurements/${cardId ?? ""}/card?fresh=1`,
    });
    expect(JSON.parse(fresh.body).title).toBe("Поставка КТП — свежее чтение");
    expect(read).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("reports a new document on a watched case and does not download on monitor", async () => {
    const ingest = vi.fn(async (card: SpecialistProcurementCard) => card);
    const withFiles = (files: Array<{ name: string; sourceUrl: string }>) =>
      ProcedureCard.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/780",
        url: "https://goszakupki.by/auction/view/auction-780",
        title: "Поставка кабеля",
        fetchedAt: "2026-09-10T00:00:00.000Z",
        status: "accepting_bids",
        listedDocuments: files,
      });
    const first = withFiles([{ name: "ТЗ.pdf", sourceUrl: "https://goszakupki.by/files/1" }]);
    const second = withFiles([
      { name: "ТЗ.pdf", sourceUrl: "https://goszakupki.by/files/1" },
      { name: "Изменения.pdf", sourceUrl: "https://goszakupki.by/files/2" },
    ]);
    const read = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(first).mockResolvedValue(second);
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/780",
            url: "https://goszakupki.by/auction/view/auction-780",
            title: "Кабель ВВГнг 4х50",
            status: "accepting_bids",
          }),
        ],
      },
      cardWatch: { read },
      documentIngest: { ingest },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"] },
    });
    await app.inject({
      method: "POST",
      url: "/api/profile/watch",
      payload: { watchNewProcurements: true },
    });
    const found = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const cardId = (JSON.parse(found.body).items as Array<{ id: string }>)[0]?.id;
    await app.inject({
      method: "POST",
      url: `/api/procurements/${cardId ?? ""}/decision`,
      payload: { kind: "monitor" },
    });
    await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const third = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const inbox = await app.inject({ method: "GET", url: "/api/inbox" });
    const rows = JSON.parse(inbox.body).items as Array<{ topic: string; summary: string }>;

    expect(JSON.parse(third.body).changedCount).toBe(1);
    expect(rows.some((item) => item.topic === "documents" && item.summary.includes("документ"))).toBe(
      true,
    );
    expect(ingest).not.toHaveBeenCalled();

    await app.close();
  });

  it("reports an expired acceptance deadline once even while the platform still accepts bids", async () => {
    let now = "2026-09-18T08:00:00.000Z";
    const card = ProcedureCard.parse({
      sourceId: "goszakupki_by",
      sourceProcurementId: "auction/782",
      url: "https://goszakupki.by/auction/view/auction-782",
      title: "Поставка кабеля",
      fetchedAt: "2026-09-10T00:00:00.000Z",
      // The platform keeps «приём заявок» on the page after the window closed.
      status: "accepting_bids",
      bidsDeadline: { precision: "date_time", at: "2026-09-18T12:00:00.000Z" },
    });
    const read = vi.fn().mockResolvedValue(card);
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      clock: () => now,
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/782",
            url: "https://goszakupki.by/auction/view/auction-782",
            title: "Кабель ВВГнг 4х50",
            status: "accepting_bids",
          }),
        ],
      },
      cardWatch: { read },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"] },
    });
    await app.inject({
      method: "POST",
      url: "/api/profile/watch",
      payload: { watchNewProcurements: true },
    });
    const found = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const cardId = (JSON.parse(found.body).items as Array<{ id: string }>)[0]?.id;
    await app.inject({
      method: "POST",
      url: `/api/procurements/${cardId ?? ""}/decision`,
      payload: { kind: "monitor" },
    });
    // First pass at 08:00 stores the snapshot; the deadline is still ahead.
    await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const before = await app.inject({ method: "GET", url: "/api/inbox" });
    expect(
      (JSON.parse(before.body).items as Array<{ summary: string }>).some((item) =>
        item.summary.includes("Срок подачи"),
      ),
    ).toBe(false);

    now = "2026-09-18T13:00:00.000Z";
    await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const inbox = await app.inject({ method: "GET", url: "/api/inbox" });
    const expired = (
      JSON.parse(inbox.body).items as Array<{ title: string; summary: string }>
    ).filter((item) => item.summary.includes("Срок подачи"));
    expect(expired).toHaveLength(1);
    expect(expired[0]?.summary).toContain("истёк");

    now = "2026-09-18T14:00:00.000Z";
    await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const again = await app.inject({ method: "GET", url: "/api/inbox" });
    expect(
      (JSON.parse(again.body).items as Array<{ summary: string }>).filter((item) =>
        item.summary.includes("Срок подачи"),
      ),
    ).toHaveLength(1);

    await app.close();
  });

  it("still reports a deadline that expired before the stored snapshot was taken", async () => {
    // The case was decided after its window had already closed: the snapshot
    // timestamp is past the deadline, so a transition-only check would never
    // see the crossing. The state check still owes the specialist one row.
    let now = "2026-09-18T13:00:00.000Z";
    const card = ProcedureCard.parse({
      sourceId: "goszakupki_by",
      sourceProcurementId: "auction/785",
      url: "https://goszakupki.by/auction/view/auction-785",
      title: "Поставка кабеля",
      fetchedAt: "2026-09-10T00:00:00.000Z",
      status: "accepting_bids",
      bidsDeadline: { precision: "date_time", at: "2026-09-18T12:00:00.000Z" },
    });
    const read = vi.fn().mockResolvedValue(card);
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      clock: () => now,
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/785",
            url: "https://goszakupki.by/auction/view/auction-785",
            title: "Кабель ВВГнг 4х50",
            status: "accepting_bids",
          }),
        ],
      },
      cardWatch: { read },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"] },
    });
    await app.inject({
      method: "POST",
      url: "/api/profile/watch",
      payload: { watchNewProcurements: true },
    });
    const found = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const cardId = (JSON.parse(found.body).items as Array<{ id: string }>)[0]?.id;
    await app.inject({
      method: "POST",
      url: `/api/procurements/${cardId ?? ""}/decision`,
      payload: { kind: "monitor" },
    });

    await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const inbox = await app.inject({ method: "GET", url: "/api/inbox" });
    const expired = (
      JSON.parse(inbox.body).items as Array<{ summary: string }>
    ).filter((item) => item.summary.includes("Срок подачи"));
    expect(expired).toHaveLength(1);
    expect(expired[0]?.summary).toContain("истёк");

    now = "2026-09-18T15:00:00.000Z";
    await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const again = await app.inject({ method: "GET", url: "/api/inbox" });
    expect(
      (JSON.parse(again.body).items as Array<{ summary: string }>).filter((item) =>
        item.summary.includes("Срок подачи"),
      ),
    ).toHaveLength(1);

    await app.close();
  });

  it("warns a participating case a day ahead but stays quiet on a monitor-only one", async () => {
    const now = "2026-09-18T08:00:00.000Z";
    const card = (id: string) =>
      ProcedureCard.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: `auction/${id}`,
        url: `https://goszakupki.by/auction/view/auction-${id}`,
        title: `Поставка кабеля ${id}`,
        fetchedAt: "2026-09-10T00:00:00.000Z",
        status: "accepting_bids",
        bidsDeadline: { precision: "date_time", at: "2026-09-19T12:00:00.000Z" },
      });
    const read = vi.fn(async (id: string) => card(id.replace("auction/", "")));
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      clock: () => now,
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/783",
            url: "https://goszakupki.by/auction/view/auction-783",
            title: "Кабель участвуем",
            status: "accepting_bids",
          }),
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/784",
            url: "https://goszakupki.by/auction/view/auction-784",
            title: "Кабель наблюдаем",
            status: "accepting_bids",
          }),
        ],
      },
      cardWatch: { read },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"] },
    });
    await app.inject({
      method: "POST",
      url: "/api/profile/watch",
      payload: { watchNewProcurements: true },
    });
    const found = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const ids = (JSON.parse(found.body).items as Array<{ id: string; title: string }>).map(
      (item) => item,
    );
    const participating = ids.find((item) => item.title === "Кабель участвуем");
    const watching = ids.find((item) => item.title === "Кабель наблюдаем");
    await app.inject({
      method: "POST",
      url: `/api/procurements/${participating?.id ?? ""}/decision`,
      payload: { kind: "participate" },
    });
    await app.inject({
      method: "POST",
      url: `/api/procurements/${watching?.id ?? ""}/decision`,
      payload: { kind: "monitor" },
    });

    await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const inbox = await app.inject({ method: "GET", url: "/api/inbox" });
    const rows = JSON.parse(inbox.body).items as Array<{
      title: string;
      summary: string;
    }>;
    const soon = rows.filter((item) => item.summary.includes("Срок подачи"));
    expect(soon).toHaveLength(1);
    expect(soon[0]?.summary).toContain("истекает завтра");
    expect(soon[0]?.title).toBe("Поставка кабеля 783");

    await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const again = await app.inject({ method: "GET", url: "/api/inbox" });
    expect(
      (JSON.parse(again.body).items as Array<{ summary: string }>).filter((item) =>
        item.summary.includes("Срок подачи"),
      ),
    ).toHaveLength(1);

    await app.close();
  });

  it("downloads only after a new file appears on a participated case", async () => {
    const ingest = vi.fn(async (card: SpecialistProcurementCard) => card);
    const withFiles = (files: Array<{ name: string; sourceUrl: string }>) =>
      ProcedureCard.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/781",
        url: "https://goszakupki.by/auction/view/auction-781",
        title: "Поставка кабеля",
        fetchedAt: "2026-09-10T00:00:00.000Z",
        status: "accepting_bids",
        listedDocuments: files,
      });
    const first = withFiles([{ name: "ТЗ.pdf", sourceUrl: "https://goszakupki.by/files/1" }]);
    const second = withFiles([
      { name: "ТЗ.pdf", sourceUrl: "https://goszakupki.by/files/1" },
      { name: "Изменения.pdf", sourceUrl: "https://goszakupki.by/files/2" },
    ]);
    const read = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(first).mockResolvedValue(second);
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/781",
            url: "https://goszakupki.by/auction/view/auction-781",
            title: "Кабель ВВГнг 4х50",
            status: "accepting_bids",
          }),
        ],
      },
      cardWatch: { read },
      documentIngest: { ingest },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"] },
    });
    await app.inject({
      method: "POST",
      url: "/api/profile/watch",
      payload: { watchNewProcurements: true },
    });
    const found = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const cardId = (JSON.parse(found.body).items as Array<{ id: string }>)[0]?.id;
    await app.inject({
      method: "POST",
      url: `/api/procurements/${cardId ?? ""}/decision`,
      payload: { kind: "participate" },
    });
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(2));

    await app.close();
  });

  it("archives a decided case out of monitoring and restores it with its triage", async () => {
    const card = ProcedureCard.parse({
      sourceId: "goszakupki_by",
      sourceProcurementId: "auction/778",
      url: "https://goszakupki.by/auction/view/auction-778",
      title: "Поставка кабеля",
      fetchedAt: "2026-09-10T00:00:00.000Z",
      status: "accepting_bids",
      amount: { kind: "limit", amount: null, raw: "1 000,00 BYN" },
    });
    const read = vi.fn().mockResolvedValue(card);
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/778",
            url: "https://goszakupki.by/auction/view/auction-778",
            title: "Кабель ВВГнг 4х50",
            status: "accepting_bids",
          }),
        ],
      },
      cardWatch: { read },
    });

    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"] },
    });
    await app.inject({
      method: "POST",
      url: "/api/profile/watch",
      payload: { watchNewProcurements: true },
    });
    const found = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const cardId = (JSON.parse(found.body).items as Array<{ id: string }>)[0]?.id;
    await app.inject({
      method: "POST",
      url: `/api/procurements/${cardId ?? ""}/decision`,
      payload: { kind: "monitor" },
    });

    const archived = await app.inject({
      method: "POST",
      url: `/api/procurements/${cardId ?? ""}/archive`,
      payload: { archived: true },
    });
    const archivedItem = (JSON.parse(archived.body).items as Array<{ id: string; triage?: string; archived?: boolean }>)
      .find((item) => item.id === cardId);
    const second = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });

    expect(archived.statusCode).toBe(200);
    expect(archivedItem?.triage).toBe("monitor");
    expect(archivedItem?.archived).toBe(true);
    expect(JSON.parse(second.body).monitoredCount).toBe(0);

    const restored = await app.inject({
      method: "POST",
      url: `/api/procurements/${cardId ?? ""}/archive`,
      payload: { archived: false },
    });
    const restoredItem = (JSON.parse(restored.body).items as Array<{ id: string; triage?: string; archived?: boolean }>)
      .find((item) => item.id === cardId);
    const third = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });

    expect(restoredItem?.archived).toBe(false);
    expect(restoredItem?.triage).toBe("monitor");
    expect(JSON.parse(third.body).monitoredCount).toBe(1);

    await app.close();
  });

  it("moves a rejected case to trash, restores it, then purges it", async () => {
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/trash-1",
            url: "https://goszakupki.by/auction/view/trash-1",
            title: "Кабель в корзину",
          }),
        ],
      },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"] },
    });
    const searched = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: {},
    });
    const id = (JSON.parse(searched.body).items as Array<{ id: string }>)[0]?.id ?? "";
    await app.inject({
      method: "POST",
      url: `/api/procurements/${id}/decision`,
      payload: { kind: "participate" },
    });
    await app.inject({
      method: "POST",
      url: `/api/procurements/${id}/decision`,
      payload: { kind: "reject" },
    });

    const trash = await app.inject({ method: "GET", url: "/api/procurements?tab=trash" });
    const mine = await app.inject({ method: "GET", url: "/api/procurements?tab=all" });
    expect(JSON.parse(trash.body).items[0]?.id).toBe(id);
    expect(JSON.parse(trash.body).items[0]?.triage).toBe("reject");
    expect(JSON.parse(mine.body).items).toEqual([]);

    const restored = await app.inject({
      method: "POST",
      url: `/api/procurements/${id}/restore`,
    });
    const restoredItem = (
      JSON.parse(restored.body).items as Array<{ id: string; triage?: string }>
    ).find((item) => item.id === id);
    const mineAfter = await app.inject({ method: "GET", url: "/api/procurements?tab=all" });
    const trashAfter = await app.inject({ method: "GET", url: "/api/procurements?tab=trash" });
    expect(restoredItem?.triage).toBe("participate");
    expect(JSON.parse(mineAfter.body).items[0]?.triage).toBe("participate");
    expect(JSON.parse(trashAfter.body).items).toEqual([]);

    await app.inject({
      method: "POST",
      url: `/api/procurements/${id}/decision`,
      payload: { kind: "reject" },
    });
    const purged = await app.inject({ method: "DELETE", url: `/api/procurements/${id}` });
    const missing = await app.inject({ method: "GET", url: `/api/procurements/${id}` });
    const trashPurged = await app.inject({ method: "GET", url: "/api/procurements?tab=trash" });
    expect(purged.statusCode).toBe(204);
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(trashPurged.body).items).toEqual([]);

    const again = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: {},
    });
    expect(JSON.parse(again.body).items).toEqual([]);

    await app.close();
  });

  it("empties every rejected case from trash and keeps them out of search", async () => {
    const hits = [
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/empty-1",
        url: "https://goszakupki.by/auction/view/empty-1",
        title: "Кабель первая в корзину",
      }),
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/empty-2",
        url: "https://goszakupki.by/auction/view/empty-2",
        title: "Кабель вторая в корзину",
      }),
    ];
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search: async () => hits },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"] },
    });
    const searched = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: {},
    });
    const ids = (JSON.parse(searched.body).items as Array<{ id: string }>).map((item) => item.id);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      await app.inject({
        method: "POST",
        url: `/api/procurements/${id}/decision`,
        payload: { kind: "reject" },
      });
    }
    const trash = await app.inject({ method: "GET", url: "/api/procurements?tab=trash" });
    expect(JSON.parse(trash.body).items).toHaveLength(2);

    const emptied = await app.inject({ method: "DELETE", url: "/api/procurements/trash" });
    const trashAfter = await app.inject({ method: "GET", url: "/api/procurements?tab=trash" });
    const again = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: {},
    });
    expect(emptied.statusCode).toBe(204);
    expect(JSON.parse(trashAfter.body).items).toEqual([]);
    expect(JSON.parse(again.body).items).toEqual([]);

    await app.close();
  });

  it("omits files and extracts from the trash list while the card still has them", async () => {
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000321",
      title: "Кабель без выгрузки ТЗ",
      status: "accepting_bids",
      statusLabel: "приём",
      url: "https://goszakupki.by/auction/view/slim-trash",
      sourceProcurementId: "auction/slim-trash",
      triage: "reject",
      extractPreview: "полный текст технического задания",
      documents: [
        {
          name: "ТЗ.pdf",
          sourceUrl: "https://goszakupki.by/files/tz.pdf",
          status: "hashed",
        },
      ],
    });
    const catalog = new SpecialistCatalog();
    catalog.upsertCase(card);
    const app = await buildSpecialistApi({ catalog });
    const trash = await app.inject({ method: "GET", url: "/api/procurements?tab=trash" });
    const listed = JSON.parse(trash.body).items[0] as {
      documents?: unknown[];
      extractPreview?: string;
    };
    expect(listed.documents).toEqual([]);
    expect(listed.extractPreview).toBeUndefined();
    const detail = await app.inject({ method: "GET", url: `/api/procurements/${card.id}` });
    expect(JSON.parse(detail.body).documents).toEqual([
      expect.objectContaining({ name: "ТЗ.pdf" }),
    ]);
    await app.close();
  });

  it("purges a trash case without rewriting inbox or other cases", async () => {
    const persistCases = vi.fn(async () => undefined);
    const persistInbox = vi.fn(async () => undefined);
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      persistCases,
      persistInbox,
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/purge-fast-1",
            url: "https://goszakupki.by/auction/view/purge-fast-1",
            title: "Кабель быстро удалить",
          }),
        ],
      },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"] },
    });
    const searched = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: {},
    });
    const id = (JSON.parse(searched.body).items as Array<{ id: string }>)[0]?.id ?? "";
    await app.inject({
      method: "POST",
      url: `/api/procurements/${id}/decision`,
      payload: { kind: "reject" },
    });
    persistCases.mockClear();
    persistInbox.mockClear();
    persistCases.mockImplementation(async () => {
      throw new Error("persistCases must not run on purge");
    });
    persistInbox.mockImplementation(async () => {
      throw new Error("persistInbox must not run on purge");
    });
    const purged = await app.inject({ method: "DELETE", url: `/api/procurements/${id}` });
    expect(purged.statusCode).toBe(204);
    expect(persistCases).not.toHaveBeenCalled();
    expect(persistInbox).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not hide a trash purge when the store cannot delete the row", async () => {
    const cabinets = createMemoryCabinetRegistry();
    let blockRemove = false;
    cabinets.removeCases = async () => {
      if (blockRemove) throw new Error("RLS blocked cascade");
    };
    const app = await buildSpecialistApi({
      cabinets,
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/purge-fail-1",
            url: "https://goszakupki.by/auction/view/purge-fail-1",
            title: "Кабель не удалился",
          }),
        ],
      },
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"] },
    });
    const searched = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: {},
    });
    const id = (JSON.parse(searched.body).items as Array<{ id: string }>)[0]?.id ?? "";
    await app.inject({
      method: "POST",
      url: `/api/procurements/${id}/decision`,
      payload: { kind: "reject" },
    });
    blockRemove = true;
    const purged = await app.inject({ method: "DELETE", url: `/api/procurements/${id}` });
    expect(purged.statusCode).toBe(500);
    await app.close();
  });

  it("maps a blocked live source to 503 without inventing search hits", async () => {
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: {
        search: async () => {
          throw new McpToolCallError(
            "source_unavailable",
            "procurement.search",
            "Source is blocked",
          );
        },
      },
    });

    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"] },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: {},
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).error).toBe("source_unavailable");
    const listed = await app.inject({ method: "GET", url: "/api/procurements" });
    expect(JSON.parse(listed.body).items).toEqual([]);

    await app.close();
  });

  it("serves a catalog PDF from the local blob store, not an unknown hash on disk", async () => {
    const blobDirectory = await mkdtemp(path.join(os.tmpdir(), "blobs-"));
    tmpDirs.push(blobDirectory);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const orphan = createHash("sha256").update("orphan").digest("hex");
    const absent = "c".repeat(64);
    await putBlob(blobDirectory, hash, bytes);
    await putBlob(blobDirectory, orphan, new Uint8Array([1, 2, 3]));

    const catalog = new SpecialistCatalog();
    catalog.upsertCase(
      SpecialistProcurementCard.parse({
        id: "00000000-0000-4000-8000-000000000301",
        title: "Тест PDF",
        status: "announced",
        statusLabel: "объявлена",
        url: "https://goszakupki.by/auction/view/301",
        sourceProcurementId: "auction/301",
        documents: [
          {
            name: "Техническое задание.pdf",
            sourceUrl: "https://goszakupki.by/files/301",
            hash,
            sizeBytes: bytes.byteLength,
            status: "hashed",
          },
          {
            name: "Потерянный.pdf",
            sourceUrl: "https://goszakupki.by/files/302",
            hash: absent,
            sizeBytes: 1,
            status: "hashed",
          },
        ],
      }),
    );
    const app = await buildSpecialistApi({ catalog, blobDirectory });

    const served = await app.inject({ method: "GET", url: `/api/documents/${hash}` });
    const unknown = await app.inject({ method: "GET", url: `/api/documents/${orphan}` });
    const invalid = await app.inject({ method: "GET", url: "/api/documents/not-a-hash" });
    const missingBlob = await app.inject({ method: "GET", url: `/api/documents/${absent}` });
    const missing = await app.inject({
      method: "GET",
      url: `/api/documents/${"b".repeat(64)}`,
    });

    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("application/pdf");
    expect(served.headers["content-disposition"]).toContain("inline");
    expect(Buffer.from(served.rawPayload)).toEqual(Buffer.from(bytes));
    expect(unknown.statusCode).toBe(404);
    expect(JSON.parse(unknown.body).error).toBe("not_found");
    expect(invalid.statusCode).toBe(400);
    expect(JSON.parse(missingBlob.body).error).toBe("blob_missing");
    expect(missingBlob.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);

    await app.close();
  });
});
