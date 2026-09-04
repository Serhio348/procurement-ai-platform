import { CommercialClaim, type CommercialClaim as CommercialClaimValue } from "@procurement/contracts";

/**
 * Conservative numeric reads from already extracted page text. Ambiguous
 * commercial language is left for the model; garbled OCR must not match.
 */

export function cheapExtractCommercialClaims(page: {
  hash: string;
  page: number;
  text: string;
}): CommercialClaimValue[] {
  const claims: CommercialClaimValue[] = [];
  for (const pattern of patterns) {
    const regex = new RegExp(pattern.source, "giu");
    for (const match of page.text.matchAll(regex)) {
      const raw = match[1];
      const quote = match[0]?.trim();
      if (raw === undefined || quote === undefined || quote.length === 0) continue;
      const value = pattern.parse(raw);
      if (value === undefined) continue;
      if (pattern.key === "commercial.advance_percent" && quoteLooksLikeAdvanceCap(quote)) {
        claims.push(
          CommercialClaim.parse({
            key: "commercial.advance_percent_cap",
            value,
            unit: pattern.unit,
            confidence: 0.92,
            hash: page.hash,
            page: page.page,
            quote,
          }),
        );
        continue;
      }
      if (pattern.key === "commercial.advance_percent" && pageHasAdvanceCap(page.text, value)) {
        continue;
      }
      claims.push(
        CommercialClaim.parse({
          key: pattern.key,
          value,
          unit: pattern.unit,
          confidence: 0.92,
          hash: page.hash,
          page: page.page,
          quote,
        }),
      );
    }
  }
  return [...claims, ...extractZeroAdvance(page)];
}

const zeroAdvanceSource =
  "без\\s+(?:аванса|предоплаты)|(?:аванс|предоплата)\\s+не\\s+предусмотрен\\p{L}*";

function extractZeroAdvance(page: {
  hash: string;
  page: number;
  text: string;
}): CommercialClaimValue[] {
  const regex = new RegExp(zeroAdvanceSource, "giu");
  const claims: CommercialClaimValue[] = [];
  for (const match of page.text.matchAll(regex)) {
    const quote = match[0]?.trim();
    if (quote === undefined || quote.length === 0) continue;
    claims.push(
      CommercialClaim.parse({
        key: "commercial.advance_percent",
        value: 0,
        unit: "%",
        confidence: 0.92,
        hash: page.hash,
        page: page.page,
        quote,
      }),
    );
  }
  return claims;
}

interface CheapPattern {
  key: CommercialClaimValue["key"];
  unit: string;
  source: string;
  parse: (raw: string) => number | undefined;
}

/** JS `\\w` is ASCII; contest wording is Cyrillic (`гарантийный`, `календарных`). */
const daysAfterNumber =
  "(\\d{1,3})(?:\\s*\\([^)]{0,40}\\))?(?:\\s+(?:календарн|банковск)\\p{L}*)?\\s*дн\\p{L}*";
const monthsAfterNumber = "(\\d{1,3})(?:\\s*\\([^)]{0,40}\\))?\\s*мес\\p{L}*";

const patterns: readonly CheapPattern[] = [
  {
    key: "commercial.advance_percent",
    unit: "%",
    source:
      "аванс(?:ов(?:ый|ого|ая|ое|ые))?\\p{L}*(?:\\s+плат[её]ж(?:а|ом|у)?)?[^\\n.]{0,40}?(\\d{1,3}(?:[.,]\\d{1,2})?)\\s*(?:%|процент(?:а|ов)?)",
    parse: percent,
  },
  {
    key: "commercial.advance_percent",
    unit: "%",
    source:
      "предоплат\\p{L}*[^\\n.]{0,40}?(\\d{1,3}(?:[.,]\\d{1,2})?)\\s*(?:%|процент(?:а|ов)?)",
    parse: percent,
  },
  {
    key: "commercial.payment_deadline_days",
    unit: "days",
    source: `оплат(?:а|ы|е|ой)[^\\n.]{0,40}?${daysAfterNumber}`,
    parse: days,
  },
  {
    key: "commercial.delivery_period_days",
    unit: "days",
    source: `срок(?:и)?\\s+поставк\\p{L}*[^\\n.]{0,80}?${daysAfterNumber}`,
    parse: days,
  },
  {
    key: "commercial.warranty_months",
    unit: "months",
    source: `гарант\\p{L}*[^\\n.]{0,80}?${monthsAfterNumber}`,
    parse: months,
  },
];

function quoteLooksLikeAdvanceCap(quote: string): boolean {
  return /до\s+\d/u.test(quote) || /не\s+более/u.test(quote);
}

function pageHasAdvanceCap(text: string, value: number): boolean {
  const number = String(value).replace(".", "[.,]");
  return new RegExp(`до\\s+${number}\\s*(?:%|процент)`, "iu").test(text);
}

function percent(raw: string): number | undefined {
  const value = Number(raw.replace(",", "."));
  if (!Number.isFinite(value) || value < 0 || value > 100) return undefined;
  return Math.round(value * 100) / 100;
}

function days(raw: string): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function months(raw: string): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}
