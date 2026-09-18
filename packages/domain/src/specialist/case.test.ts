import { ProcedureCard, SearchHit } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import {
  cardProcedureKindLabel,
  compileSpecialistCase,
  isClosedProcedureStatus,
  isPersistableCabinetCase,
  isPrunableUndecidedCase,
  procedureKindLabel,
  uuidFromHex,
} from "./case.js";

const hash = "a".repeat(64);
const now = "2026-09-03T10:00:00.000Z";

describe("compileSpecialistCase", () => {
  it("keeps a quoted 30% advance from the live card and does not invent 90%", () => {
    const card = compileSpecialistCase({
      capturedAt: now,
      profileName: "Электротехническое оборудование",
      keywords: ["КТПБ", "подстанция"],
      procurementId: "00000000-0000-4000-8000-000000000020",
      hit: SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/3545578",
        url: "https://goszakupki.by/auction/view/3545578",
        title: "Поставка КТПБ 10/0,4 кВ",
      }),
      card: ProcedureCard.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/3545578",
        url: "https://goszakupki.by/auction/view/3545578",
        title: "Поставка КТПБ 10/0,4 кВ",
        status: "accepting_bids",
        fetchedAt: now,
        rawFields: { Оплата: "Аванс 30 процентов." },
        lots: [
          {
            number: "1",
            title: "КТПБ",
            paymentTermsRaw: "Аванс 30 процентов.",
          },
        ],
      }),
      cardText: "Поставка КТПБ 10/0,4 кВ\nАванс 30 процентов.",
      cardTextHash: hash,
      documents: [
        {
          name: "ТЗ.pdf",
          sourceUrl: "https://goszakupki.by/files/get?id=1",
          hash,
          sizeBytes: 2048,
          status: "hashed",
          note: "application/pdf",
        },
      ],
    });

    expect(card.live).toBe(true);
    expect(card.sourceProcurementId).toBe("auction/3545578");
    expect(card.termsDetail).toContain("Аванс: 30%.");
    expect(card.paymentQuote).toContain("Аванс 30 процентов.");
    expect(card.reportMarkdown).toContain("Аванс: 30%.");
    expect(card.reportMarkdown).toContain("Аванс: 30%.");
    expect(card.reportMarkdown).not.toMatch(/90%/);
    expect(card.missing.some((item) => item.includes("оценка"))).toBe(true);
    expect(card.actions.map((item) => item.actor)).toEqual([
      "DomainSearchAgent",
      "DomainSearchAgent",
      "DocumentAgent",
      "CommercialTermsAgent",
      "ReportAgent",
      "Scoring",
      "MonitoringAgent",
      "NotificationAgent",
    ]);
    expect(card.documents[0]?.status).toBe("hashed");
  });

  it("shows low-confidence OCR to the specialist without turning it into an advance fact", () => {
    const ocrHash = "b".repeat(64);
    const card = compileSpecialistCase({
      capturedAt: now,
      profileName: "Электротехническое оборудование",
      keywords: ["КТПБ"],
      procurementId: "00000000-0000-4000-8000-000000000020",
      hit: SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/3545578",
        url: "https://goszakupki.by/auction/view/3545578",
        title: "Поставка КТПБ 10/0,4 кВ",
      }),
      card: ProcedureCard.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/3545578",
        url: "https://goszakupki.by/auction/view/3545578",
        title: "Поставка КТПБ 10/0,4 кВ",
        status: "accepting_bids",
        fetchedAt: now,
      }),
      cardText: "Поставка КТПБ 10/0,4 кВ",
      cardTextHash: hash,
      documents: [
        {
          name: "ТЗ.pdf",
          sourceUrl: "https://goszakupki.by/files/get?id=1",
          hash: ocrHash,
          sizeBytes: 2048,
          status: "hashed",
          extraction: {
            status: "ocr_low_confidence",
            kind: "ocr_scan",
            pageCount: 1,
            letterCount: 40,
            confidence: 0.47,
            ocrApplied: true,
            textPreview: "Аванс 30 процентов. Строительный проект.",
            pages: [
              {
                page: 1,
                text: "Аванс 30 процентов. Строительный проект.",
                ocrApplied: true,
                confidence: 0.47,
              },
            ],
            notes: ["Уверенность OCR ниже порога: текст показываем специалисту, в коммерческие факты не берём."],
          },
        },
      ],
    });

    expect(card.termsDetail).toBeUndefined();
    expect(card.extractPreview).toContain("Аванс 30");
    expect(card.extractNotes.join(" ")).toContain("ниже порога");
  });

  it("reads delivery and warranty from extracted Word TZ and does not turn «до 99,5%» into an advance", () => {
    const tzHash = "c".repeat(64);
    const card = compileSpecialistCase({
      capturedAt: now,
      profileName: "Электротехническое оборудование",
      keywords: ["КТПБ"],
      procurementId: "00000000-0000-4000-8000-000000000020",
      hit: SearchHit.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/3629820",
        url: "https://goszakupki.by/auction/view/3629820",
        title: "2БКТПБ 400кВА",
      }),
      card: ProcedureCard.parse({
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/3629820",
        url: "https://goszakupki.by/auction/view/3629820",
        title: "2БКТПБ 400кВА",
        status: "accepting_bids",
        fetchedAt: now,
        lots: [
          {
            number: "1",
            title: "2БКТПБ",
            paymentTermsRaw:
              "Оплата за оборудование: предоплата до 99,5 % (либо предоплата в размере стоимости материальных затрат _________________, определяемая плановой калькуляцией к договору).",
          },
        ],
      }),
      cardText: "2БКТПБ 400кВА\nОплата за оборудование: предоплата до 99,5 %.",
      cardTextHash: hash,
      documents: [
        {
          name: "tz-na-bktp.docx",
          sourceUrl: "https://goszakupki.by/files/get?id=7",
          hash: tzHash,
          sizeBytes: 36546,
          status: "hashed",
          extraction: {
            status: "extracted",
            kind: "office_text",
            pageCount: 1,
            letterCount: 400,
            confidence: 0.95,
            ocrApplied: false,
            textPreview: "Техническое задание",
            pages: [
              {
                page: 1,
                text: "1. Гарантийный срок не менее 60 месяцев с даты ввода.\n4. Срок поставки не более 60 календарных дней с даты подписания договора.",
                ocrApplied: false,
                confidence: 0.95,
              },
            ],
            notes: ["Текст взят из Word, без OCR."],
          },
        },
      ],
    });

    expect(card.termsDetail).toContain("Аванс: до 99,5%.");
    expect(card.termsDetail).toContain("Срок поставки: 60 календарных дн.");
    expect(card.termsDetail).toContain("Гарантия: 60 мес.");
    expect(card.termsDetail ?? "").not.toMatch(/Аванс:\s*99,5%\./);
    expect(card.missing).not.toContain("Доля аванса не подтверждена.");
    expect(card.paymentQuote).toContain("предоплата до 99,5 %");
    expect(card.paymentQuote).toContain("стоимости материальных затрат, определяемая");
    expect(card.paymentQuote ?? "").not.toMatch(/_/);
    expect(card.reportMarkdown).toContain("Срок поставки: 60 календарных дн.");
    expect(card.actions.find((item) => item.actor === "CommercialTermsAgent")?.detail).toContain(
      "Подтверждённые числа",
    );
  });
});

