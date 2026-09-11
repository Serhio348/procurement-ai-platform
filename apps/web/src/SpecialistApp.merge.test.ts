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
});
