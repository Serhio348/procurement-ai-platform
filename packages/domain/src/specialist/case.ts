import {
  CommercialTerms,
  Fact,
  SpecialistLiveRun,
  SpecialistProcurementCard,
  type EvidenceId,
  type FactId,
  type ProcedureCard,
  type ProcedureKind,
  type ProcedureStatus,
  type SpecialistCaseDocument,
  type SpecialistPipelineAction,
} from "@procurement/contracts";
import { assembleCommercialTerms } from "../commercial/assemble.js";
import { cheapExtractCommercialClaims } from "../commercial/cheap-extract.js";
import { keepQuotedClaims, pageKey } from "../commercial/provenance.js";
import { pageSafeForCommercialFacts } from "../documents/text-quality.js";
import { compileProcurementReport } from "../report/compile.js";
import { cheapClassifyHit } from "../search/cheap-classify.js";

export function compileSpecialistCase(raw: unknown): ReturnType<typeof SpecialistProcurementCard.parse> {
  const run = SpecialistLiveRun.parse(raw);
  const classified = cheapClassifyHit(
    { title: run.hit.title, ...(run.hit.buyerName === undefined ? {} : { buyerName: run.hit.buyerName }) },
    { keywords: run.keywords, excludeKeywords: [] },
  );
  const pageMap = new Map<string, string>([[pageKey(run.cardTextHash, 1), run.cardText]]);
  const rawClaims = [
    ...cheapExtractCommercialClaims({ hash: run.cardTextHash, page: 1, text: run.cardText }),
  ];
  for (const document of run.documents) {
    const extraction = document.extraction;
    const documentHash = document.hash;
    if (extraction === undefined || documentHash === undefined) continue;
    for (const page of extraction.pages) {
      pageMap.set(pageKey(documentHash, page.page), page.text);
      if (!pageSafeForCommercialFacts(page)) continue;
      rawClaims.push(
        ...cheapExtractCommercialClaims({ hash: documentHash, page: page.page, text: page.text }),
      );
    }
  }
  const claims = keepQuotedClaims(rawClaims, pageMap);
  const extractedAt = run.capturedAt;
  const facts = claims.map((claim, index) => {
    const evidenceId = uuidFromHex(`${run.cardTextHash}${String(index)}e`) as EvidenceId;
    const factId = uuidFromHex(`${run.cardTextHash}${claim.key}${String(index)}`) as FactId;
    return Fact.parse({
      id: factId,
      procurementId: run.procurementId,
      key: claim.key,
      value: claim.value,
      unit: claim.unit,
      evidenceIds: [evidenceId],
      confidence: claim.confidence,
      extractedBy: "cheap_extract",
      extractedAt,
    });
  });
  const assembled = assembleCommercialTerms(facts);
  const extractNotes = run.documents.flatMap((document) =>
    (document.extraction?.notes ?? []).map((note) => `${document.name}: ${note}`),
  );
  const extractPreview = run.documents
    .map((document) => document.extraction?.textPreview)
    .find((value) => value !== undefined && value.trim().length > 0);
  const hashedCount = run.documents.filter((item) => item.status === "hashed").length;
  const failedCount = run.documents.filter((item) => item.status === "download_failed").length;
  const ocrCount = run.documents.filter((item) => item.extraction?.ocrApplied === true).length;
  const extractedDocs = run.documents.filter((item) => item.extraction !== undefined).length;
  const quote = paymentQuote(run.card);
  const reportTerms = emptyTerms(assembled.terms)
    ? quote === undefined
      ? undefined
      : CommercialTerms.parse({
          notes: [
            `Текст площадки, доля аванса кодом не разобрана (нет шаблона «аванс N%», модель не вызывалась): ${quote}`,
          ],
        })
    : assembled.terms;
  const report = compileProcurementReport({
    card: {
      title: run.card.title,
      url: run.card.url,
      status: run.card.status,
      kind: run.card.kind,
      sourceProcurementId: run.card.sourceProcurementId,
    },
    profileName: run.profileName,
    ...(reportTerms === undefined ? {} : { terms: reportTerms }),
  });
  const actions = pipelineActions({
    hitTitle: run.hit.title,
    classifiedBy: classified.matchedTerms,
    verdict: classified.verdict,
    card: run.card,
    documents: run.documents,
    hashedCount,
    failedCount,
    extractedDocs,
    ocrCount,
    termLines: termLines(assembled.terms),
    extracted: facts.length > 0,
  });

  return SpecialistProcurementCard.parse({
    id: run.procurementId,
    title: run.card.title,
    status: run.card.status,
    statusLabel: statusLabel(run.card.status),
    url: run.card.url,
    sourceProcurementId: run.card.sourceProcurementId,
    live: true,
    kindLabel: kindLabel(run.card.kind),
    ...(buyerName(run.card) === undefined ? {} : { buyerName: buyerName(run.card) }),
    ...(amountLabel(run.card) === undefined ? {} : { amountLabel: amountLabel(run.card) }),
    documents: run.documents,
    actions,
    ...(facts.length === 0 ? {} : { termsDetail: termLines(assembled.terms).join("\n") }),
    ...(paymentQuote(run.card) === undefined ? {} : { paymentQuote: paymentQuote(run.card) }),
    reportMarkdown: report.markdown,
    missing: report.missing,
    extractNotes,
    ...(extractPreview === undefined ? {} : { extractPreview }),
  });
}

