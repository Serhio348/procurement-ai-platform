import { ChangeEvent, CommercialTerms, FactId } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { compileProcurementReport } from "./compile.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-09-03T10:00:00.000Z";

describe("compileProcurementReport", () => {
  it("prints a proven advance percent and does not invent a score", () => {
    const report = compileProcurementReport({
      card: card(),
      terms: CommercialTerms.parse({
        advancePercent: { value: 30, factIds: [FactId.parse(uuid(3))], confidence: 0.92 },
      }),
    });
    expect(report.markdown).toContain("Аванс: 30%.");
    expect(report.markdown).toContain("Итоговая оценка ещё не рассчитана кодом");
    expect(report.markdown).not.toMatch(/Аванс:\s*90/);
    expect(report.missing).toContain("Итоговая оценка ещё не рассчитана.");
  });

  it("does not write an advance figure when commercial terms were not supplied", () => {
    const report = compileProcurementReport({ card: card() });
    expect(report.markdown).toContain("Коммерческие условия ещё не извлечены.");
    expect(report.markdown).not.toMatch(/Аванс:\s*\d/);
    expect(report.missing).toContain("Коммерческие условия не извлечены.");
  });

  it("lists a status change without sending a notification itself", () => {
    const report = compileProcurementReport({
      card: card(),
      changes: [
        ChangeEvent.parse({
          id: uuid(40),
          procurementId: uuid(20),
          kind: "status_changed",
          field: "status",
          previous: "accepting_bids",
          current: "cancelled",
          detectedAt: now,
          urgent: true,
        }),
      ],
    });
    expect(report.markdown).toContain("Статус: accepting_bids → cancelled.");
  });
});

function card() {
  return {
    title: "Поставка КТПБ",
    url: "https://goszakupki.by/auction/view/001",
    status: "accepting_bids" as const,
    kind: "electronic_auction" as const,
    sourceProcurementId: "auction/001",
  };
}
