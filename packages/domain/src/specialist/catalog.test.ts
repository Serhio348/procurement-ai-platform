import { describe, expect, it } from "vitest";
import { SpecialistProcurementCard } from "@procurement/contracts";
import { SpecialistCatalog } from "./catalog.js";
import { inboxItemFromFoundCard } from "./inbox-action.js";

const fixture = {
  items: [
    {
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
    },
    {
      procurement: {
        title: "НКУ и щитовое оборудование",
        status: "accepting_bids",
        url: "https://goszakupki.by/auction/view/002",
        sourceProcurementId: "auction/002",
      },
      change: {
        id: "00000000-0000-4000-8000-000000000102",
        procurementId: "00000000-0000-4000-8000-000000000021",
        kind: "document_updated",
        previous: "ТЗ.pdf",
        current: "ТЗ.pdf",
        detectedAt: "2026-09-03T09:40:00.000Z",
        urgent: true,
      },
    },
    {
      procurement: {
        title: "Бытовой щиток",
        status: "announced",
        url: "https://goszakupki.by/auction/view/003",
        sourceProcurementId: "auction/003",
      },
      change: {
        id: "00000000-0000-4000-8000-000000000103",
        procurementId: "00000000-0000-4000-8000-000000000022",
        kind: "price_changed",
        previous: "10000",
        current: "9000",
        detectedAt: "2026-09-03T10:00:00.000Z",
        urgent: false,
      },
    },
  ],
};

