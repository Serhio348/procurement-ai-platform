import type { CommercialClaim, CommercialFactKey } from "@procurement/contracts";
import { pageKey, quoteIsOnPage } from "./provenance.js";

/**
 * A verbatim quote alone does not make a claim true: a model can quote a real
 * sentence and attach a number that is not in it. These checks close that gap
 * in code, because a prompt cannot.
 */

/** Shorter quotes match almost any page and prove nothing. */
export const MIN_TRUSTED_QUOTE_LETTERS = 12;
/** Longer quotes are a page dump, not a citation the specialist can check. */
export const MAX_TRUSTED_QUOTE_CHARS = 600;

/** The quote must talk about the condition it is attached to. */
const KEY_SUBJECT: Record<CommercialFactKey, RegExp> = {
  "commercial.advance_percent": /аванс|предоплат/u,
  "commercial.advance_percent_cap": /аванс|предоплат/u,
  "commercial.payment_kind": /оплат|плат[её]ж|расч[её]т|перечисл/u,
  "commercial.final_payment_percent": /оплат|плат[её]ж|расч[её]т/u,
  "commercial.payment_deadline_days": /оплат|плат[её]ж|расч[её]т|перечисл/u,
  "commercial.delivery_period_days": /поставк|отгруз|постав|срок/u,
  "commercial.warranty_months": /гарант/u,
  "commercial.price": /цена|стоимост|сумм/u,
  "commercial.bid_security": /обеспечен|задаток/u,
  "commercial.contract_security": /обеспечен|гарант/u,
  "commercial.penalties": /неустойк|пен[яи]|штраф/u,
};

export interface TrustedClaimPage {
  hash: string;
  page: number;
  text: string;
}

export interface ClaimTrustRejection {
  claim: CommercialClaim;
  reason: "page_not_read" | "quote_not_on_page" | "quote_too_short" | "quote_too_long" | "number_not_in_quote" | "subject_missing";
}

export interface ClaimTrustResult {
  kept: CommercialClaim[];
  rejected: ClaimTrustRejection[];
}

/**
 * Keeps only claims the code can confirm against the page the model was given.
 * Every rejection is returned so the pipeline can log what the model invented.
 */
export function keepTrustedClaims(
  claims: readonly CommercialClaim[],
  pages: readonly TrustedClaimPage[],
): ClaimTrustResult {
  const text = new Map(pages.map((page) => [pageKey(page.hash, page.page), page.text]));
  const kept: CommercialClaim[] = [];
  const rejected: ClaimTrustRejection[] = [];
  for (const claim of claims) {
    const pageText = text.get(pageKey(claim.hash, claim.page));
    const reason = rejectionFor(claim, pageText);
    if (reason === undefined) {
      kept.push(claim);
      continue;
    }
    rejected.push({ claim, reason });
  }
  return { kept, rejected };
}

function rejectionFor(
  claim: CommercialClaim,
  pageText: string | undefined,
): ClaimTrustRejection["reason"] | undefined {
  if (pageText === undefined) return "page_not_read";
  if (letters(claim.quote) < MIN_TRUSTED_QUOTE_LETTERS) return "quote_too_short";
  if (claim.quote.length > MAX_TRUSTED_QUOTE_CHARS) return "quote_too_long";
  if (!quoteIsOnPage(claim.quote, pageText)) return "quote_not_on_page";
  if (!subjectInQuote(claim)) return "subject_missing";
  if (!numberInQuote(claim)) return "number_not_in_quote";
  return undefined;
}

function subjectInQuote(claim: CommercialClaim): boolean {
  return KEY_SUBJECT[claim.key].test(fold(claim.quote));
}

/**
 * A numeric claim must show its figure in its own quote. Zero is the exception:
 * "аванс не предусмотрен" carries no digit and is still a fact.
 */
function numberInQuote(claim: CommercialClaim): boolean {
  if (typeof claim.value !== "number") return true;
  if (claim.value === 0) return true;
  const quote = fold(claim.quote);
  for (const digits of numberForms(claim.value)) {
    if (quote.includes(digits)) return true;
  }
  return false;
}

/** 30 → "30"; 99.5 → "99.5" and "99,5"; 30.0 → "30". */
function numberForms(value: number): string[] {
  const plain = String(value);
  if (!plain.includes(".")) return [plain];
  return [plain, plain.replace(".", ",")];
}

function letters(value: string): number {
  return (value.match(/\p{L}/gu) ?? []).length;
}

function fold(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-BY").replace(/\s+/g, " ");
}
