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
      let quote = match[0]?.trim();
      if (raw === undefined || quote === undefined || quote.length === 0) continue;
      const value = pattern.parse(raw);
      if (value === undefined) continue;
      if (
        pattern.key === "commercial.payment_deadline_days" ||
        pattern.key === "commercial.delivery_period_days"
      ) {
        quote = quoteWithDurationAnchor(quote, page.text.slice((match.index ?? 0) + match[0].length));
      }
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
    ...extractHeadingDurations(page).claims,
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
  "(?:срок(?:и)?\\s+поставки|условия оплаты|условия доставки|место поставки|срок(?:и)?\\s+выполнения\\p{L}*|срок(?:и)?\\s+оказания\\p{L}*|срок\\s+действия\\s+(?:предложени|заявк)\\p{L}*)\\s*[:–—-]\\s*(?:(?!\\.\\s)[^\\n;]){3,220}";

/** Labeled lines from TZ/request text. The match is the quote; no numbers invented. */
export function cheapExtractCommercialNotes(pageText: { text: string }): string[] {
  const regex = new RegExp(commercialNoteSource, "giu");
  const notes: string[] = [];
  for (const match of pageText.text.matchAll(regex)) {
    const quote = match[0]?.trim().replace(/\s+/g, " ");
    if (quote === undefined || quote.length === 0 || notes.includes(quote)) continue;
    notes.push(quote);
  }
  const page = { hash: "a".repeat(64), page: 1, text: pageText.text };
  for (const note of extractWithinDuration(page).notes) {
    if (!notes.includes(note)) notes.push(note);
  }
  for (const note of extractHeadingDurations(page).notes) {
    if (!notes.includes(note)) notes.push(note);
  }
  for (const note of extractInstallmentNotes(pageText)) {
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
    const right = page.text.slice(index + phrase.length, index + phrase.length + 220);
    const nearLeft = lastClause(left);
    const nearRight = firstClause(right);
    const kind = classifyWithinDuration(nearLeft, nearRight, left);
    const quoted = quoteWithDurationAnchor(phrase, right);
    // The specialist asked for supply and payment terms only — bid validity,
    // bank details, contract signing and unlabeled durations are noise.
    if (kind === "note" || kind === "bidValidity") continue;
    const label = durationHeading(left)?.label ?? withinTermLabel(kind);
    const several = match[1] !== undefined;
    const raw = match[2];
    if (several) {
      const note = `${label}: в течение нескольких${severalDayFlavor(phrase)} дней.`;
      if (!notes.includes(note)) notes.push(note);
      continue;
    }
    if (raw === undefined) continue;
    const value = days(raw);
    if (value === undefined) continue;
    if (kind === "work") {
      const note = `${label}: ${quoted}.`;
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
        quote: quoted,
      }),
    );
  }
  return { claims, notes };
}

function withinTermLabel(kind: WithinKind): string {
  if (kind === "payment") return "Срок оплаты";
  if (kind === "delivery") return "Срок поставки";
  return "Срок выполнения работ/услуг";
}

// Tender tables put the value right after the heading without «в течение»:
// «Срок (сроки) поставки …» then «30 рабочих дней – изготовление, доставка…».
const bareDaysSource =
  "(\\d{1,3})(?:\\s*\\([^)]{0,40}\\))?\\s*(?:рабоч|календарн|банковск)\\p{L}*\\s*дн\\p{L}*";

function extractHeadingDurations(page: {
  hash: string;
  page: number;
  text: string;
}): { claims: CommercialClaimValue[]; notes: string[] } {
  const claims: CommercialClaimValue[] = [];
  const notes: string[] = [];
  const regex = new RegExp(bareDaysSource, "giu");
  for (const heading of allDurationHeadings(page.text)) {
    const segment = page.text.slice(heading.end, heading.end + 350);
    for (const match of segment.matchAll(regex)) {
      const index = match.index ?? 0;
      // «в течение N дней» is already handled by extractWithinDuration.
      if (/течени\p{L}*\s*$/iu.test(segment.slice(Math.max(0, index - 12), index))) continue;
      const raw = match[1];
      if (raw === undefined) continue;
      const value = days(raw);
      if (value === undefined) continue;
      const tail = segment
        .slice(index + match[0].length)
        .match(/^\s*[–—-][^\n]{0,110}/u)?.[0];
      const phrase = `${match[0].trim()}${tail === undefined ? "" : ` ${tail.trim()}`}`.replace(
        /[.\s]+$/u,
        "",
      );
      const note = `${heading.label}: ${phrase}.`;
      if (!notes.includes(note)) notes.push(note);
      if (heading.kind === "payment" || heading.kind === "delivery") {
        claims.push(
          CommercialClaim.parse({
            key:
              heading.kind === "delivery"
                ? "commercial.delivery_period_days"
                : "commercial.payment_deadline_days",
            value,
            unit: dayCountUnitFromQuote(match[0]),
            confidence: 0.9,
            hash: page.hash,
            page: page.page,
            quote: phrase,
          }),
        );
      }
    }
  }
  return { claims, notes };
}

