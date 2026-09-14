import { describe, expect, it } from "vitest";
import { cheapExtractCommercialClaims, cheapExtractCommercialNotes } from "./cheap-extract.js";
import { formatCommercialDetailLines } from "./detail.js";

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
        quote: expect.stringMatching(/в течение 15 календарных дней с даты подписания акта/i),
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

  it("keeps works terms and drops bid-validity and unrelated «в течение N дней»", () => {
    const text =
      "Подрядчик выполняет работы в течение 5 рабочих дней.\n" +
      "Предложение участника должно быть действительным в течение 3 рабочих дней.\n" +
      "Победитель подписывает договор в течение 4 рабочих дней.";
    const notes = cheapExtractCommercialNotes({ text });
    expect(notes).toContain("Срок выполнения работ/услуг: в течение 5 рабочих дней.");
    expect(notes.some((note) => note.includes("3 рабочих дней"))).toBe(false);
    expect(notes.some((note) => note.includes("4 рабочих дней"))).toBe(false);
  });

  it("reads «со дня заключения договора» as a supply anchor, not contract signing", () => {
    const claims = cheapExtractCommercialClaims({
      hash,
      page: 1,
      text: "Срок поставки товара (оборудования):\nв течение 30 рабочих дней со дня заключения (подписания) настоящего договора.",
    });
    expect(claims).toEqual([
      expect.objectContaining({
        key: "commercial.delivery_period_days",
        value: 30,
        unit: "working_days",
      }),
    ]);
  });

  it("reads bare «N дней» values from a tender table cell under the heading", () => {
    const text =
      "Срок (сроки) поставки товаров (выполнения работ, оказания услуг)\n" +
      "30 рабочих дней – изготовление, доставка и разгрузка средствами Поставщика.\n" +
      "10 рабочих дней – монтаж и окончательная сборка оборудования.";
    const notes = cheapExtractCommercialNotes({ text });
    expect(notes).toContain(
      "Срок (сроки) поставки товаров (выполнения работ, оказания услуг): 30 рабочих дней – изготовление, доставка и разгрузка средствами Поставщика.",
    );
    expect(notes).toContain(
      "Срок (сроки) поставки товаров (выполнения работ, оказания услуг): 10 рабочих дней – монтаж и окончательная сборка оборудования.",
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

  it("keeps what a 30-day payment is counted from, and treats «не превышающий» as a cap", () => {
    const text =
      "Условия оплаты – текущий аванс, не превышающий 70% стоимости работ, планируемых к выполнению в следующем (расчетном) месяце, при условии получения денежных средств от Заказчика. Оплата выполненных работ производится Подрядчиком на основании подписанной Сторонами справки формы С-3а в течении 30 (тридцать) календарных дней после подписания акта сдачи-приемки выполненных строительных и иных специальных монтажных работ, при условии получения денежных средств от Заказчика.";
    const claims = cheapExtractCommercialClaims({ hash, page: 1, text });
    expect(claims.filter((item) => item.key === "commercial.advance_percent")).toEqual([]);
    expect(claims.filter((item) => item.key === "commercial.advance_percent_cap")).toEqual([
      expect.objectContaining({
        key: "commercial.advance_percent_cap",
        value: 70,
        quote: expect.stringMatching(/не превышающий 70%/i),
      }),
    ]);
    expect(claims.filter((item) => item.key === "commercial.payment_deadline_days")).toEqual([
      expect.objectContaining({
        key: "commercial.payment_deadline_days",
        value: 30,
        unit: "calendar_days",
        quote: expect.stringMatching(
          /в течении 30 \(тридцать\) календарных дней после подписания акта сдачи-приемки/i,
        ),
      }),
    ]);
    expect(formatCommercialDetailLines(claims)).toEqual(
      expect.arrayContaining([
        "Аванс: до 70%.",
        expect.stringMatching(
          /Срок оплаты: 30 календарных дн\. после подписания акта сдачи-приемки/i,
        ),
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
