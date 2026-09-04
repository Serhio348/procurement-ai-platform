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

  it("reads предоплата 40% but not a cap «предоплата до 99,5%»", () => {
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
    ).toEqual([]);
  });
});
