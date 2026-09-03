import { CommercialTerms, type CommercialTerms as CommercialTermsValue, type Fact } from "@procurement/contracts";

export interface CommercialTermsAssembly {
  terms: CommercialTermsValue;
  conflicts: readonly CommercialConflict[];
}

export interface CommercialConflict {
  key: string;
  question: string;
}

/**
 * Turns proven facts into CommercialTerms. Conflicting values for one key are
 * not resolved by recency: the specialist must choose.
 */
export function assembleCommercialTerms(facts: readonly Fact[]): CommercialTermsAssembly {
  const conflicts: CommercialConflict[] = [];
  const terms = CommercialTerms.parse({
    notes: [],
    ...optionalField("advancePercent", sourcedNumber(facts, "commercial.advance_percent", 0, 100, conflicts)),
    ...optionalField(
      "finalPaymentPercent",
      sourcedNumber(facts, "commercial.final_payment_percent", 0, 100, conflicts),
    ),
    ...optionalField(
      "paymentDeadlineDays",
      sourcedInteger(facts, "commercial.payment_deadline_days", conflicts),
    ),
    ...optionalField(
      "deliveryPeriodDays",
      sourcedInteger(facts, "commercial.delivery_period_days", conflicts),
    ),
    ...optionalField("warrantyMonths", sourcedInteger(facts, "commercial.warranty_months", conflicts)),
    ...optionalField("paymentKind", sourcedPaymentKind(facts, conflicts)),
  });
  return { terms, conflicts };
}

function optionalField(field: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [field]: value };
}

function sourcedNumber(
  facts: readonly Fact[],
  key: string,
  min: number,
  max: number,
  conflicts: CommercialConflict[],
) {
  const group = facts.filter((fact) => fact.key === key);
  if (group.length === 0) return undefined;
  const values = unique(group.map((fact) => fact.value));
  if (values.length > 1) {
    conflicts.push({
      key,
      question: `В документах разные значения для ${key}. Какое считать действующим?`,
    });
    return undefined;
  }
  const value = values[0];
  if (typeof value !== "number" || value < min || value > max) {
    conflicts.push({
      key,
      question: `Не удалось прочитать ${key} как число в допустимом диапазоне.`,
    });
    return undefined;
  }
  return {
    value,
    factIds: group.map((fact) => fact.id),
    confidence: Math.min(...group.map((fact) => fact.confidence)),
  };
}

function sourcedInteger(
  facts: readonly Fact[],
  key: string,
  conflicts: CommercialConflict[],
) {
  const sourced = sourcedNumber(facts, key, 0, Number.MAX_SAFE_INTEGER, conflicts);
  if (sourced === undefined) return undefined;
  if (!Number.isInteger(sourced.value)) {
    conflicts.push({
      key,
      question: `Не удалось прочитать ${key} как целое число дней или месяцев.`,
    });
    return undefined;
  }
  return sourced;
}

function sourcedPaymentKind(facts: readonly Fact[], conflicts: CommercialConflict[]) {
  const group = facts.filter((fact) => fact.key === "commercial.payment_kind");
  if (group.length === 0) return undefined;
  const values = unique(group.map((fact) => fact.value));
  if (values.length > 1) {
    conflicts.push({
      key: "commercial.payment_kind",
      question: "В документах указаны разные виды оплаты. Какой считать действующим?",
    });
    return undefined;
  }
  const value = values[0];
  if (
    value !== "advance" &&
    value !== "on_delivery" &&
    value !== "deferred" &&
    value !== "staged" &&
    value !== "letter_of_credit" &&
    value !== "unknown"
  ) {
    conflicts.push({
      key: "commercial.payment_kind",
      question: "Вид оплаты не распознан. Укажите его по документу.",
    });
    return undefined;
  }
  return {
    value,
    factIds: group.map((fact) => fact.id),
    confidence: Math.min(...group.map((fact) => fact.confidence)),
  };
}

function unique(values: readonly Fact["value"][]): Fact["value"][] {
  const seen = new Set<string>();
  const result: Fact["value"][] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}
