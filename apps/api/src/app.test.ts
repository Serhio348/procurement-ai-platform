import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ProcedureCard,
  SearchHit,
  SpecialistProcurementCard,
  electricalEquipmentSeedV1,
  type InboxFixtureItem,
} from "@procurement/contracts";
import { SpecialistCatalog, SpecialistWorkspace, type ReviewOutcome } from "@procurement/domain";
import { McpToolCallError } from "@procurement/mcp-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryAdminJournal } from "./admin/journal.js";
import { buildSpecialistApi } from "./app.js";
import { putBlob } from "./blobs.js";
import { loadFixtureCatalog } from "./load-fixture.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

  it("deletes an inbox row without removing the procurement case", async () => {
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
    ).toBe(true);

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
    const app = await buildSpecialistApi({
      catalog,
      persistCases,
    });

    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"] },
    });

    expect(persistCases).toHaveBeenCalledWith([], expect.any(String));
    expect(catalog.procurements()).toHaveLength(1);

    await app.close();
  });

  it("persists found cases after search so a restart can reload them", async () => {
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
    expect(persistCases).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ sourceProcurementId: "auction/persist-1" }),
      ]),
      expect.any(String),
    );

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
        title: "Поставка КТПБ-250",
      }),
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "etrade/weak-1",
        url: "https://goszakupki.by/etrade/view/weak-1",
        title: "Реконструкция ВЛ-0,4 кВ от БКТПБ-746",
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
      payload: { name: "КТПБ", keywords: ["КТПБ"] },
    });

    const first = await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    const listedAfterFirst = await app.inject({ method: "GET", url: "/api/procurements" });
    const inboxAfterFirst = await app.inject({ method: "GET", url: "/api/inbox" });
    const titles = (body: string) =>
      (JSON.parse(body).items as Array<{ title: string }>).map((item) => item.title);

    expect(first.statusCode).toBe(200);
    expect(titles(first.body)).toEqual(["Поставка КТПБ-250"]);
    // Review cases live in the inbox only; the list shows confident matches.
    expect(titles(listedAfterFirst.body)).toEqual(["Поставка КТПБ-250"]);
    expect(titles(inboxAfterFirst.body).sort()).toEqual(
      ["Реконструкция ВЛ-0,4 кВ от БКТПБ-746", "СО2-инкубатор (термостат электронный)"].sort(),
    );

    // Opening the weak one from the inbox takes it on: it joins the list.
    const weakRow = (JSON.parse(inboxAfterFirst.body).items as Array<{ id: string; title: string }>)
      .find((item) => item.title.includes("БКТПБ-746"));
    const opened = await app.inject({
      method: "POST",
      url: `/api/inbox/${weakRow?.id ?? ""}/resolve`,
      payload: { action: "open" },
    });
    expect(opened.statusCode).toBe(200);
    expect(JSON.parse(opened.body).card?.foundAs).toBe("match");
    const listedAfterOpen = await app.inject({ method: "GET", url: "/api/procurements" });
    expect(titles(listedAfterOpen.body).sort()).toEqual(
      ["Поставка КТПБ-250", "Реконструкция ВЛ-0,4 кВ от БКТПБ-746"].sort(),
    );

    // Eight days later the source no longer returns anything. Untouched cases
    // vanish from the catalog and the database; the opened one is still untouched
    // by a decision, so it goes too. The inbox row of the incubator goes with it.
    now = "2026-09-09T10:00:00.000Z";
    hits = [];
    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    const listedAfterPrune = await app.inject({ method: "GET", url: "/api/procurements" });
    const inboxAfterPrune = await app.inject({ method: "GET", url: "/api/inbox" });
    expect(titles(listedAfterPrune.body)).toEqual([]);
    expect(titles(inboxAfterPrune.body)).toEqual([]);
    expect(removeCases).toHaveBeenCalledTimes(1);
    expect(removeCases.mock.calls[0]?.[0]).toHaveLength(3);

    await app.close();
  });

  it("lets the review port promote a checked hit, drop an unrelated one and ask about the rest", async () => {
    const hits = [
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/lot-1",
        url: "https://goszakupki.by/auction/view/lot-1",
        title: "Поставка электрооборудования для подстанции №3",
      }),
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/incubator-1",
        url: "https://goszakupki.by/auction/view/incubator-1",
        title: "СО2-инкубатор (термостат электронный)",
      }),
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/unclear-1",
        url: "https://goszakupki.by/auction/view/unclear-1",
        title: "Электромонтажные работы",
      }),
    ];
    const verdicts: Record<string, ReviewOutcome> = {
      "auction/lot-1": {
        verdict: "relevant",
        decidedBy: "card",
        reason: "В лотах есть НКУ-0,4.",
        matchedTerms: ["НКУ"],
        confidence: 1,
      },
      "auction/incubator-1": {
        verdict: "irrelevant",
        decidedBy: "model",
        reason: "Лабораторный инкубатор, не электрооборудование.",
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
    const review = vi.fn(async (reviewed: readonly SearchHit[]) =>
      reviewed.map((item) => verdicts[item.sourceProcurementId] as ReviewOutcome),
    );
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search: async () => hits },
      searchReview: { review },
      clock: () => "2026-09-01T10:00:00.000Z",
    });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "НКУ", keywords: ["НКУ"] },
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
      items: Array<{ title: string; foundAs?: string; actions: Array<{ detail: string }> }>;
    };
    const inbox = await app.inject({ method: "GET", url: "/api/inbox" });
    const inboxTitles = (JSON.parse(inbox.body).items as Array<{ title: string }>).map(
      (item) => item.title,
    );

    // The keyword never appeared in a title, so all three went to review.
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]?.[0]).toHaveLength(3);
    // Only the checked one is a confident case; the incubator is gone for good.
    expect(body.items.map((item) => item.title)).toEqual([
      "Поставка электрооборудования для подстанции №3",
    ]);
    expect(body.items[0]?.foundAs).toBe("match");
    expect(body.items[0]?.actions.at(-1)?.detail).toContain("НКУ-0,4");
    expect(body.relevantCount).toBe(1);
    expect(body.discardedCount).toBe(1);
    expect(body.ambiguousCount).toBe(1);
    // The unresolved one waits for a specialist, the discarded one does not.
    expect(inboxTitles).toEqual(["Электромонтажные работы"]);

    await app.close();
  });

  it("reviews background discovery hits too, and counts only the accepted ones as added", async () => {
    const hits = [
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/night-1",
        url: "https://goszakupki.by/auction/view/night-1",
        title: "Поставка электрооборудования",
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
                  reason: "В лотах есть НКУ-0,4.",
                  matchedTerms: ["НКУ"],
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
      payload: { name: "НКУ", keywords: ["НКУ"] },
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
    expect(body.items.map((item) => item.title)).toEqual(["Поставка электрооборудования"]);

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
        sourceProcurementId: "auction/unclear-2",
        url: "https://goszakupki.by/auction/view/unclear-2",
        title: "Электромонтажные работы",
      }),
    ];
    const review = vi.fn(async (reviewed: readonly SearchHit[]) =>
      reviewed.map(
        (item): ReviewOutcome =>
          item.sourceProcurementId === "auction/incubator-2"
            ? { verdict: "irrelevant", decidedBy: "model", reason: "Инкубатор.", matchedTerms: [], confidence: 0.95 }
            : { verdict: "needs_human", decidedBy: "model", reason: "Неясно.", matchedTerms: [], confidence: 0.5 },
      ),
    );
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: { search: async () => hits },
      searchReview: { review },
    });
    await app.inject({ method: "PUT", url: "/api/profile", payload: { name: "НКУ", keywords: ["НКУ"] } });

    const first = await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    const second = await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    const inbox = await app.inject({ method: "GET", url: "/api/inbox" });

    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]?.[0]).toHaveLength(2);
    // Second pass: the incubator is remembered as irrelevant, the unclear one
    // already waits in the inbox. Counts still describe the pass honestly.
    expect(JSON.parse(first.body)).toMatchObject({ discardedCount: 1, ambiguousCount: 1 });
    expect(JSON.parse(second.body)).toMatchObject({ discardedCount: 1, ambiguousCount: 1 });
    expect((JSON.parse(inbox.body).items as Array<{ title: string }>).map((item) => item.title)).toEqual([
      "Электромонтажные работы",
    ]);

    // Changing the phrases forgets the verdict: the next search asks again.
    await app.inject({ method: "PUT", url: "/api/profile", payload: { name: "НКУ", keywords: ["НКУ", "ЩО"] } });
    await app.inject({ method: "POST", url: "/api/procurements/search", payload: {} });
    expect(review).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it("persists inbox rows and restores review cases into the inbox after a restart", async () => {
    const hits = [
      SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/restart-1",
        url: "https://goszakupki.by/auction/view/restart-1",
        title: "Электромонтажные работы",
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
    await first.inject({ method: "PUT", url: "/api/profile", payload: { name: "НКУ", keywords: ["НКУ"] } });
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
        profiles: [{ id: workspaceState.id, name: "НКУ", keywords: ["НКУ"] }],
        activeProfileId: workspaceState.id,
      }),
      searchHits: { search: async () => hits },
    });
    const inbox = await second.inject({ method: "GET", url: "/api/inbox" });
    const listed = await second.inject({ method: "GET", url: "/api/procurements" });

    // The review case is reachable again through the inbox and still out of the list.
    expect((JSON.parse(inbox.body).items as Array<{ title: string }>).map((item) => item.title)).toEqual([
      "Электромонтажные работы",
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

  it("returns delivery and warranty from the live Word TZ and does not treat 99.5% cap as advance", async () => {
    const app = await buildSpecialistApi({ catalog: await loadFixtureCatalog() });
    const list = await app.inject({ method: "GET", url: "/api/procurements" });
    const items = JSON.parse(list.body).items as Array<{
      id: string;
      sourceProcurementId: string;
    }>;
    const live = items.find((item) => item.sourceProcurementId === "auction/3629820");
    expect(live).toBeDefined();
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
    // Only the status-less "Кабель силовой" survives: finished or announced
    // hits are dropped by the default status filter before human review.
    expect(body.ambiguousCount).toBe(1);
    expect(body.discardedCount).toBe(2);
    expect(body.items.map((item) => item.title)).toEqual([
      "Комплектная трансформаторная подстанция",
    ]);
    // Non-matching hits are not dropped silently: they wait in the inbox as
    // ambiguous cases for a human look, but are not listed as confident matches.
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
    // A keyword-miss goes to the inbox for review, not into the confident list.
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
    const items = JSON.parse(participated.body).items as Array<{
      documents: Array<{ name: string; status: string }>;
    }>;

    expect(monitored.statusCode).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(participated.statusCode).toBe(200);
    expect(items[0]?.documents).toEqual([
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

    expect(participated.statusCode).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(items[0]?.amountLabel).toBe("160 651.42 BYN");
    expect(items[0]?.sourceCard?.buyer?.registrationNumber).toBe("200050653");
    expect(items[0]?.documents).toEqual([expect.objectContaining({ name: "ТЗ.pdf" })]);

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
    const items = JSON.parse(participated.body).items as Array<{
      documents: Array<{ name: string }>;
    }>;

    expect(participated.statusCode).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(items[0]?.documents).toEqual([expect.objectContaining({ name: "ТЗ.pdf" })]);

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
    const done = await app.inject({
      method: "GET",
      url: `/api/procurements/${found.id}/ingest-progress`,
    });

    expect(JSON.parse(idle.body).phase).toBe("idle");
    expect(participated.statusCode).toBe(200);
    expect(JSON.parse(done.body).phase).toBe("done");
    expect(JSON.parse(done.body).percent).toBe(100);

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
