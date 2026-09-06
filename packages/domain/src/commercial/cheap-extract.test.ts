import { describe, expect, it } from "vitest";
import { cheapExtractCommercialClaims, cheapExtractCommercialNotes } from "./cheap-extract.js";

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

  it("reads payment after delivery and labeled TZ lines without inventing days", () => {
    const text =
      "срок поставки: сентябрь 2026г.;\nусловия доставки: силами Поставщика;\nместо поставки: г. Гомель, ул. Медицинская, 6;\nусловия оплаты: по факту поставки;";
    const claims = cheapExtractCommercialClaims({ hash, page: 1, text });
    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "commercial.payment_kind",
          value: "on_delivery",
          quote: expect.stringMatching(/по факту поставки/i),
        }),
      ]),
    );
    expect(claims.some((item) => item.key === "commercial.delivery_period_days")).toBe(false);
    expect(cheapExtractCommercialNotes({ text })).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/срок поставки:\s*сентябрь 2026/i),
        expect.stringMatching(/условия оплаты:\s*по факту поставки/i),
      ]),
    );
  });

  it("reads payment days after «по факту поставки в течение N банковских дней»", () => {
    const claims = cheapExtractCommercialClaims({
      hash,
      page: 1,
      text:
        "Расчеты за товар за счет средств районного бюджета производятся платежными поручениями путем перечисления денежных средств со счетов органа казначейства на расчетный счет «Поставщика», по факту поставки в течение 10 банковских дней на основании товарно-транспортной накладной",
    });
    expect(claims.filter((item) => item.key === "commercial.payment_kind")).toEqual([
      expect.objectContaining({
        key: "commercial.payment_kind",
        value: "on_delivery",
      }),
    ]);
    expect(claims.filter((item) => item.key === "commercial.payment_deadline_days")).toEqual([
      expect.objectContaining({
        key: "commercial.payment_deadline_days",
        value: 10,
        quote: expect.stringMatching(/по факту поставки в течение 10 банковских дней/i),
      }),
    ]);
    expect(claims.some((item) => item.key === "commercial.delivery_period_days")).toBe(false);
  });

  it("does not treat delivery «в течение N дней» as a payment deadline", () => {
    const claims = cheapExtractCommercialClaims({
      hash,
      page: 1,
      text: "Срок поставки в течение 60 календарных дней с даты подписания договора.",
    });
    expect(claims.some((item) => item.key === "commercial.payment_deadline_days")).toBe(false);
    expect(claims.filter((item) => item.key === "commercial.delivery_period_days")).toEqual([
      expect.objectContaining({
        key: "commercial.delivery_period_days",
        value: 60,
      }),
    ]);
  });

  it("reads «в течение N календарных дней» and «в течении нескольких дней»", () => {
    expect(
      cheapExtractCommercialClaims({
        hash,
        page: 1,
        text: "Оплата в течение 15 календарных дней с даты подписания акта.",
      }).filter((item) => item.key === "commercial.payment_deadline_days"),
    ).toEqual([
      expect.objectContaining({
        key: "commercial.payment_deadline_days",
        value: 15,
        quote: expect.stringMatching(/в течение 15 календарных дней/i),
      }),
    ]);
    expect(
      cheapExtractCommercialNotes({
        text: "Расчёт по факту поставки в течении нескольких дней.",
      }),
    ).toContain("Срок оплаты: в течение нескольких дней.");
    expect(
      cheapExtractCommercialNotes({
        text: "Работы выполнить в течение нескольких дней.",
      }),
    ).toContain("Срок: в течение нескольких дней.");
    expect(
      cheapExtractCommercialClaims({
        hash,
        page: 1,
        text: "Поставка в течение 7 рабочих дней.",
      }).filter((item) => item.key === "commercial.delivery_period_days"),
    ).toEqual([
      expect.objectContaining({
        key: "commercial.delivery_period_days",
        value: 7,
      }),
    ]);
  });

  it("reads «без аванса» as a zero advance, not a missing field", () => {
    expect(
      cheapExtractCommercialClaims({
        hash,
        page: 1,
        text: "Оплата после поставки. Без аванса. Расчёт по ТТН.",
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "commercial.advance_percent",
          value: 0,
          quote: expect.stringMatching(/без аванса/i),
        }),
        expect.objectContaining({
          key: "commercial.payment_kind",
          value: "on_delivery",
          quote: expect.stringMatching(/после поставки/i),
        }),
      ]),
    );
  });
});
