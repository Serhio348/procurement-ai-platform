import { describe, expect, it } from "vitest";
import type { CommercialClaim } from "@procurement/contracts";
import { missingCommercialKeys, rankCommercialPages, termsEvidenceFromClaims } from "./reading.js";

const HASH = "c".repeat(64);

describe("missingCommercialKeys", () => {
  it("asks the model only about conditions the rules did not read", () => {
    const claims = [
      { key: "commercial.advance_percent", value: 30, confidence: 0.9, hash: HASH, page: 1, quote: "аванс 30%" },
      { key: "commercial.warranty_months", value: 24, confidence: 0.9, hash: HASH, page: 1, quote: "гарантия 24 мес" },
    ] as CommercialClaim[];

    expect(missingCommercialKeys(claims)).toEqual([
      "commercial.payment_deadline_days",
      "commercial.delivery_period_days",
    ]);
  });

  it("counts an advance ceiling as an answer about the advance", () => {
    const claims = [
      {
        key: "commercial.advance_percent_cap",
        value: 30,
        confidence: 0.9,
        hash: HASH,
        page: 1,
        quote: "предоплата до 30%",
      },
    ] as CommercialClaim[];

    expect(missingCommercialKeys(claims)).not.toContain("commercial.advance_percent");
  });
});

describe("rankCommercialPages", () => {
  it("puts pages that mention money first and leaves drawings out", () => {
    const ranked = rankCommercialPages(
      [
        { hash: HASH, page: 1, text: "Спецификация кабеля, сечение и длина" },
        { hash: HASH, page: 2, text: "Условия оплаты: аванс, гарантия, неустойка за просрочку" },
        { hash: HASH, page: 3, text: "Срок поставки товара" },
      ],
      2,
    );

    expect(ranked.map((page) => page.page)).toEqual([2, 3]);
  });
});

describe("termsEvidenceFromClaims", () => {
  it("shows the condition with its wording, file and page", () => {
    const rows = termsEvidenceFromClaims(
      [
        {
          key: "commercial.payment_deadline_days",
          value: 30,
          unit: "banking_days",
          confidence: 0.8,
          hash: HASH,
          page: 4,
          quote: "Оплата в течение 30 банковских дней после подписания акта сдачи-приемки",
        },
      ] as CommercialClaim[],
      [{ hash: HASH, name: "Техническое задание.docx" }],
      () => "model",
    );

    expect(rows).toEqual([
      {
        key: "commercial.payment_deadline_days",
        label: "Срок оплаты",
        value: "30 банковских дн. после подписания акта сдачи-приемки",
        quote: "Оплата в течение 30 банковских дней после подписания акта сдачи-приемки",
        documentName: "Техническое задание.docx",
        page: 4,
        foundBy: "model",
      },
    ]);
  });

  it("drops a claim whose file is not in the case", () => {
    const rows = termsEvidenceFromClaims(
      [
        {
          key: "commercial.warranty_months",
          value: 24,
          confidence: 0.8,
          hash: "d".repeat(64),
          page: 1,
          quote: "гарантия 24 месяца",
        },
      ] as CommercialClaim[],
      [{ hash: HASH, name: "Договор.pdf" }],
      () => "model",
    );

    expect(rows).toEqual([]);
  });
});
