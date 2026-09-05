import {
  SpecialistProcurementCard,
  type CommercialClaim,
  type SpecialistCaseDocument,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
} from "@procurement/contracts";
import { cheapExtractCommercialClaims, cheapExtractCommercialNotes } from "../commercial/cheap-extract.js";
import { formatCommercialDetailLines } from "../commercial/detail.js";
import { pageSafeForCommercialFacts } from "../documents/text-quality.js";

export function applyParticipateDocuments(
  card: SpecialistProcurementCardValue,
  documents: readonly SpecialistCaseDocument[],
): SpecialistProcurementCardValue {
  const hashedCount = documents.filter((item) => item.status === "hashed").length;
  const failedCount = documents.filter((item) => item.status === "download_failed").length;
  const extractedDocs = documents.filter((item) => item.extraction !== undefined).length;
  const extractNotes = documents.flatMap((document) =>
    (document.extraction?.notes ?? []).map((note) => `${document.name}: ${note}`),
  );
  const extractPreview = documents
    .map((document) => document.extraction?.textPreview)
    .find((value) => value !== undefined && value.trim().length > 0);
  const termsDetail = termsDetailFromDocuments(documents);
  const nextStep = card.actions.reduce((max, action) => Math.max(max, action.step), 0) + 1;
  return SpecialistProcurementCard.parse({
    ...card,
    documents,
    actions: [
      ...card.actions,
      {
        step: nextStep,
        actor: "DocumentAgent",
        status: documents.length === 0 ? "skipped" : "done",
        detail: participateDocumentDetail({
          total: documents.length,
          hashedCount,
          failedCount,
          extractedDocs,
        }),
      },
    ],
    extractNotes,
    ...(extractPreview === undefined ? {} : { extractPreview }),
    ...(termsDetail === undefined ? {} : { termsDetail }),
  });
}

export function participateDocumentDetail(input: {
  total: number;
  hashedCount: number;
  failedCount: number;
  extractedDocs: number;
}): string {
  if (input.total === 0) {
    return "procurement.get_documents: площадка не показала файлы.";
  }
  return `procurement.get_documents: ${String(input.total)} файл(ов), скачано: ${String(input.hashedCount)}, ошибок: ${String(input.failedCount)}, разобрано: ${String(input.extractedDocs)}.`;
}

function termsDetailFromDocuments(documents: readonly SpecialistCaseDocument[]): string | undefined {
  const claims: CommercialClaim[] = [];
  const notes: string[] = [];
  let hadSafeText = false;
  for (const document of documents) {
    const extraction = document.extraction;
    const hash = document.hash;
    if (extraction === undefined || hash === undefined) continue;
    for (const page of extraction.pages) {
      if (!pageSafeForCommercialFacts(page)) continue;
      hadSafeText = true;
      claims.push(
        ...cheapExtractCommercialClaims({
          hash,
          page: page.page,
          text: page.text,
        }),
      );
      for (const note of cheapExtractCommercialNotes({ text: page.text })) {
        if (!notes.includes(note)) notes.push(note);
      }
    }
  }
  const lines = formatCommercialDetailLines(claims, notes);
  if (lines.length > 0) return lines.join("\n");
  if (!hadSafeText) return undefined;
  return "В разобранном тексте нет аванса, срока в днях и гарантии. Смотрите цитаты в тексте документа.";
}
