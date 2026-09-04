import { Fact } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { assembleCommercialTerms } from "./assemble.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-09-03T07:00:00.000Z";

describe("assembleCommercialTerms", () => {
  it("maps a proven advance fact onto CommercialTerms without inventing a score", () => {
    const fact = factWith({ value: 30 });
    const assembled = assembleCommercialTerms([fact]);
    expect(assembled.conflicts).toEqual([]);
    expect(assembled.terms.advancePercent).toEqual({
      value: 30,
      factIds: [fact.id],
      confidence: 0.92,
    });
    expect(assembled.terms).not.toHaveProperty("score");
  });

  it("does not let a newer conflicting value silently overwrite the older one", () => {
    const first = factWith({ id: uuid(1), value: 30 });
    const second = factWith({ id: uuid(2), value: 50, extractedAt: "2026-09-04T00:00:00.000Z" });
    const assembled = assembleCommercialTerms([first, second]);
    expect(assembled.terms.advancePercent).toBeUndefined();
    expect(assembled.conflicts[0]?.question).toContain("разные значения");
  });

  it("maps an advance cap without treating it as a point advancePercent", () => {
    const fact = Fact.parse({
      id: uuid(4),
      procurementId: uuid(20),
      key: "commercial.advance_percent_cap",
      value: 99.5,
      unit: "%",
      evidenceIds: [uuid(3)],
      confidence: 0.92,
      extractedBy: "commercial_terms",
      extractedAt: now,
    });
    const assembled = assembleCommercialTerms([fact]);
    expect(assembled.conflicts).toEqual([]);
    expect(assembled.terms.advancePercent).toBeUndefined();
    expect(assembled.terms.advancePercentCap?.value).toBe(99.5);
  });
});

function factWith(overrides: { id?: string; value: number; extractedAt?: string }) {
  return Fact.parse({
    id: overrides.id ?? uuid(1),
    procurementId: uuid(20),
    key: "commercial.advance_percent",
    value: overrides.value,
    unit: "%",
    evidenceIds: [uuid(3)],
    confidence: 0.92,
    extractedBy: "commercial_terms",
    extractedAt: overrides.extractedAt ?? now,
  });
}