describe("isClosedProcedureStatus", () => {
  it("treats completed, cancelled and failed as finished, not bidding_closed", () => {
    expect(isClosedProcedureStatus("completed")).toBe(true);
    expect(isClosedProcedureStatus("cancelled")).toBe(true);
    expect(isClosedProcedureStatus("failed")).toBe(true);
    expect(isClosedProcedureStatus("bidding_closed")).toBe(false);
    expect(isClosedProcedureStatus("accepting_bids")).toBe(false);
  });
});

describe("isPrunableUndecidedCase", () => {
  const cutoff = Date.parse("2026-09-16T00:00:00.000Z");

  it("drops a finished unused case and keeps watch / participate", () => {
    expect(
      isPrunableUndecidedCase(
        {
          status: "completed",
          sourceProcurementId: "auction/1",
          live: true,
          lastSeenAt: "2026-09-16T12:00:00.000Z",
        },
        cutoff,
        new Set(),
      ),
    ).toBe(true);
    expect(
      isPrunableUndecidedCase(
        {
          foundAs: "review",
          status: "accepting_bids",
          sourceProcurementId: "auction/2",
          live: true,
        },
        cutoff,
        new Set(),
      ),
    ).toBe(false);
    expect(
      isPrunableUndecidedCase(
        {
          status: "completed",
          sourceProcurementId: "auction/1",
          triage: "participate",
          live: true,
        },
        cutoff,
        new Set(),
      ),
    ).toBe(false);
  });

  it("keeps the current search queue even when the hit is unused", () => {
    expect(
      isPrunableUndecidedCase(
        {
          id: "00000000-0000-4000-8000-000000000001",
          status: "accepting_bids",
          sourceProcurementId: "auction/1",
          live: true,
        },
        cutoff,
        new Set(),
        new Set(["00000000-0000-4000-8000-000000000001"]),
      ),
    ).toBe(false);
  });
});

describe("isPersistableCabinetCase", () => {
  it("keeps an undecided search hit that is still in a profile queue", () => {
    expect(
      isPersistableCabinetCase(
        { id: "00000000-0000-4000-8000-000000000001", foundAs: "match" },
        new Set(["00000000-0000-4000-8000-000000000001"]),
      ),
    ).toBe(true);
    expect(
      isPersistableCabinetCase({ id: "00000000-0000-4000-8000-000000000001", foundAs: "match" }, new Set()),
    ).toBe(false);
  });
});

describe("uuidFromHex", () => {
  it("does not collapse different goszakupki.by procedures onto one id", () => {
    const first = uuidFromHex("goszakupki_by:marketing/3541093");
    const second = uuidFromHex("goszakupki_by:request/3552348");
    expect(first).not.toBe(second);
  });
});

describe("cardProcedureKindLabel", () => {
  it("prefers the platform field, then a stored label, then a path-aware fallback", () => {
    expect(procedureKindLabel("electronic_auction")).toBe("электронный аукцион");
    expect(
      cardProcedureKindLabel({
        kindLabel: "иная процедура",
        sourceProcurementId: "limited/1",
        sourceCard: {
          kind: "other",
          rawFields: { "Вид процедуры закупки": "Конкурс с ограниченным участием" },
        },
      }),
    ).toBe("Конкурс с ограниченным участием");
    expect(
      cardProcedureKindLabel({
        sourceProcurementId: "limited/3664162",
        sourceCard: { kind: "open_tender" },
      }),
    ).toBe("конкурс с ограниченным участием");
    expect(
      cardProcedureKindLabel({
        kindLabel: "иная процедура",
        sourceProcurementId: "etrade/1",
        sourceCard: { kind: "other" },
      }),
    ).toBe("открытый конкурс");
    expect(cardProcedureKindLabel({})).toBeUndefined();
  });
});
