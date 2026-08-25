/**
 * Turning extracted facts into normalised 0..1 components. These are the
 * functions the MVP needs: a deadline and payment terms are what the first
 * vertical slice actually extracts.
 *
 * Missing data is never silently treated as zero - it is reported, so the
 * caller can lower confidence or escalate instead of scoring a guess.
 */

export interface ComponentScore {
  value: number;
  /** Inputs that were absent and therefore excluded from the calculation. */
  missing: readonly string[];
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Linear ramp: 0 at or below `low`, 1 at or above `high`. */
function ramp(value: number, low: number, high: number): number {
  if (high <= low) {
    throw new Error(`invalid ramp bounds: high (${high}) must be greater than low (${low})`);
  }
  return clamp01((value - low) / (high - low));
}

export interface DeadlineScoreConfig {
  /** At or below this many days the deadline is unworkable. */
  criticalDays: number;
  /** At or above this many days the deadline is comfortable. */
  comfortableDays: number;
}

/**
 * How workable the submission deadline is. A deadline already in the past
 * scores zero rather than going negative.
 */
export function deadlineScore(
  daysUntilDeadline: number | undefined,
  config: DeadlineScoreConfig,
): ComponentScore {
  if (daysUntilDeadline === undefined) {
    return { value: 0, missing: ["deadline"] };
  }
  return {
    value: ramp(daysUntilDeadline, config.criticalDays, config.comfortableDays),
    missing: [],
  };
}

export interface CommercialScoreConfig {
  /** Advance share the company considers healthy, 0..100. */
  preferredAdvancePercent: number;
  /** Payment delay that is still comfortable, in days. */
  acceptablePaymentDays: number;
  /** Payment delay at which the terms are considered bad. */
  criticalPaymentDays: number;
  weights: {
    advance: number;
    paymentDelay: number;
  };
}

export interface CommercialTermsInput {
  advancePercent?: number | undefined;
  paymentDeadlineDays?: number | undefined;
}

/**
 * Combines advance share and payment delay. Only the parts that were actually
 * extracted contribute; if nothing was extracted the score is zero and every
 * input is listed as missing.
 */
export function commercialScore(
  terms: CommercialTermsInput,
  config: CommercialScoreConfig,
): ComponentScore {
  const missing: string[] = [];
  let weightedSum = 0;
  let usedWeight = 0;

  if (terms.advancePercent === undefined) {
    missing.push("advancePercent");
  } else if (config.weights.advance > 0) {
    const advance =
      config.preferredAdvancePercent <= 0
        ? 1
        : clamp01(terms.advancePercent / config.preferredAdvancePercent);
    weightedSum += advance * config.weights.advance;
    usedWeight += config.weights.advance;
  }

  if (terms.paymentDeadlineDays === undefined) {
    missing.push("paymentDeadlineDays");
  } else if (config.weights.paymentDelay > 0) {
    // Inverted ramp: fewer days waiting for money is better.
    const delay =
      1 - ramp(terms.paymentDeadlineDays, config.acceptablePaymentDays, config.criticalPaymentDays);
    weightedSum += delay * config.weights.paymentDelay;
    usedWeight += config.weights.paymentDelay;
  }

  if (usedWeight === 0) {
    return { value: 0, missing };
  }

  return { value: clamp01(weightedSum / usedWeight), missing };
}