describe("SpecialistCatalog", () => {
  it("keeps only urgent changes in the inbox and does not invent an advance percent", () => {
    const catalog = SpecialistCatalog.parse(fixture);
    const inbox = catalog.urgentInbox();

    expect(inbox.map((entry) => entry.title)).toEqual([
      "Поставка КТПБ",
      "НКУ и щитовое оборудование",
    ]);
    expect(inbox[0]?.summary).toContain("accepting_bids → cancelled");
    expect(inbox.map((entry) => entry.detail).join("\n")).not.toMatch(/аванс/i);
  });

  it("keeps a review candidate in the inbox without the urgent new-procurement label", () => {
    const catalog = new SpecialistCatalog();
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000402",
      title: "Котёл твердотопливный",
      status: "accepting_bids",
      statusLabel: "приём предложений",
      url: "https://goszakupki.by/auction/view/002",
      sourceProcurementId: "auction/002",
      foundAs: "review",
    });
    catalog.record(inboxItemFromFoundCard(card, "2026-09-06T12:00:00.000Z"));

    const entry = catalog.urgentInbox()[0];
    expect(entry?.topic).toBe("review");
    expect(entry?.topicLabel).toBe("На проверку");
    expect(entry?.urgent).toBe(false);
    expect(entry?.summary).toMatch(/^На проверку: /u);
    expect(entry?.summary).not.toContain("срочно");
  });

  it("lists every procurement case including a non-urgent latest change", () => {
    const catalog = SpecialistCatalog.parse(fixture);
    const household = catalog.procurement("00000000-0000-4000-8000-000000000022");

    expect(catalog.procurements()).toHaveLength(3);
    expect(household?.title).toBe("Бытовой щиток");
    expect(household?.latestChange?.urgent).toBe(false);
    expect(household?.latestChange?.summary).toContain("10000 → 9000");
  });

  it("records a new urgent event so a later inbox read sees it, and ignores duplicates", () => {
    const catalog = SpecialistCatalog.parse({ items: [] });
    const event = fixture.items[0];
    if (event === undefined) throw new Error("fixture missing");

    expect(catalog.record(event).duplicate).toBe(false);
    expect(catalog.record(event).duplicate).toBe(true);
    expect(catalog.urgentInbox()).toHaveLength(1);
  });

  it("drops a dismissed urgent row from the inbox and keeps the procurement case", () => {
    const catalog = SpecialistCatalog.parse(fixture);
    const status = catalog.urgentInbox()[0];
    if (status === undefined) throw new Error("fixture missing");

    expect(status.topic).toBe("card_update");
    expect(catalog.urgentInbox()[1]?.topic).toBe("documents");
    expect(catalog.dismiss(status.id)).toBe(true);
    expect(catalog.urgentInbox().map((entry) => entry.title)).toEqual(["НКУ и щитовое оборудование"]);
    expect(catalog.procurement(status.procurementId)?.title).toBe("Поставка КТПБ");
    catalog.undismiss(status.id);
    expect(catalog.urgentInbox()[0]?.title).toBe("Поставка КТПБ");
  });

  it("keeps both profiles on a case found twice", () => {
    const catalog = new SpecialistCatalog();
    const first = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Комплектная трансформаторная подстанция",
      status: "unknown",
      statusLabel: "Прием предложений",
      url: "https://example.test/auction/001",
      sourceProcurementId: "auction-001",
      profileIds: ["00000000-0000-4000-8000-000000000901"],
    });
    catalog.upsertCase(first);
    catalog.upsertCase(
      SpecialistProcurementCard.parse({
        ...first,
        profileIds: ["00000000-0000-4000-8000-000000000902"],
      }),
    );
    expect(catalog.procurement(first.id)?.profileIds).toEqual([
      "00000000-0000-4000-8000-000000000901",
      "00000000-0000-4000-8000-000000000902",
    ]);
  });

  it("prunes stale undecided live cases together with their inbox rows, keeps decided and fresh ones", () => {
    const catalog = new SpecialistCatalog();
    const base = {
      status: "unknown",
      statusLabel: "неизвестно",
      live: true,
      foundAs: "review",
    };
    const stale = SpecialistProcurementCard.parse({
      ...base,
      id: "00000000-0000-4000-8000-000000000a01",
      title: "СО2-инкубатор",
      url: "https://goszakupki.by/single-source/view/1",
      sourceProcurementId: "single-source/1",
      lastSeenAt: "2026-09-01T00:00:00.000Z",
    });
    const legacy = SpecialistProcurementCard.parse({
      ...base,
      id: "00000000-0000-4000-8000-000000000a02",
      title: "Старая карточка без отметки",
      url: "https://goszakupki.by/auction/view/2",
      sourceProcurementId: "auction/2",
    });
    const fresh = SpecialistProcurementCard.parse({
      ...base,
      id: "00000000-0000-4000-8000-000000000a03",
      title: "Свежая",
      url: "https://goszakupki.by/auction/view/3",
      sourceProcurementId: "auction/3",
      lastSeenAt: "2026-09-08T12:00:00.000Z",
    });
    const decided = SpecialistProcurementCard.parse({
      ...base,
      id: "00000000-0000-4000-8000-000000000a04",
      title: "Под наблюдением",
      url: "https://goszakupki.by/auction/view/4",
      sourceProcurementId: "auction/4",
      triage: "monitor",
      lastSeenAt: "2026-08-01T00:00:00.000Z",
    });
    for (const card of [stale, legacy, fresh, decided]) catalog.upsertCase(card);
    catalog.record(inboxItemFromFoundCard(stale, "2026-09-01T00:00:00.000Z"));

    const removed = catalog.prune({
      now: "2026-09-09T00:00:00.000Z",
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      keepSourceIds: new Set(),
    });

    expect(removed.sort()).toEqual([stale.id, legacy.id].sort());
    expect(catalog.procurements().map((card) => card.id).sort()).toEqual(
      [fresh.id, decided.id].sort(),
    );
    expect(catalog.urgentInbox()).toEqual([]);
  });

  it("prunes a finished procedure the specialist never took, even if it was seen today", () => {
    const catalog = new SpecialistCatalog();
    const closed = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000a05",
      title: "Завершённая поставка",
      status: "completed",
      statusLabel: "завершена",
      url: "https://goszakupki.by/auction/view/5",
      sourceProcurementId: "auction/5",
      live: true,
      foundAs: "match",
      lastSeenAt: "2026-09-16T12:00:00.000Z",
    });
    const watched = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000a06",
      title: "Слежу за завершённой",
      status: "completed",
      statusLabel: "завершена",
      url: "https://goszakupki.by/auction/view/6",
      sourceProcurementId: "auction/6",
      live: true,
      triage: "monitor",
      lastSeenAt: "2026-09-16T12:00:00.000Z",
    });
    catalog.upsertCase(closed);
    catalog.upsertCase(watched);

    const removed = catalog.prune({
      now: "2026-09-16T12:00:00.000Z",
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      keepSourceIds: new Set(),
    });

    expect(removed).toEqual([closed.id]);
    expect(catalog.storedCases().map((card) => card.id)).toEqual([watched.id]);
  });

  it("drops a purged case so persist cannot recreate it from the inbox stub", () => {
    const catalog = SpecialistCatalog.parse(fixture);
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000020",
      title: "Поставка КТПБ",
      status: "cancelled",
      statusLabel: "отменена",
      url: "https://goszakupki.by/auction/view/001",
      sourceProcurementId: "auction/001",
      triage: "reject",
    });
    catalog.upsertCase(card);
    catalog.dropCase(card.id);

    expect(catalog.procurement(card.id)).toBeUndefined();
    expect(catalog.procurements().some((item) => item.id === card.id)).toBe(false);
    expect(catalog.storedCases()).toEqual([]);

    // A later upsert of the same id must not put the purged case back into
    // persist: the specialist would find it in trash again after a reload.
    catalog.upsertCase(card);
    expect(catalog.storedCases()).toEqual([]);
    expect(catalog.procurement(card.id)).toBeUndefined();
  });

  it("forgets a review miss so a later search can store the same id again", () => {
    const catalog = new SpecialistCatalog();
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000020",
      title: "НКУ щитовое",
      status: "unknown",
      statusLabel: "Прием предложений",
      url: "https://goszakupki.by/auction/view/drop-1",
      sourceProcurementId: "auction/drop-1",
      foundAs: "review",
    });
    catalog.upsertCase(card);
    catalog.record(inboxItemFromFoundCard(card, "2026-09-01T10:00:00.000Z"));
    catalog.forgetCase(card.id);

    expect(catalog.storedCases()).toEqual([]);
    expect(catalog.urgentInbox()).toEqual([]);

    catalog.upsertCase(card);
    expect(catalog.storedCases().map((item) => item.id)).toEqual([card.id]);
    expect(catalog.procurement(card.id)?.title).toBe("НКУ щитовое");
  });

  it("does not treat inbox stubs as stored cases for persist", () => {
    const catalog = SpecialistCatalog.parse(fixture);
    expect(catalog.storedCases()).toEqual([]);
    expect(catalog.procurements()).toHaveLength(3);

    const stored = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000020",
      title: "Поставка КТПБ",
      status: "cancelled",
      statusLabel: "отменена",
      url: "https://goszakupki.by/auction/view/001",
      sourceProcurementId: "auction/001",
      triage: "reject",
    });
    catalog.upsertCase(stored);

    expect(catalog.storedCases().map((item) => item.id)).toEqual([stored.id]);
    expect(catalog.procurements().some((item) => item.id === stored.id)).toBe(true);
  });
});
