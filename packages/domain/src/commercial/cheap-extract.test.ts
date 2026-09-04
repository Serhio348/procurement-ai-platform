import { describe, expect, it } from "vitest";
import { cheapExtractCommercialClaims } from "./cheap-extract.js";

const hash = "a".repeat(64);

describe("cheapExtractCommercialClaims", () => {
  it("reads an explicit advance percent from extracted text", () => {
    const claims = cheapExtractCommercialClaims({
      hash,
      page: 1,
      text: "Техническое задание. Аванс 30 процентов.",
    });
    expect(claims).toEqual([
      expect.objectContaining({
        key: "commercial.advance_percent",
        value: 30,
        unit: "%",
        quote: expect.stringContaining("Аванс 30"),
      }),
    ]);
  });

  it("does not treat garbled OCR as an advance percent", () => {
    expect(
      cheapExtractCommercialClaims({
        hash,
        page: 1,
        text: "ав нс 45",
      }),
    ).toEqual([]);
  });

  it("reads предоплата 40% as a point fact and «предоплата до 99,5%» as a cap", () => {
    expect(
      cheapExtractCommercialClaims({
        hash,
        page: 1,
        text: "Расчёты: предоплата 40% после договора.",
      }),
    ).toEqual([
      expect.objectContaining({
        key: "commercial.advance_percent",
        value: 40,
        quote: expect.stringContaining("предоплата 40%"),
      }),
    ]);
    expect(
      cheapExtractCommercialClaims({
        hash,
        page: 2,
        text: "Условия оплаты: предоплата до 99,5 %.",
      }),
    ).toEqual([
      expect.objectContaining({
        key: "commercial.advance_percent_cap",
        value: 99.5,
        quote: expect.stringContaining("до 99,5"),
      }),
    ]);
  });

  it("reads TZ delivery and warranty with календарных дней / не менее N месяцев", () => {
    const claims = cheapExtractCommercialClaims({
      hash,
      page: 1,
      text:
        "Критерии выбора.\n1. Гарантийный срок не менее 60 месяцев с даты ввода оборудования в эксплуатацию.\n4. Срок поставки не более 60 календарных дней с даты подписания договора и получения предоплаты;\n6. Требования по гарантии: не менее 60 месяцев.",
    });
    expect(claims.filter((item) => item.key === "commercial.delivery_period_days")).toEqual([
      expect.objectContaining({
        key: "commercial.delivery_period_days",
        value: 60,
        quote: expect.stringContaining("Срок поставки не более 60"),
      }),
    ]);
    expect(claims.filter((item) => item.key === "commercial.warranty_months")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "commercial.warranty_months",
          value: 60,
          quote: expect.stringContaining("60 месяцев"),
        }),
      ]),
    );
  });

  it("does not treat contract «аванс в размере 99,5%» as a point fact when the page also says «до 99,5%»", () => {
    const claims = cheapExtractCommercialClaims({
      hash,
      page: 1,
      text:
        "Оплата: предоплата до 99,5 %. Срок изготовления: в течение 60 календарных дней и/или получения авансового платежа в размере 99,5 %.",
    });
    expect(claims.filter((item) => item.key === "commercial.advance_percent")).toEqual([]);
    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "commercial.advance_percent_cap",
          value: 99.5,
        }),
      ]),
    );
  });

  it("reads «без аванса» as a zero advance, not a missing field", () => {
    expect(
      cheapExtractCommercialClaims({
        hash,
        page: 1,
        text: "Оплата после поставки. Без аванса. Расчёт по ТТН.",
      }),
    ).toEqual([
      expect.objectContaining({
        key: "commercial.advance_percent",
        value: 0,
        quote: expect.stringMatching(/без аванса/i),
      }),
    ]);
  });
});
