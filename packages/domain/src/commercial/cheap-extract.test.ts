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
        unit: "banking_days",
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
        unit: "calendar_days",
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
        unit: "calendar_days",
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
    ).toContain("Срок выполнения работ/услуг: в течение нескольких дней.");
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
        unit: "working_days",
      }),
    ]);
  });

  it("labels payment and delivery «в течение N дней» instead of a bare «Срок»", () => {
    const text =
      "Поставщик обязуется поставить товар в течение 30 календарных дней с даты заключения договора.\n" +
      "Покупатель производит расчеты в течение 15 календарных дней с даты поставки по товарной накладной.";
    const claims = cheapExtractCommercialClaims({ hash, page: 1, text });
    expect(claims.filter((item) => item.key === "commercial.delivery_period_days")).toEqual([
      expect.objectContaining({
        key: "commercial.delivery_period_days",
        value: 30,
        unit: "calendar_days",
      }),
    ]);
    expect(claims.filter((item) => item.key === "commercial.payment_deadline_days")).toEqual([
      expect.objectContaining({
        key: "commercial.payment_deadline_days",
        value: 15,
        unit: "calendar_days",
      }),
    ]);
    expect(cheapExtractCommercialNotes({ text }).some((note) => note.startsWith("Срок:"))).toBe(false);
  });

  it("labels works and bid-validity «в течение N дней» instead of a bare «Срок»", () => {
    const text =
      "Подрядчик выполняет работы в течение 5 рабочих дней.\n" +
      "Предложение участника должно быть действительным в течение 3 рабочих дней.";
    const notes = cheapExtractCommercialNotes({ text });
    expect(notes).toContain("Срок выполнения работ/услуг: в течение 5 рабочих дней.");
    expect(notes).toContain("Срок действия предложения: в течение 3 рабочих дней.");
    expect(notes.some((note) => note.startsWith("Срок:"))).toBe(false);
  });

  it("labels an unknown term by its topic, not by a chopped clause", () => {
    const notes = cheapExtractCommercialNotes({
      text: "Победитель подписывает договор в течение 5 рабочих дней.",
    });
    expect(notes).toContain("Срок подписания договора: в течение 5 рабочих дней.");
  });

  it("uses the document's own heading when it is available", () => {
    const text =
      "Срок (сроки) поставки товаров (выполнения работ, оказания услуг)\n" +
      "производится в течение 5 рабочих дней.";
    const notes = cheapExtractCommercialNotes({ text });
    expect(notes).toContain(
      "Срок (сроки) поставки товаров (выполнения работ, оказания услуг): в течение 5 рабочих дней.",
    );
  });

  it("reads «передан в течение N дней с даты заключения договора» as delivery", () => {
    const claims = cheapExtractCommercialClaims({
      hash,
      page: 1,
      text: "Товар передается Покупателю в течение 30 календарных дней с даты заключения договора.",
    });
    expect(claims.filter((item) => item.key === "commercial.delivery_period_days")).toEqual([
      expect.objectContaining({ value: 30, unit: "calendar_days" }),
    ]);
    expect(claims.some((item) => item.key === "commercial.payment_deadline_days")).toBe(false);
  });

  it("reads «в течение N дней с даты заключения договора» as delivery when payment words are absent", () => {
    const claims = cheapExtractCommercialClaims({
      hash,
      page: 1,
      text: "Исполнение осуществляется в течение 30 календарных дней с даты заключения договора.",
    });
    expect(claims.filter((item) => item.key === "commercial.delivery_period_days")).toEqual([
      expect.objectContaining({ value: 30, unit: "calendar_days" }),
    ]);
  });

  it("reads «в течение N дней с даты поставки» as payment even without the word оплата nearby", () => {
    const claims = cheapExtractCommercialClaims({
      hash,
      page: 1,
      text: "Денежные средства перечисляются в течение 15 календарных дней с даты поставки товара.",
    });
    expect(claims.filter((item) => item.key === "commercial.payment_deadline_days")).toEqual([
      expect.objectContaining({ value: 15, unit: "calendar_days" }),
    ]);
    expect(claims.some((item) => item.key === "commercial.delivery_period_days")).toBe(false);
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
