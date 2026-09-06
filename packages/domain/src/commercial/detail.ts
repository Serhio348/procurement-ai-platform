import type { CommercialClaim, PaymentKind } from "@procurement/contracts";

export function paymentKindLabel(kind: PaymentKind): string {
  switch (kind) {
    case "advance":
      return "Оплата: аванс.";
    case "on_delivery":
      return "Оплата: по факту поставки.";
    case "deferred":
      return "Оплата: отсрочка.";
    case "staged":
      return "Оплата: поэтапно.";
    case "letter_of_credit":
      return "Оплата: аккредитив.";
    case "unknown":
      return "Вид оплаты не разобран.";
  }
}

export function formatCommercialDetailLines(
  claims: readonly CommercialClaim[],
  notes: readonly string[] = [],
): string[] {
  const lines: string[] = [];
  const advance = uniqueNumbers(claims, "commercial.advance_percent");
  const cap = uniqueNumbers(claims, "commercial.advance_percent_cap");
  const paymentDays = uniqueNumbers(claims, "commercial.payment_deadline_days");
  const deliveryDays = uniqueNumbers(claims, "commercial.delivery_period_days");
  const warranty = uniqueNumbers(claims, "commercial.warranty_months");
  const kinds = uniqueStrings(claims, "commercial.payment_kind");

  if (advance.length === 1) {
    lines.push(advance[0] === 0 ? "Аванс: нет." : `Аванс: ${formatPercent(advance[0]!)}%.`);
  } else if (cap.length === 1) {
    lines.push(`Аванс: до ${formatPercent(cap[0]!)}%.`);
  }
  const kind = kinds[0];
  if (kinds.length === 1 && kind !== undefined && isPaymentKind(kind)) {
    lines.push(paymentKindLabel(kind));
  }
  if (paymentDays.length === 1) {
    lines.push(`Срок оплаты: ${formatDayCount(paymentDays[0]!, unitForNumber(claims, "commercial.payment_deadline_days", paymentDays[0]!))}.`);
  }
  if (deliveryDays.length === 1) {
    lines.push(`Срок поставки: ${formatDayCount(deliveryDays[0]!, unitForNumber(claims, "commercial.delivery_period_days", deliveryDays[0]!))}.`);
  }
  if (warranty.length === 1) {
    lines.push(`Гарантия: ${String(warranty[0])} мес.`);
  }
  for (const note of notes) {
    if (lines.some((line) => lineCoversNote(line, note))) continue;
    lines.push(note);
  }
  return lines;
}

function formatPercent(value: number): string {
  return String(value).replace(".", ",");
}

export function formatDayCount(value: number, unit: string | undefined): string {
  if (unit === "banking_days") return `${String(value)} банковских дн.`;
  if (unit === "calendar_days") return `${String(value)} календарных дн.`;
  if (unit === "working_days") return `${String(value)} рабочих дн.`;
  return `${String(value)} дн.`;
}

function unitForNumber(claims: readonly CommercialClaim[], key: string, value: number): string | undefined {
  return claims.find((item) => item.key === key && item.value === value)?.unit;
}

function uniqueNumbers(claims: readonly CommercialClaim[], key: string): number[] {
  const values: number[] = [];
  for (const item of claims) {
    if (item.key !== key || typeof item.value !== "number" || values.includes(item.value)) continue;
    values.push(item.value);
  }
  return values;
}

function uniqueStrings(claims: readonly CommercialClaim[], key: string): string[] {
  const values: string[] = [];
  for (const item of claims) {
    if (item.key !== key || typeof item.value !== "string" || values.includes(item.value)) continue;
    values.push(item.value);
  }
  return values;
}

function isPaymentKind(value: string): value is PaymentKind {
  return (
    value === "advance" ||
    value === "on_delivery" ||
    value === "deferred" ||
    value === "staged" ||
    value === "letter_of_credit" ||
    value === "unknown"
  );
}

function lineCoversNote(line: string, note: string): boolean {
  const folded = note.toLowerCase();
  const hasDuration = /в\s+течени|нескольк|\d+\s*дн/u.test(folded);
  if (line.startsWith("Оплата:") && /по факту поставк|условия оплаты/u.test(folded) && !hasDuration) {
    return true;
  }
  if (line.startsWith("Срок оплаты:") && /срок оплаты|в\s+течени/u.test(folded) && /\d+.*дн/u.test(line)) {
    return true;
  }
  if (line.startsWith("Срок поставки:") && folded.includes("срок поставки") && /\d+.*дн/u.test(line)) {
    return true;
  }
  return false;
}
