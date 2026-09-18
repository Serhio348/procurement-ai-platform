import { ProcedureCard, SpecialistProcurementCard } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import {
  applySourceCard,
  procedureBuyerFields,
  procedureDetailFields,
  procedurePublicId,
} from "./source-card.js";

const now = "2026-09-11T06:00:00.000Z";

function source(overrides: Record<string, unknown> = {}) {
  return ProcedureCard.parse({
    sourceId: "goszakupki_by",
    sourceProcurementId: "request/3545600",
    url: "https://goszakupki.by/request/view/3545600",
    title: "Реконструкция ВЛ-0,4 кВ от КТП-129",
    fetchedAt: now,
    status: "accepting_bids",
    sourceStatus: "Рассмотрение документов/сведений",
    externalIds: [{ kind: "auc", value: "auc0003545600" }],
    buyer: {
      name: "Брестэнерго",
      registrationNumber: "200050653",
      address: "г. Брест, ул. Воровского, 13/1",
      contact: "Головко Роман Геннадьевич, +375333869267",
    },
    amount: { kind: "indicative", amount: 160651.42, currency: "BYN", raw: "160 651.42 BYN" },
    publishedAt: { precision: "date", date: "2026-09-03", timeZone: "Europe/Minsk" },
    bidsDeadline: { precision: "date", date: "2026-09-09", timeZone: "Europe/Minsk" },
    rawFields: {
      "Дата размещения приглашения": "03.09.2026",
      "Дата окончания приема предложений": "09.09.2026",
      "Дата и время окончания приема запросов о разъяснении документации о закупке":
        "08.09.2026 16:00",
      "Общая ориентировочная стоимость закупки": "160 651.42 BYN",
      "Размер платы оператору за обеспечение проведения процедуры закупки":
        "участники-резиденты – 0,5 БВ",
      "Иные сведения": "Согласно заданию на закупку",
    },
    ...overrides,
  });
}

describe("applySourceCard", () => {
  it("stores the platform card and listing fields without touching documents", () => {
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Строка из поиска",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/request/view/3545600",
      sourceProcurementId: "request/3545600",
      buyerName: "Брестэнерго",
      amountLabel: "105 292.65 BYN",
      documents: [
        {
          name: "ТЗ.docx",
          sourceUrl: "https://goszakupki.by/files/1",
          hash: "a".repeat(64),
          status: "hashed",
        },
      ],
    });

    const next = applySourceCard(card, source(), now);

    expect(next.sourceCard?.buyer?.registrationNumber).toBe("200050653");
    expect(next.amountLabel).toBe("160 651.42 BYN");
    expect(next.statusLabel).toBe("Рассмотрение документов/сведений");
    expect(next.watchSnapshot?.priceKey).toBe("160651.42");
    expect(next.documents).toHaveLength(1);
    expect(next.live).toBe(true);
  });

  it("copies «Вид процедуры закупки» onto kindLabel and replaces a coarse «иная»", () => {
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Строка из поиска",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/limited/view/3669746",
      sourceProcurementId: "limited/3669746",
      kindLabel: "иная процедура",
    });
    const next = applySourceCard(
      card,
      source({
        sourceProcurementId: "limited/3669746",
        url: "https://goszakupki.by/limited/view/3669746",
        kind: "open_tender",
        rawFields: {
          "Вид процедуры закупки": "Конкурс с ограниченным участием",
          "Дата размещения приглашения": "03.09.2026",
        },
      }),
      now,
    );
    expect(next.kindLabel).toBe("Конкурс с ограниченным участием");
    expect(procedureDetailFields(next.sourceCard!).find((row) => row.label === "Вид процедуры закупки")?.value).toBe(
      "Конкурс с ограниченным участием",
    );
  });

  it("falls back to the URL family when the page field is missing", () => {
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Строка из поиска",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/marketing/view/1",
      sourceProcurementId: "marketing/1",
      kindLabel: "иная процедура",
    });
    const next = applySourceCard(
      card,
      source({
        sourceProcurementId: "marketing/1",
        url: "https://goszakupki.by/marketing/view/1",
        kind: "other",
        rawFields: {},
      }),
      now,
    );
    expect(next.kindLabel).toBe("заявка о ценах (тарифах)");
  });

  it("does not store a blank source status as the specialist label", () => {
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Строка из поиска",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/request/view/3545600",
      sourceProcurementId: "request/3545600",
    });
    const next = applySourceCard(card, source({ status: "unknown", sourceStatus: "" }), now);
    expect(next.statusLabel).toBe("приём заявок");
  });
});

describe("procedure display fields", () => {
  it("shows buyer and page rows in the source wording", () => {
    const card = source();
    expect(procedurePublicId(card)).toBe("auc0003545600");
    expect(procedureBuyerFields(card)).toEqual([
      { label: "Наименование", value: "Брестэнерго" },
      { label: "Место нахождения", value: "г. Брест, ул. Воровского, 13/1" },
      { label: "УНП", value: "200050653" },
      { label: "Контактные номера", value: "Головко Роман Геннадьевич, +375333869267" },
    ]);
    const details = procedureDetailFields(card);
    expect(details.map((row) => row.label)).toContain(
      "Дата и время окончания приема запросов о разъяснении документации о закупке",
    );
    expect(details.find((row) => row.label.startsWith("Общая ориентировочная"))?.value).toBe(
      "160 651.42 BYN",
    );
    expect(details.some((row) => row.label.startsWith("Общая предельная"))).toBe(false);
  });

  it("falls back to typed dates when rawFields are empty", () => {
    const card = source({ rawFields: {} });
    expect(procedureDetailFields(card)).toEqual(
      expect.arrayContaining([
        { label: "Дата размещения приглашения", value: "03.09.2026" },
        { label: "Дата окончания приема предложений", value: "09.09.2026" },
        { label: "Общая ориентировочная стоимость закупки", value: "160 651.42 BYN" },
      ]),
    );
  });
});
