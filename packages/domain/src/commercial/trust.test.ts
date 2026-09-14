import { describe, expect, it } from "vitest";
import type { CommercialClaim } from "@procurement/contracts";
import { keepTrustedClaims } from "./trust.js";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

const PAGE = {
  hash: HASH,
  page: 4,
  text:
    "4.2. Оплата производится в течение 30 банковских дней после поставки товара. " +
    "Аванс не предусмотрен. Гарантийный срок на товар составляет 24 месяца.",
};

function claim(overrides: Partial<CommercialClaim>): CommercialClaim {
  return {
    key: "commercial.payment_deadline_days",
    value: 30,
    unit: "banking_days",
    confidence: 0.8,
    hash: HASH,
    page: 4,
    quote: "Оплата производится в течение 30 банковских дней",
    ...overrides,
  } as CommercialClaim;
}

describe("keepTrustedClaims", () => {
  it("keeps a claim whose figure is inside its own quote", () => {
    const result = keepTrustedClaims([claim({})], [PAGE]);

    expect(result.kept).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("drops a figure that is not in the quote, even when the quote is real", () => {
    const result = keepTrustedClaims(
      [claim({ value: 45, quote: "Оплата производится в течение 30 банковских дней" })],
      [PAGE],
    );

    expect(result.kept).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("number_not_in_quote");
  });

  it("drops a claim whose quote talks about another condition", () => {
    const result = keepTrustedClaims(
      [
        claim({
          key: "commercial.warranty_months",
          value: 30,
          unit: "months",
          quote: "Оплата производится в течение 30 банковских дней",
        }),
      ],
      [PAGE],
    );

    expect(result.kept).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("subject_missing");
  });

  it("drops a quote the cited page does not contain", () => {
    const result = keepTrustedClaims(
      [claim({ quote: "Оплата производится в течение 30 календарных дней" })],
      [PAGE],
    );

    expect(result.rejected[0]?.reason).toBe("quote_not_on_page");
  });

  it("drops a claim pinned to a page the model never received", () => {
    const result = keepTrustedClaims([claim({ hash: OTHER_HASH })], [PAGE]);

    expect(result.rejected[0]?.reason).toBe("page_not_read");
  });

  it("drops a quote too short to prove anything", () => {
    const result = keepTrustedClaims([claim({ value: 30, quote: "в 30 дней" })], [PAGE]);

    expect(result.rejected[0]?.reason).toBe("quote_too_short");
  });

  it("keeps a zero advance that carries no digit at all", () => {
    const result = keepTrustedClaims(
      [
        claim({
          key: "commercial.advance_percent",
          value: 0,
          quote: "Аванс не предусмотрен",
        }),
      ],
      [PAGE],
    );

    expect(result.kept).toHaveLength(1);
  });
});
