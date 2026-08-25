import { describe, expect, it } from "vitest";
import { Fact } from "./common.js";
import { DomainProfileDraft } from "./domain-profile.js";
import { Risk } from "./scoring.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-08-25T09:00:00.000Z";

describe("provenance invariant", () => {
  const base = {
    id: uuid(1),
    procurementId: uuid(2),
    key: "commercial.advance_percent",
    value: 30,
    confidence: 0.9,
    extractedBy: "commercial_terms",
    extractedAt: now,
  };

  it("accepts a fact that cites evidence", () => {
    const parsed = Fact.safeParse({ ...base, evidenceIds: [uuid(3)] });
    expect(parsed.success).toBe(true);
  });

  it("rejects a fact with no evidence", () => {
    const parsed = Fact.safeParse({ ...base, evidenceIds: [] });
    expect(parsed.success).toBe(false);
  });

  it("rejects a risk that is not grounded in facts", () => {
    const parsed = Risk.safeParse({
      id: uuid(4),
      procurementId: uuid(2),
      type: "large_advance_required",
      severity: "high",
      description: "Advance of 50% required",
      factIds: [],
      confidence: 0.8,
      detectedBy: "risk_analysis",
      detectedAt: now,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("domain profile draft", () => {
  const minimal = {
    slug: "water_treatment",
    name: "Водоподготовка",
    scoringRules: {
      formulaId: "default",
      weights: { technical: 1, commercial: 1, deadline: 1, risk: 1, companyMatch: 1 },
      minRelevanceToInvestigate: 0.4,
      minConfidenceToDecide: 0.7,
    },
  };

  it("fills optional configuration with defaults so the UI can post a minimal form", () => {
    const parsed = DomainProfileDraft.parse(minimal);
    expect(parsed.enabled).toBe(true);
    expect(parsed.archived).toBe(false);
    expect(parsed.priority).toBe(50);
    expect(parsed.keywords).toEqual([]);
    expect(parsed.associatedCapabilities).toEqual([]);
  });

  it("rejects a slug that is not a lowercase identifier", () => {
    const parsed = DomainProfileDraft.safeParse({ ...minimal, slug: "Water Treatment" });
    expect(parsed.success).toBe(false);
  });
});