function pipelineActions(input: {
  hitTitle: string;
  classifiedBy: readonly string[];
  verdict: string;
  card: ProcedureCard;
  documents: readonly SpecialistCaseDocument[];
  hashedCount: number;
  failedCount: number;
  extractedDocs: number;
  ocrCount: number;
  termLines: readonly string[];
  extracted: boolean;
}): SpecialistPipelineAction[] {
  const classifyDetail =
    input.classifiedBy.length > 0
      ? `Релевантна по словам: ${input.classifiedBy.join(", ")}.`
      : `Классификация: ${input.verdict}.`;
  return [
    {
      step: 1,
      actor: "DomainSearchAgent",
      status: "done",
      detail: `procurement.search: найдена «${input.hitTitle}». ${classifyDetail}`,
    },
    {
      step: 2,
      actor: "DomainSearchAgent",
      status: "done",
      detail: `procurement.get: карточка ${input.card.sourceProcurementId}, статус «${statusLabel(input.card.status)}».`,
    },
    {
      step: 3,
      actor: "DocumentAgent",
      status: input.documents.length === 0 ? "skipped" : "done",
      detail:
        input.documents.length === 0
          ? "procurement.get_documents: площадка не показала файлы."
          : documentIngestDetail(input),
    },
    {
      step: 4,
      actor: "CommercialTermsAgent",
      status: input.extracted ? "done" : "skipped",
      detail: input.extracted
        ? `Подтверждённые числа: ${input.termLines.join(" ")}`
        : "На карточке нет шаблона «аванс N%». Формулировка оплаты показана как цитата площадки, число из неё не выставлялось.",
    },
    {
      step: 5,
      actor: "ReportAgent",
      status: "done",
      detail: "Markdown собран кодом из карточки и подтверждённых фактов.",
    },
    {
      step: 6,
      actor: "Scoring",
      status: "skipped",
      detail: "Итоговая оценка не считалась: нет полного набора компонент. Модель оценку не ставит.",
    },
    {
      step: 7,
      actor: "MonitoringAgent",
      status: "skipped",
      detail: "Первый снимок. Не с чем сравнить — ChangeEvent не создан.",
    },
    {
      step: 8,
      actor: "NotificationAgent",
      status: "skipped",
      detail: "Нет срочного ChangeEvent — в inbox не кладём.",
    },
  ];
}

