import type {
  CommercialClaim,
  CommercialFactKey,
  SpecialistTermsEvidence,
} from "@procurement/contracts";
import { formatDayCount, paymentKindLabel } from "./detail.js";
import type { TrustedClaimPage } from "./trust.js";

/** Conditions the specialist asks about first. Their absence is what triggers a model read. */
export const CORE_COMMERCIAL_KEYS: CommercialFactKey[] = [
  "commercial.advance_percent",
  "commercial.payment_deadline_days",
  "commercial.delivery_period_days",
  "commercial.warranty_months",
];

/** Advance stated as a ceiling answers the advance question too. */
const KEY_SUBSTITUTE: Partial<Record<CommercialFactKey, CommercialFactKey>> = {
  "commercial.advance_percent": "commercial.advance_percent_cap",
};

const PAGE_SUBJECTS = [
  /аванс|предоплат/u,
  /оплат|плат[её]ж|расч[её]т/u,
  /гарант/u,
  /срок(?:и)?\s+поставк|поставк/u,
  /обеспечен/u,
  /неустойк|пен[яи]|штраф/u,
] as const;

export function missingCommercialKeys(
  claims: readonly CommercialClaim[],
): CommercialFactKey[] {
  const present = new Set(claims.map((claim) => claim.key));
  return CORE_COMMERCIAL_KEYS.filter((key) => {
    if (present.has(key)) return false;
    const substitute = KEY_SUBSTITUTE[key];
    return substitute === undefined || !present.has(substitute);
  });
}

/**
 * Pages worth sending to the model, most promising first. Sending the whole
 * tender pack would cost tokens on drawings and specification tables that
 * never carry payment wording.
 */
export function rankCommercialPages(
  pages: readonly TrustedClaimPage[],
  limit: number,
): TrustedClaimPage[] {
  const scored = pages
    .map((page, index) => ({ page, index, score: pageScore(page.text) }))
    .filter((item) => item.score > 0);
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  return scored.slice(0, Math.max(0, limit)).map((item) => item.page);
}

function pageScore(text: string): number {
  const folded = text.toLocaleLowerCase("ru-BY");
  return PAGE_SUBJECTS.reduce((sum, subject) => (subject.test(folded) ? sum + 1 : sum), 0);
}

export interface EvidenceDocument {
  hash?: string | undefined;
  name: string;
}

/**
 * Turns verified claims into checkable rows: condition, wording, file, page.
 * Rule claims win over model claims that say the same thing.
 */
export function termsEvidenceFromClaims(
  claims: readonly CommercialClaim[],
  documents: readonly EvidenceDocument[],
  foundBy: (claim: CommercialClaim) => "rule" | "model",
): SpecialistTermsEvidence[] {
  const names = new Map(
    documents
      .filter((document): document is EvidenceDocument & { hash: string } => document.hash !== undefined)
      .map((document) => [document.hash, document.name]),
  );
  const rows: SpecialistTermsEvidence[] = [];
  for (const claim of claims) {
    const value = claimValueLabel(claim);
    if (value === undefined) continue;
    const documentName = names.get(claim.hash);
    if (documentName === undefined) continue;
    const row: SpecialistTermsEvidence = {
      key: claim.key,
      label: claimLabel(claim.key),
      value,
      quote: claim.quote.trim(),
      documentName,
      page: claim.page,
      foundBy: foundBy(claim),
    };
    const twin = rows.findIndex(
      (item) => item.key === row.key && item.value === row.value && item.page === row.page,
    );
    if (twin === -1) {
      rows.push(row);
      continue;
    }
    if (rows[twin]?.foundBy === "model" && row.foundBy === "rule") rows[twin] = row;
  }
  return rows;
}

function claimLabel(key: CommercialFactKey): string {
  switch (key) {
    case "commercial.advance_percent":
    case "commercial.advance_percent_cap":
      return "Аванс";
    case "commercial.payment_kind":
      return "Вид оплаты";
    case "commercial.final_payment_percent":
      return "Окончательный платёж";
    case "commercial.payment_deadline_days":
      return "Срок оплаты";
    case "commercial.delivery_period_days":
      return "Срок поставки";
    case "commercial.warranty_months":
      return "Гарантия";
    case "commercial.price":
      return "Цена";
    case "commercial.bid_security":
      return "Обеспечение заявки";
    case "commercial.contract_security":
      return "Обеспечение договора";
    case "commercial.penalties":
      return "Неустойка";
  }
}

function claimValueLabel(claim: CommercialClaim): string | undefined {
  if (claim.key === "commercial.payment_kind") {
    if (typeof claim.value !== "string") return undefined;
    return paymentKindLabel(asPaymentKind(claim.value)).replace(/^Оплата:\s*/u, "").replace(/\.$/u, "");
  }
  if (typeof claim.value === "number") {
    if (claim.key === "commercial.advance_percent") {
      return claim.value === 0 ? "нет" : `${percent(claim.value)}%`;
    }
    if (claim.key === "commercial.advance_percent_cap") return `до ${percent(claim.value)}%`;
    if (claim.key === "commercial.final_payment_percent") return `${percent(claim.value)}%`;
    if (claim.key === "commercial.warranty_months") return `${String(claim.value)} мес.`;
    if (
      claim.key === "commercial.payment_deadline_days" ||
      claim.key === "commercial.delivery_period_days"
    ) {
      return formatDayCount(claim.value, claim.unit);
    }
    return String(claim.value);
  }
  if (typeof claim.value === "string" && claim.value.trim().length > 0) return claim.value.trim();
  return undefined;
}

function percent(value: number): string {
  return String(value).replace(".", ",");
}

function asPaymentKind(value: string): Parameters<typeof paymentKindLabel>[0] {
  switch (value) {
    case "advance":
    case "on_delivery":
    case "deferred":
    case "staged":
    case "letter_of_credit":
      return value;
    default:
      return "unknown";
  }
}
