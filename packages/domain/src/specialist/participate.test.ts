import { SpecialistCaseDocument, SpecialistProcurementCard } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { applyParticipateDocuments } from "./participate.js";

describe("applyParticipateDocuments", () => {
  it("attaches downloaded files and does not invent a score", () => {
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://example.test/auction/001",
      sourceProcurementId: "auction-001",
      actions: [
        {
          step: 1,
          actor: "DomainSearchAgent",
          status: "done",
          detail: "procurement.search: найдена «Кабель силовой».",
        },
      ],
    });
    const next = applyParticipateDocuments(card, [
      SpecialistCaseDocument.parse({
        name: "ТЗ.docx",
        sourceUrl: "https://example.test/files/tz.docx",
        downloadUrl: "https://example.test/files/tz.docx",
        hash: "a".repeat(64),
        sizeBytes: 1200,
        status: "hashed",
        extraction: {
          status: "extracted",
          kind: "office_text",
          pageCount: 1,
          letterCount: 40,
          confidence: 1,
          ocrApplied: false,
          textPreview: "Срок поставки 60 календарных дней.",
          pages: [{ page: 1, text: "Срок поставки 60 календарных дней.", ocrApplied: false, confidence: 1 }],
          notes: ["Текст взят из Word, без OCR."],
        },
      }),
    ]);

    expect(next.documents).toHaveLength(1);
    expect(next.documents[0]?.status).toBe("hashed");
    expect(next.termsDetail).toContain("Срок поставки: 60 календарных дн.");
    expect(next.actions.at(-1)?.actor).toBe("DocumentAgent");
    expect(next.reportMarkdown).toBeUndefined();
  });

  it("lets a model claim fill a gap and shows the quote, file and page for it", () => {
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://example.test/auction/010",
      sourceProcurementId: "auction/010",
    });
    const documents = [
      SpecialistCaseDocument.parse({
        name: "Договор.docx",
        sourceUrl: "https://example.test/files/dogovor.docx",
        hash: "a".repeat(64),
        status: "hashed",
        extraction: {
          status: "extracted",
          kind: "office_text",
          pageCount: 1,
          letterCount: 120,
          confidence: 1,
          ocrApplied: false,
          textPreview: "Расчёт производится в течение тридцати банковских дней.",
          pages: [
            {
              page: 1,
              text: "Расчёт за поставленный товар производится в течение тридцати банковских дней после подписания накладной.",
              ocrApplied: false,
              confidence: 1,
            },
          ],
        },
      }),
    ];

    const next = applyParticipateDocuments(card, documents, {
      modelClaims: [
        {
          key: "commercial.payment_deadline_days",
          value: 30,
          unit: "banking_days",
          confidence: 0.8,
          hash: "a".repeat(64),
          page: 1,
          quote: "Расчёт за поставленный товар производится в течение тридцати банковских дней",
        },
      ],
    });

    expect(next.termsDetail).toContain("Срок оплаты: 30 банковских дн.");
    expect(next.termsEvidence).toHaveLength(1);
    expect(next.termsEvidence[0]).toMatchObject({
      label: "Срок оплаты",
      value: "30 банковских дн.",
      documentName: "Договор.docx",
      page: 1,
      foundBy: "model",
    });
  });

  it("does not let a model claim overwrite a condition the rules already read", () => {
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://example.test/auction/011",
      sourceProcurementId: "auction/011",
    });
    const documents = [
      SpecialistCaseDocument.parse({
        name: "ТЗ.docx",
        sourceUrl: "https://example.test/files/tz.docx",
        hash: "b".repeat(64),
        status: "hashed",
        extraction: {
          status: "extracted",
          kind: "office_text",
          pageCount: 1,
          letterCount: 90,
          confidence: 1,
          ocrApplied: false,
          textPreview: "Гарантия на товар 24 месяца.",
          pages: [
            { page: 1, text: "Гарантия на товар 24 месяца с даты поставки.", ocrApplied: false, confidence: 1 },
          ],
        },
      }),
    ];

    const next = applyParticipateDocuments(card, documents, {
      modelClaims: [
        {
          key: "commercial.warranty_months",
          value: 60,
          confidence: 0.9,
          hash: "b".repeat(64),
          page: 1,
          quote: "Гарантия на товар 24 месяца с даты поставки",
        },
      ],
    });

    expect(next.termsDetail).toContain("Гарантия: 24 мес.");
    expect(next.termsEvidence.every((item) => item.foundBy === "rule")).toBe(true);
    expect(next.termsEvidence.some((item) => item.value === "60 мес.")).toBe(false);
  });

  it("keeps quoted delivery month and payment-after-delivery without inventing days", () => {
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Комплект фильтров",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://example.test/marketing/1",
      sourceProcurementId: "marketing/1",
    });
    const next = applyParticipateDocuments(card, [
      SpecialistCaseDocument.parse({
        name: "zapros-filtra.doc",
        sourceUrl: "https://example.test/files/1",
        hash: "a".repeat(64),
        status: "hashed",
        extraction: {
          status: "extracted",
          kind: "office_text",
          pageCount: 1,
          letterCount: 80,
          confidence: 0.86,
          ocrApplied: false,
          textPreview: "срок поставки: сентябрь 2026г.",
          pages: [
            {
              page: 1,
              text: "срок поставки: сентябрь 2026г.;\nусловия оплаты: по факту поставки;",
              ocrApplied: false,
              confidence: 0.86,
            },
          ],
        },
      }),
    ]);

    expect(next.termsDetail).toContain("Оплата: по факту поставки.");
    expect(next.termsDetail).toContain("срок поставки: сентябрь 2026г.");
    expect(next.termsDetail ?? "").not.toMatch(/Срок поставки:\s*\d+\s*дн/);
  });

  it("puts payment days next to on-delivery without pasting the contract paragraph", () => {
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Насос",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://example.test/request/1",
      sourceProcurementId: "request/1",
    });
    const next = applyParticipateDocuments(card, [
      SpecialistCaseDocument.parse({
        name: "dogovor.docx",
        sourceUrl: "https://example.test/files/dogovor.docx",
        hash: "a".repeat(64),
        status: "hashed",
        extraction: {
          status: "extracted",
          kind: "office_text",
          pageCount: 1,
          letterCount: 200,
          confidence: 1,
          ocrApplied: false,
          textPreview: "по факту поставки в течение 10 банковских дней",
          pages: [
            {
              page: 1,
              text: "Расчеты за товар производятся по факту поставки в течение 10 банковских дней на основании ТТН.",
              ocrApplied: false,
              confidence: 1,
            },
          ],
        },
      }),
    ]);

    expect(next.termsDetail).toContain("Оплата: по факту поставки.");
    expect(next.termsDetail).toContain("Срок оплаты: 10 банковских дн.");
    expect(next.termsDetail ?? "").not.toMatch(/районного бюджета|казначейства|ТТН/i);
  });

  it("keeps «в течение нескольких дней» as a line, not a made-up number", () => {
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Насос",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://example.test/request/2",
      sourceProcurementId: "request/2",
    });
    const next = applyParticipateDocuments(card, [
      SpecialistCaseDocument.parse({
        name: "dogovor.docx",
        sourceUrl: "https://example.test/files/dogovor2.docx",
        hash: "a".repeat(64),
        status: "hashed",
        extraction: {
          status: "extracted",
          kind: "office_text",
          pageCount: 1,
          letterCount: 80,
          confidence: 1,
          ocrApplied: false,
          textPreview: "по факту поставки в течении нескольких дней",
          pages: [
            {
              page: 1,
              text: "Оплата по факту поставки в течении нескольких дней.",
              ocrApplied: false,
              confidence: 1,
            },
          ],
        },
      }),
    ]);

    expect(next.termsDetail).toContain("Оплата: по факту поставки.");
    expect(next.termsDetail).toContain("Срок оплаты: в течение нескольких дней.");
    expect(next.termsDetail ?? "").not.toMatch(/Срок оплаты:\s*\d+\s*дн/);
  });

  it("does not print two bare «Срок» lines for payment and delivery", () => {
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Станция обезжелезивания",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://example.test/auction/3",
      sourceProcurementId: "auction/3",
    });
    const next = applyParticipateDocuments(card, [
      SpecialistCaseDocument.parse({
        name: "dogovor.doc",
        sourceUrl: "https://example.test/files/dogovor.doc",
        hash: "a".repeat(64),
        status: "hashed",
        extraction: {
          status: "extracted",
          kind: "office_text",
          pageCount: 1,
          letterCount: 180,
          confidence: 1,
          ocrApplied: false,
          textPreview: "поставить товар в течение 30 календарных дней",
          pages: [
            {
              page: 1,
              text:
                "Гарантийный срок 24 месяца.\nТовар передается Покупателю в течение 30 календарных дней с даты заключения договора.\nРасчеты производятся в течение 15 календарных дней с даты поставки.",
              ocrApplied: false,
              confidence: 1,
            },
          ],
        },
      }),
    ]);

    expect(next.termsDetail).toContain("Гарантия: 24 мес.");
    expect(next.termsDetail).toContain("Срок поставки: 30 календарных дн. с даты заключения договора");
    expect(next.termsDetail).toContain("Срок оплаты: 15 календарных дн. с даты поставки");
    expect(next.termsDetail ?? "").not.toMatch(/^Срок:/m);
  });
});
