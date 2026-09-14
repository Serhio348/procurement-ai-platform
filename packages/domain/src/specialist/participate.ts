import {
  SpecialistProcurementCard,
  type CommercialClaim,
  type SpecialistCaseDocument,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
  type SpecialistTermsEvidence,
} from "@procurement/contracts";
import { cheapExtractCommercialClaims, cheapExtractCommercialNotes } from "../commercial/cheap-extract.js";
import { formatCommercialDetailLines } from "../commercial/detail.js";
import { termsEvidenceFromClaims } from "../commercial/reading.js";
import type { TrustedClaimPage } from "../commercial/trust.js";
import { pageSafeForCommercialFacts } from "../documents/text-quality.js";

export interface ParticipateReadingOptions {
  /**
   * Claims a model proposed over the same pages, already verified by
   * `keepTrustedClaims`. Rule claims win where both say the same thing.
   */
  modelClaims?: readonly CommercialClaim[];
}

export function applyParticipateDocuments(
  card: SpecialistProcurementCardValue,
  documents: readonly SpecialistCaseDocument[],
  reading: ParticipateReadingOptions = {},
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
  const read = readDocumentTerms(documents, reading.modelClaims ?? []);
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
    ...(read.termsDetail === undefined ? {} : { termsDetail: read.termsDetail }),
    termsEvidence: read.termsEvidence,
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

/** Pages of a case a model may be asked to read: recognised well enough for facts. */
export function participateReadablePages(
  documents: readonly SpecialistCaseDocument[],
): TrustedClaimPage[] {
  const pages: TrustedClaimPage[] = [];
  for (const document of documents) {
    const extraction = document.extraction;
    const hash = document.hash;
    if (extraction === undefined || hash === undefined) continue;
    for (const page of extraction.pages) {
      if (!pageSafeForCommercialFacts(page)) continue;
      pages.push({ hash, page: page.page, text: page.text });
    }
  }
  return pages;
}

export function participateRuleClaims(
  documents: readonly SpecialistCaseDocument[],
): CommercialClaim[] {
  return participateReadablePages(documents).flatMap((page) =>
    cheapExtractCommercialClaims(page),
  );
}

function readDocumentTerms(
  documents: readonly SpecialistCaseDocument[],
  modelClaims: readonly CommercialClaim[],
): { termsDetail: string | undefined; termsEvidence: SpecialistTermsEvidence[] } {
  const pages = participateReadablePages(documents);
  const ruleClaims = pages.flatMap((page) => cheapExtractCommercialClaims(page));
  const notes: string[] = [];
  for (const page of pages) {
    for (const note of cheapExtractCommercialNotes({ text: page.text })) {
      if (!notes.includes(note)) notes.push(note);
    }
  }
  const ruleKeys = new Set(ruleClaims.map((claim) => claim.key));
  // The model only fills gaps: where a regex already read a figure off the page,
  // the regex answer stays, so a model retry cannot reshuffle a checked card.
  const added = modelClaims.filter((claim) => !ruleKeys.has(claim.key));
  const claims = [...ruleClaims, ...added];
  const termsEvidence = termsEvidenceFromClaims(claims, documents, (claim) =>
    added.includes(claim) ? "model" : "rule",
  );
  const lines = formatCommercialDetailLines(claims, notes);
  if (lines.length > 0) return { termsDetail: lines.join("\n"), termsEvidence };
  if (pages.length === 0) return { termsDetail: undefined, termsEvidence };
  return {
    termsDetail:
      "В разобранном тексте нет аванса, срока в днях и гарантии. Смотрите цитаты в тексте документа.",
    termsEvidence,
  };
}
