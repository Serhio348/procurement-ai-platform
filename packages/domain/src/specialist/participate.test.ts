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
    expect(next.termsDetail).toContain("Срок поставки: 60 дн.");
    expect(next.actions.at(-1)?.actor).toBe("DocumentAgent");
    expect(next.reportMarkdown).toBeUndefined();
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
});
