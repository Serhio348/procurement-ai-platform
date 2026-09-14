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
          unit: dayUnitForClaim(pattern.key, pattern.unit, quote),
          confidence: 0.92,
          hash: page.hash,
          page: page.page,
          quote,
        }),
      );
    }
  }
  return dedupeClaimValues([
    ...claims,
    ...extractZeroAdvance(page),
    ...extractOnDelivery(page),
    ...extractWithinDuration(page).claims,
  ]);
}

function dedupeClaimValues(claims: CommercialClaimValue[]): CommercialClaimValue[] {
  const seen = new Set<string>();
  const unique: CommercialClaimValue[] = [];
  for (const claim of claims) {
    const id = `${claim.key}:${String(claim.value)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(claim);
  }
  return unique;
}

const commercialNoteSource =
  "(?:срок(?:и)?\\s+поставки|условия оплаты|условия доставки|место поставки|срок(?:и)?\\s+выполнения\\p{L}*|срок(?:и)?\\s+оказания\\p{L}*|срок\\s+действия\\s+(?:предложени|заявк)\\p{L}*)\\s*:\\s*[^\\n;]{3,160}";

/** Labeled lines from TZ/request text. The match is the quote; no numbers invented. */
export function cheapExtractCommercialNotes(page: { text: string }): string[] {
  const regex = new RegExp(commercialNoteSource, "giu");
  const notes: string[] = [];
  for (const match of page.text.matchAll(regex)) {
    const quote = match[0]?.trim().replace(/\s+/g, " ");
    if (quote === undefined || quote.length === 0 || notes.includes(quote)) continue;
    notes.push(quote);
  }
  for (const note of extractWithinDuration({ hash: "a".repeat(64), page: 1, text: page.text }).notes) {
    if (!notes.includes(note)) notes.push(note);
  }
  return notes;
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

const onDeliverySource =
  "по\\s+факту\\s+поставк\\p{L}*|оплат\\p{L}*\\s+после\\s+поставк\\p{L}*";

function extractOnDelivery(page: {
  hash: string;
  page: number;
  text: string;
}): CommercialClaimValue[] {
  const regex = new RegExp(onDeliverySource, "giu");
  const claims: CommercialClaimValue[] = [];
  for (const match of page.text.matchAll(regex)) {
    const quote = match[0]?.trim();
    if (quote === undefined || quote.length === 0) continue;
    claims.push(
      CommercialClaim.parse({
        key: "commercial.payment_kind",
        value: "on_delivery",
        confidence: 0.9,
        hash: page.hash,
        page: page.page,
        quote,
      }),
    );
  }
  return claims;
}

const withinDaysSource =
  "в\\s+течени[еи]\\s+(?:(нескольких)|(\\d{1,3}))(?:\\s*\\([^)]{0,40}\\))?(?:\\s+(?:календарн|банковск|рабоч)\\p{L}*)?\\s*дн\\p{L}*";

function extractWithinDuration(page: {
  hash: string;
  page: number;
  text: string;
}): { claims: CommercialClaimValue[]; notes: string[] } {
  const claims: CommercialClaimValue[] = [];
  const notes: string[] = [];
  const regex = new RegExp(withinDaysSource, "giu");
  for (const match of page.text.matchAll(regex)) {
    const phrase = match[0]?.trim().replace(/\s+/g, " ");
    if (phrase === undefined || phrase.length === 0) continue;
    const index = match.index ?? 0;
    const left = page.text.slice(Math.max(0, index - 280), index);
    const right = page.text.slice(index + phrase.length, index + phrase.length + 80);
    const nearLeft = lastClause(left);
    const nearRight = firstClause(right);
    const kind = classifyWithinDuration(nearLeft, nearRight, left);
    const several = match[1] !== undefined;
    const raw = match[2];
    if (several) {
      const note = `${withinNoteLabel(kind, left, nearLeft, nearRight)}: в течение нескольких${severalDayFlavor(phrase)} дней.`;
      if (!notes.includes(note)) notes.push(note);
      continue;
    }
    if (raw === undefined) continue;
    const value = days(raw);
    if (value === undefined) continue;
    if (kind !== "payment" && kind !== "delivery") {
      const note = `${withinNoteLabel(kind, left, nearLeft, nearRight)}: ${phrase}.`;
      if (!notes.includes(note)) notes.push(note);
      continue;
    }
    claims.push(
      CommercialClaim.parse({
        key: kind === "delivery" ? "commercial.delivery_period_days" : "commercial.payment_deadline_days",
        value,
        unit: dayCountUnitFromQuote(phrase),
        confidence: 0.9,
        hash: page.hash,
        page: page.page,
        quote: phrase,
      }),
    );
  }
  return { claims, notes };
}

export function dayCountUnitFromQuote(quote: string): string {
  const folded = quote.toLocaleLowerCase("ru-BY");
  if (folded.includes("банковск")) return "banking_days";
  if (folded.includes("календарн")) return "calendar_days";
  if (folded.includes("рабоч")) return "working_days";
  return "days";
}

function dayUnitForClaim(key: string, fallback: string, quote: string): string {
  if (key === "commercial.payment_deadline_days" || key === "commercial.delivery_period_days") {
    return dayCountUnitFromQuote(quote);
  }
  return fallback;
}

function severalDayFlavor(phrase: string): string {
  const unit = dayCountUnitFromQuote(phrase);
  if (unit === "banking_days") return " банковских";
  if (unit === "calendar_days") return " календарных";
  if (unit === "working_days") return " рабочих";
  return "";
}

type WithinKind = "payment" | "delivery" | "work" | "bidValidity" | "note";

function classifyWithinDuration(nearLeft: string, nearRight: string, left: string): WithinKind {
  if (looksLikeBidDeadline(nearLeft) || looksLikeBidDeadline(nearRight)) return "note";
  if (looksLikeBidValidity(nearLeft) || looksLikeBidValidity(nearRight)) return "bidValidity";
  if (looksLikePaymentDeadline(nearLeft) || looksLikePaymentDeadline(nearRight)) return "payment";
  if (looksLikeDeliveryPeriod(nearLeft) || looksLikeDeliveryPeriod(nearRight)) return "delivery";
  if (looksLikeWorksPeriod(nearLeft) || looksLikeWorksPeriod(nearRight)) return "work";
  if (looksLikeContractStart(nearRight) && !looksLikePaymentDeadline(nearLeft)) return "delivery";
  const heading = durationHeading(left);
  if (heading !== undefined) return heading.kind;
  if (looksLikePaymentDeadline(left) && !looksLikeDeliveryPeriod(left)) return "payment";
  if (looksLikeDeliveryPeriod(left) && !looksLikePaymentDeadline(left)) return "delivery";
  return "note";
}

function withinNoteLabel(kind: WithinKind, left: string, nearLeft: string, nearRight: string): string {
  if (kind === "payment") return "Срок оплаты";
  if (kind === "delivery") return "Срок поставки";
  const heading = durationHeading(left);
  if (heading !== undefined) return heading.label;
  if (kind === "work") return "Срок выполнения работ/услуг";
  if (kind === "bidValidity") return "Срок действия предложения";
  const topic = topicLabel(nearLeft, nearRight);
  return topic ?? "Срок";
}

function topicLabel(nearLeft: string, nearRight: string): string | undefined {
  const context = `${nearLeft}\n${nearRight}`.toLocaleLowerCase("ru-BY");
  if (context.includes("банковск") || context.includes("реквизит")) {
    return "Срок предоставления банковских реквизитов";
  }
  if (context.includes("обеспечени")) return "Срок внесения обеспечения";
  if (context.includes("подпис") && context.includes("договор")) {
    return "Срок подписания договора";
  }
  if (context.includes("страхов")) return "Срок оформления страхования";
  if (context.includes("аккредитив")) return "Срок открытия аккредитива";
  if (context.includes("реестр")) return "Срок внесения в реестр поставщиков";
  return undefined;
}

// Tender documents use a fixed left-column heading like
// «Срок (сроки) поставки товаров (выполнения работ, оказания услуг)».
// When present, it is much more honest than a chopped clause tail.
function durationHeading(left: string): { label: string; kind: WithinKind } | undefined {
  const patterns = [
    /Срок\s*\(\s*сроки\s*\)\s*поставки\s+товаров\s*\(\s*выполнения\s+работ\s*,?\s*оказания\s+услуг\s*\)/giu,
    /Срок\s*\(\s*сроки\s*\)\s*поставки\s+товаров/giu,
    /Срок\s*\(\s*сроки\s*\)\s*поставки\s*\(\s*выполнения\s+работ\s*,?\s*оказания\s+услуг\s*\)/giu,
    /Срок\s*\(\s*сроки\s*\)\s*(?:выполнения\s+работ\s*,?\s*)?оказания\s+услуг/giu,
    /Условия\s+оплаты/giu,
    /Срок\s+оплаты/giu,
    /Срок\s+действия\s+предложени\p{L}*/giu,
  ];
  const matches = patterns.flatMap((pattern) => [...left.matchAll(pattern)]);
  const last = matches
    .sort((a, b) => {
      const ai = a.index ?? 0;
      const bi = b.index ?? 0;
      if (ai !== bi) return ai - bi;
      return (a[0]?.length ?? 0) - (b[0]?.length ?? 0);
    })
    .at(-1)?.[0];
  if (last === undefined) return undefined;
  const label = last.trim().replace(/[\s.:;]+$/u, "");
  if (label.length < 3) return undefined;
  const lower = label.toLocaleLowerCase("ru-BY");
  if (/оплат|расч/.test(lower)) return { label, kind: "payment" };
  if (/поставк|изготовлен/.test(lower) && !/выполнени|оказани/.test(lower)) {
    return { label, kind: "delivery" };
  }
  return { label, kind: "work" };
}

function lastClause(left: string): string {
  const parts = left.split(/[.\n;]/u);
  return (parts.at(-1) ?? left).slice(-120);
}

function firstClause(right: string): string {
  const stop = right.search(/[.\n;]/u);
  return (stop === -1 ? right : right.slice(0, stop)).slice(0, 80);
}

function looksLikeBidDeadline(text: string): boolean {
  return /срок(?:и)?\s+подач|подач\p{L}*\s+заяв/iu.test(text);
}

function looksLikePaymentDeadline(text: string): boolean {
  return /по\s+факту|оплат|расч[её]т|перечисл|платеж|казнач|аванс|предоплат|после\s+поставк|с\s+(?:даты|момента)\s+поставк|накладн|подписания\s+акта|акта\s+прием/iu.test(
    text,
  );
}

function looksLikeDeliveryPeriod(text: string): boolean {
  return /(?:срок(?:и)?\s+)?(?:поставк|поставл|поставить|отгруз|доставк|изготовлен|передан|передач)|товар\s+должен/iu.test(
    text,
  );
}

function looksLikeContractStart(text: string): boolean {
  return /с\s+(?:даты|момента)\s+(?:заключен|подписания\s+договор)/iu.test(text);
}

function looksLikeWorksPeriod(text: string): boolean {
  return /выполнени|выполнить|оказани|оказать|работ|услуг|монтаж|пусконалад|ввод\s+в\s+эксплуатац/iu.test(
    text,
  );
}

function looksLikeBidValidity(text: string): boolean {
  return /срок\s+действи|предложени\p{L}*\s+действ|заявк\p{L}*\s+действ|действител\p{L}*\s*$/iu.test(
    text,
  );
}



interface CheapPattern {
  key: CommercialClaimValue["key"];
  unit: string;
  source: string;
  parse: (raw: string) => number | undefined;
}

/** JS `\\w` is ASCII; contest wording is Cyrillic (`гарантийный`, `календарных`). */
const daysAfterNumber =
  "(\\d{1,3})(?:\\s*\\([^)]{0,40}\\))?(?:\\s+(?:календарн|банковск|рабоч)\\p{L}*)?\\s*дн\\p{L}*";
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
    key: "commercial.payment_deadline_days",
    unit: "days",
    // Treasury wording: «по факту поставки в течение 10 банковских дней».
    // Do not use bare «поставк» — that would steal delivery period days.
    source: `(?:по\\s+факту\\s+поставк\\p{L}*|оплат\\p{L}*\\s+после\\s+поставк\\p{L}*)[^\\n.]{0,80}?в\\s+течени[еи]\\s+${daysAfterNumber}`,
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
