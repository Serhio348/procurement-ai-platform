import { describe, expect, it } from "vitest";
import { SpecialistCatalog } from "./catalog.js";

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
  });

  it("keeps both profiles on a case found twice", () => {
    const catalog = new SpecialistCatalog();
    const first = {
      id: "00000000-0000-4000-8000-000000000401",
      title: "Комплектная трансформаторная подстанция",
      status: "unknown" as const,
      statusLabel: "Прием предложений",
      url: "https://example.test/auction/001",
      sourceProcurementId: "auction-001",
      profileIds: ["00000000-0000-4000-8000-000000000901"],
    };
    catalog.upsertCase(first);
    catalog.upsertCase({
      ...first,
      profileIds: ["00000000-0000-4000-8000-000000000902"],
    });
    expect(catalog.procurement(first.id)?.profileIds).toEqual([
      "00000000-0000-4000-8000-000000000901",
      "00000000-0000-4000-8000-000000000902",
    ]);
  });
});