function documentIngestDetail(input: {
  documents: readonly SpecialistCaseDocument[];
  hashedCount: number;
  failedCount: number;
  extractedDocs: number;
  ocrCount: number;
}): string {
  const base = `procurement.get_documents: ${String(input.documents.length)} файл(ов), hashed: ${String(input.hashedCount)}, ошибок: ${String(input.failedCount)}.`;
  if (input.extractedDocs === 0) {
    return `${base} Распознавание текста не запускалось.`;
  }
  const skipped = input.documents.filter((item) => item.extraction?.kind === "skipped_project").length;
  const officeCount = input.documents.filter((item) => item.extraction?.kind === "office_text").length;
  if (skipped > 0 && input.ocrCount === 0 && officeCount === 0) {
    return `${base} Альбомы проекта не распознавали (${String(skipped)}), условия берём с карточки.`;
  }
  if (officeCount > 0) {
    return `${base} Текст Word/Excel: ${String(officeCount)}, альбомы проекта пропущены: ${String(skipped)}.`;
  }
  if (input.ocrCount > 0) {
    return `${base} Распознано ${String(input.extractedDocs)} PDF, скан конкурса: ${String(input.ocrCount)}.`;
  }
  return `${base} Текст взят из цифрового слоя ${String(input.extractedDocs)} файл(ов).`;
}

function emptyTerms(terms: CommercialTerms): boolean {
  return termLines(terms).length === 0;
}

function formatPercent(value: number): string {
  return String(value).replace(".", ",");
}

function formatAdvanceLine(value: number): string {
  return value === 0 ? "Аванс: нет." : `Аванс: ${formatPercent(value)}%.`;
}

function termLines(terms: CommercialTerms): string[] {
  const lines: string[] = [];
  if (terms.advancePercent !== undefined) {
    lines.push(formatAdvanceLine(terms.advancePercent.value));
  } else if (terms.advancePercentCap !== undefined) {
    lines.push(`Аванс: до ${formatPercent(terms.advancePercentCap.value)}%.`);
  }
  if (terms.paymentDeadlineDays !== undefined) {
    lines.push(`Срок оплаты: ${String(terms.paymentDeadlineDays.value)} дн.`);
  }
  if (terms.deliveryPeriodDays !== undefined) {
    lines.push(`Срок поставки: ${String(terms.deliveryPeriodDays.value)} дн.`);
  }
  if (terms.warrantyMonths !== undefined) {
    lines.push(`Гарантия: ${String(terms.warrantyMonths.value)} мес.`);
  }
  return lines;
}

function paymentQuote(card: ProcedureCard): string | undefined {
  const raw = card.lots.map((lot) => lot.paymentTermsRaw).find((value) => value !== undefined && value.length > 0);
  if (raw === undefined) return undefined;
  const cleaned = stripBlankPlaceholders(raw);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Form blanks (`__________`) are insertion points, not content for the specialist. */
function stripBlankPlaceholders(value: string): string {
  return value
    .replaceAll(/_+/g, "")
    .replaceAll(/\s+([,.;:!?])/g, "$1")
    .replaceAll(/\s{2,}/g, " ")
    .trim();
}

function buyerName(card: ProcedureCard): string | undefined {
  return card.buyer?.name ?? card.parties.find((party) => party.role === "buyer")?.name;
}

function amountLabel(card: ProcedureCard): string | undefined {
  const amount = card.amount ?? card.startingPrice;
  if (amount === undefined) return undefined;
  if ("raw" in amount && typeof amount.raw === "string" && amount.raw.length > 0) return amount.raw;
  if ("amount" in amount && typeof amount.amount === "number") {
    return `${String(amount.amount)} ${"currency" in amount ? String(amount.currency) : ""}`.trim();
  }
  return undefined;
}

function uuidFromHex(seed: string): string {
  const hex = [...seed]
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32)
    .padEnd(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function statusLabel(status: ProcedureStatus): string {
  switch (status) {
    case "announced":
      return "объявлена";
    case "accepting_bids":
      return "приём предложений";
    case "bidding_closed":
      return "приём завершён";
    case "auction_in_progress":
      return "идёт аукцион";
    case "under_review":
      return "на рассмотрении";
    case "completed":
      return "завершена";
    case "cancelled":
      return "отменена";
    case "unknown":
      return "неизвестен";
  }
}

function kindLabel(kind: ProcedureKind): string {
  switch (kind) {
    case "electronic_auction":
      return "электронный аукцион";
    case "request_for_quotations":
      return "запрос ценовых предложений";
    case "open_tender":
      return "открытый конкурс";
    case "competitive_negotiation":
      return "переговоры";
    case "single_source":
      return "закупка из одного источника";
    case "other":
      return "иная процедура";
  }
}
