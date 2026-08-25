import type { ScoreComponents, ScoringFormula } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { ScoringConfigurationError, computeScore } from "./engine.js";

const formula: ScoringFormula = {
  id: "default",
  version: 1,
  weights: { technical: 3, commercial: 2, deadline: 2, risk: 2, companyMatch: 1 },
  riskPenalty: { low: 2, medium: 5, high: 10, critical: 25 },
  thresholds: { review: 50, accept: 75 },
  minConfidence: 0.7,
};

const components = (overrides: Partial<ScoreComponents> = {}): ScoreComponents => ({
  technical: 0.8,
  commercial: 0.8,
  deadline: 0.8,
  risk: 0.8,
  companyMatch: 0.8,
  ...overrides,
});

describe("weighted scoring", () => {
  it("weights components by the formula rather than averaging them equally", () => {
    const result = computeScore({
      components: components({ technical: 1, commercial: 0, deadline: 0, risk: 0, companyMatch: 0 }),
      risks: [],
      confidence: 1,
      formula,
    });

    // technical weight 3 of total weight 10
    expect(result.weightedScore).toBe(30);
  });

  it("returns 100 when every component is perfect and nothing is risky", () => {
    const result = computeScore({
      components: components({
        technical: 1,
        commercial: 1,
        deadline: 1,
        risk: 1,
        companyMatch: 1,
      }),
      risks: [],
      confidence: 1,
      formula,
    });

    expect(result.finalScore).toBe(100);
    expect(result.verdict).toBe("accept");
  });

  it("rejects a formula whose weights are all zero", () => {
    expect(() =>
      computeScore({
        components: components(),
        risks: [],
        confidence: 1,
        formula: {
          ...formula,
          weights: { technical: 0, commercial: 0, deadline: 0, risk: 0, companyMatch: 0 },
        },
      }),
    ).toThrow(ScoringConfigurationError);
  });
});

describe("risk penalty", () => {
  it("subtracts a penalty per risk and severity", () => {
    const result = computeScore({
      components: components(),
      risks: [{ severity: "high" }, { severity: "medium" }, { severity: "medium" }],
      confidence: 1,
      formula,
    });

    expect(result.weightedScore).toBe(80);
    expect(result.riskPenalty).toBe(20);
    expect(result.finalScore).toBe(60);
  });

  it("never drives the score below zero", () => {
    const result = computeScore({
      components: components({ technical: 0.1, commercial: 0.1, deadline: 0.1, risk: 0, companyMatch: 0 }),
      risks: [{ severity: "critical" }, { severity: "critical" }],
      confidence: 1,
      formula,
    });

    expect(result.finalScore).toBe(0);
    expect(result.verdict).toBe("reject");
  });
});

describe("verdict", () => {
  it("sends a borderline score to review", () => {
    const result = computeScore({
      components: components({ technical: 0.6, commercial: 0.6, deadline: 0.6, risk: 0.6, companyMatch: 0.6 }),
      risks: [],
      confidence: 1,
      formula,
    });

    expect(result.finalScore).toBe(60);
    expect(result.verdict).toBe("review");
  });

  it("escalates to a human when confidence is low, even with a high score", () => {
    const result = computeScore({
      components: components({ technical: 1, commercial: 1, deadline: 1, risk: 1, companyMatch: 1 }),
      risks: [],
      confidence: 0.4,
      formula,
    });

    expect(result.finalScore).toBe(100);
    expect(result.verdict).toBe("needs_human");
  });

  it("explains the outcome with numbers that match the result", () => {
    const result = computeScore({
      components: components(),
      risks: [{ severity: "low" }],
      confidence: 1,
      formula,
    });

    expect(result.explanation.join("\n")).toContain(String(result.finalScore));
    expect(result.explanation.some((line) => line.includes("Риски low"))).toBe(true);
  });
});