const installmentSource =
  "(?:поставк\\p{L}*|оплат\\p{L}*)\\s+(?:частями|этапами|по\\s+этапам|по\\s+графику)|рассрочк\\p{L}*|оплат\\p{L}*\\s+в\\s+рассрочку";

/** «Поставка частями» / «оплата по этапам» — kept as a verbatim quote. */
function extractInstallmentNotes(page: { text: string }): string[] {
  const regex = new RegExp(installmentSource, "giu");
  const notes: string[] = [];
  for (const match of page.text.matchAll(regex)) {
    const quote = match[0]?.trim().replace(/\s+/g, " ");
    if (quote === undefined || quote.length === 0) continue;
    const note = `${quote[0]?.toLocaleUpperCase("ru-BY")}${quote.slice(1)}.`;
    if (!notes.includes(note)) notes.push(note);
  }
  return notes;
}

/** «после подписания акта», «с даты поставки» — the event the period is counted from. */
const durationAnchorSource =
  "(?:после|с(?:о)?\\s+(?:даты|дня|момента)|со\\s+дня)\\s+[^\\n.;,]{3,180}";

function durationAnchorAfter(right: string): string {
  const trimmed = right.replace(/^[\s,]+/u, "");
  const match = trimmed.match(new RegExp(`^${durationAnchorSource}`, "iu"));
  if (match?.[0] === undefined) return "";
  return match[0].replace(/\s+/g, " ").trim();
}

function quoteWithDurationAnchor(phrase: string, right: string): string {
  const anchor = durationAnchorAfter(right);
  if (anchor.length === 0) return phrase;
  return `${phrase} ${anchor}`.replace(/\s+/g, " ");
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
  // «со дня заключения/поставки» is the anchor of a supply term, not a topic.
  if (looksLikeTermAnchor(nearRight) && !looksLikePaymentDeadline(nearLeft)) return "delivery";
  const heading = durationHeading(left);
  if (heading !== undefined) return heading.kind;
  if (looksLikePaymentDeadline(left) && !looksLikeDeliveryPeriod(left)) return "payment";
  if (looksLikeDeliveryPeriod(left) && !looksLikePaymentDeadline(left)) return "delivery";
  return "note";
}

// Tender documents use a fixed left-column heading like
// «Срок (сроки) поставки товаров (выполнения работ, оказания услуг)».
// When present, it is much more honest than a chopped clause tail.
const durationHeadingPatterns = [
  /Срок\s*\(\s*сроки\s*\)\s*поставки\s+товаров\s*\(\s*выполнения\s+работ\s*,?\s*оказания\s+услуг\s*\)/giu,
  /Срок\s*\(\s*сроки\s*\)\s*поставки\s+товаров/giu,
  /Срок\s*\(\s*сроки\s*\)\s*поставки\s*\(\s*выполнения\s+работ\s*,?\s*оказания\s+услуг\s*\)/giu,
  /Срок\s*\(\s*сроки\s*\)\s*(?:выполнения\s+работ\s*,?\s*)?оказания\s+услуг/giu,
  /Срок\s+поставки\s+товар\p{L}*\s*\([^)]{0,60}\)/giu,
  /Условия\s+оплаты/giu,
  /Срок\s+оплаты/giu,
  /Срок\s+поставки/giu,
];

function headingKindFor(label: string): WithinKind {
  const lower = label.toLocaleLowerCase("ru-BY");
  if (/оплат|расч/.test(lower)) return "payment";
  if (/поставк|изготовлен/.test(lower) && !/выполнени|оказани/.test(lower)) {
    return "delivery";
  }
  return "work";
}

function allDurationHeadings(
  text: string,
): { index: number; end: number; label: string; kind: WithinKind }[] {
  const byIndex = new Map<number, { index: number; end: number; label: string; kind: WithinKind }>();
  for (const pattern of durationHeadingPatterns) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      const label = match[0].trim().replace(/[\s.:;]+$/u, "");
      if (label.length < 3) continue;
      const previous = byIndex.get(index);
      if (previous !== undefined && previous.label.length >= label.length) continue;
      byIndex.set(index, {
        index,
        end: index + match[0].length,
        label,
        kind: headingKindFor(label),
      });
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function durationHeading(left: string): { label: string; kind: WithinKind } | undefined {
  return allDurationHeadings(left).at(-1);
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

function looksLikeTermAnchor(text: string): boolean {
  return /с[о]?\s+(?:даты|дня|момента)\s+(?:заключени|подписани|передачи|получени|поставк|отгрузк)/iu.test(
    text,
  );
}

function looksLikeWorksPeriod(text: string): boolean {
  return /выполнени|выполнить|оказани|оказать|работ|услуг|монтаж|сборк|пусконалад|ввод\s+в\s+эксплуатац/iu.test(
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
  return /до\s+\d/u.test(quote) || /не\s+более/u.test(quote) || /не\s+превышающ/u.test(quote);
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
