import { describe, expect, it } from "vitest";
import {
  type CommercialScoreConfig,
  type DeadlineScoreConfig,
  commercialScore,
  deadlineScore,
} from "./components.js";

const deadlineConfig: DeadlineScoreConfig = { criticalDays: 3, comfortableDays: 21 };

const commercialConfig: CommercialScoreConfig = {
  preferredAdvancePercent: 30,
  acceptablePaymentDays: 30,
  criticalPaymentDays: 120,
  weights: { advance: 1, paymentDelay: 1 },
};

describe("deadline score", () => {
  it("scores a comfortable deadline at the maximum", () => {
    expect(deadlineScore(30, deadlineConfig).value).toBe(1);
  });

  it("scores an already expired deadline at zero", () => {
    expect(deadlineScore(-2, deadlineConfig).value).toBe(0);
  });

  it("ramps linearly between the critical and comfortable bounds", () => {
    expect(deadlineScore(12, deadlineConfig).value).toBeCloseTo(0.5, 5);
  });

  it("reports a missing deadline instead of scoring it as zero silently", () => {
    const result = deadlineScore(undefined, deadlineConfig);
    expect(result.missing).toEqual(["deadline"]);
  });
});

describe("commercial score", () => {
  it("rewards an advance at or above the preferred share", () => {
    const result = commercialScore(
      { advancePercent: 30, paymentDeadlineDays: 30 },
      commercialConfig,
    );
    expect(result.value).toBe(1);
    expect(result.missing).toEqual([]);
  });

  it("penalises a long payment delay", () => {
    const result = commercialScore(
      { advancePercent: 30, paymentDeadlineDays: 120 },
      commercialConfig,
    );
    // advance 1.0 and payment delay 0.0, evenly weighted
    expect(result.value).toBeCloseTo(0.5, 5);
  });

  it("uses only the terms that were actually extracted", () => {
    const result = commercialScore({ advancePercent: 15 }, commercialConfig);

    expect(result.value).toBeCloseTo(0.5, 5);
    expect(result.missing).toEqual(["paymentDeadlineDays"]);
  });

  it("reports every missing input when nothing was extracted", () => {
    const result = commercialScore({}, commercialConfig);

    expect(result.value).toBe(0);
    expect(result.missing).toEqual(["advancePercent", "paymentDeadlineDays"]);
  });
});
