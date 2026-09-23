import { SpecialistProcurementCard } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { mergeProcurementCards } from "./SpecialistApp.js";

describe("mergeProcurementCards", () => {
  it("updates a search hit without dropping other decided cases", () => {
    const decided = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000001",
      title: "Старая решённая",
      status: "accepting_bids",
      statusLabel: "приём предложений",
      url: "https://goszakupki.by/request/view/1",
      sourceProcurementId: "request/1",
      triage: "participate",
      documents: [
        {
          name: "ТЗ.docx",
          sourceUrl: "https://goszakupki.by/files/1",
          hash: "a".repeat(64),
          status: "hashed",
        },
      ],
    });
    const found = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000002",
      title: "Новая из поиска",
      status: "unknown",
      statusLabel: "Подача предложений",
      url: "https://goszakupki.by/request/view/2",
      sourceProcurementId: "request/2",
    });
    const refreshed = SpecialistProcurementCard.parse({
      ...found,
      statusLabel: "Рассмотрение предложений",
      triage: "participate",
      sourceCard: {
        sourceId: "goszakupki_by",
        sourceProcurementId: "request/2",
        url: found.url,
        title: found.title,
        fetchedAt: "2026-09-11T00:00:00.000Z",
      },
    });

    const merged = mergeProcurementCards([decided, found], [refreshed]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.documents).toHaveLength(1);
    expect(merged[1]?.sourceCard).toBeDefined();
    expect(merged[1]?.statusLabel).toBe("Рассмотрение предложений");
  });

  it("does not let a slimmed response hollow out the stored case", () => {
    const stored = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000021",
      title: "Участвуемая с документами",
      status: "accepting_bids",
      statusLabel: "приём предложений",
      url: "https://goszakupki.by/auction/view/21",
      sourceProcurementId: "auction/21",
      triage: "participate",
      documents: [
        {
          name: "ТЗ.docx",
          sourceUrl: "https://goszakupki.by/files/21",
          hash: "b".repeat(64),
          status: "hashed",
        },
      ],
      sourceCard: {
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/21",
        url: "https://goszakupki.by/auction/view/21",
        title: "Участвуемая с документами",
        fetchedAt: "2026-09-11T00:00:00.000Z",
        lots: [{ number: "1", title: "Электромонтажные работы" }],
        rawFields: { "Заказчик": "Учреждение образования" },
      },
    });
    // What an inbox resolve used to ship: same case, hollow projection.
    const slim = SpecialistProcurementCard.parse({
      ...stored,
      documents: [],
      sourceCard: { ...stored.sourceCard, lots: [], rawFields: {}, parties: [], externalIds: [] },
    });

    const merged = mergeProcurementCards([stored], [slim]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.documents).toHaveLength(1);
    expect(merged[0]?.sourceCard?.lots).toHaveLength(1);
    expect(merged[0]?.sourceCard?.rawFields["Заказчик"]).toBe("Учреждение образования");
  });

  it("keeps one row when the same source returns under two ids", () => {
    const fromSearch = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000011",
      title: "Комплекс средств защиты",
      status: "accepting_bids",
      statusLabel: "приём предложений",
      url: "https://goszakupki.by/marketing/view/3674081",
      sourceProcurementId: "marketing/3674081",
      foundAs: "match",
    });
    const fromStore = SpecialistProcurementCard.parse({
      ...fromSearch,
      id: "00000000-0000-4000-8000-000000000012",
    });

    const merged = mergeProcurementCards([fromSearch], [fromStore]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.sourceProcurementId).toBe("marketing/3674081");
    expect(merged[0]?.id).toBe(fromStore.id);
  });
});
