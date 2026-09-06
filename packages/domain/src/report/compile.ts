import type {
  ChangeEvent,
  ChangeKind,
  CommercialTerms,
  Fact,
  PaymentKind,
  ProcedureKind,
  ProcedureStatus,
  ScoreSnapshot,
  ScoreVerdict,
} from "@procurement/contracts";
import { formatDayCount } from "../commercial/detail.js";

export interface ReportCard {
  title: string;
  url: string;
  status: ProcedureStatus;
  kind: ProcedureKind;
  sourceProcurementId: string;
}

export interface ReportCompileInput {
  card: ReportCard;
  profileName?: string;
  terms?: CommercialTerms;
  facts?: readonly Fact[];
  changes?: readonly ChangeEvent[];
  score?: Pick<ScoreSnapshot, "finalScore" | "verdict" | "explanation" | "confidence">;
}

export interface CompiledReport {
  title: string;
  markdown: string;
  sections: Array<{ heading: string; body: string }>;
  missing: string[];
}

/**
 * Turns already proven case slices into a specialist-readable report.
 * Missing fields are listed; numbers are never invented.
 */
export function compileProcurementReport(input: ReportCompileInput): CompiledReport {
  const missing: string[] = [];
  const card = compileCard(input.card, input.profileName);
  const commercial = compileCommercial(input.terms, input.facts ?? [], missing);
  const changes = compileChanges(input.changes ?? []);
  const score = compileScore(input.score, missing);
  const sections = [card, commercial, changes, score];
  const markdown = [`# ${input.card.title}`, ...sections.map((section) => `## ${section.heading}\n\n${section.body}`)].join(
    "\n\n",
  );
  return {
    title: input.card.title,
    markdown,
    sections,
    missing,
  };
}

function compileCard(
  card: ReportCard,
  profileName: string | undefined,
): { heading: string; body: string } {
  const lines = [
    `Номер: ${card.sourceProcurementId}.`,
    `Ссылка: ${card.url}.`,
    `Вид: ${kindLabel(card.kind)}.`,
    `Статус: ${statusLabel(card.status)}.`,
  ];
  if (profileName !== undefined && profileName.length > 0) {
    lines.push(`Профиль: ${profileName}.`);
  }
  return { heading: "Карточка", body: lines.join("\n") };
}

function compileCommercial(
  terms: CommercialTerms | undefined,
  facts: readonly Fact[],
  missing: string[],
): { heading: string; body: string } {
  if (terms === undefined) {
    missing.push("Коммерческие условия не извлечены.");
    return {
      heading: "Коммерческие условия",
      body: "Коммерческие условия ещё не извлечены.",
    };
  }
  const lines: string[] = [];
  if (terms.advancePercent !== undefined) {
    lines.push(
      terms.advancePercent.value === 0
        ? "Аванс: нет."
        : `Аванс: ${String(terms.advancePercent.value).replace(".", ",")}%.`,
    );
  } else if (terms.advancePercentCap !== undefined) {
    lines.push(`Аванс: до ${String(terms.advancePercentCap.value).replace(".", ",")}%.`);
  } else if (terms.notes.length === 0) {
    missing.push("Доля аванса не подтверждена.");
  }
  if (terms.paymentDeadlineDays !== undefined) {
    lines.push(
      `Срок оплаты: ${formatDayCount(terms.paymentDeadlineDays.value, unitForFact(facts, "commercial.payment_deadline_days"))}.`,
    );
  }
  if (terms.deliveryPeriodDays !== undefined) {
    lines.push(
      `Срок поставки: ${formatDayCount(terms.deliveryPeriodDays.value, unitForFact(facts, "commercial.delivery_period_days"))}.`,
    );
  }
  if (terms.warrantyMonths !== undefined) {
    lines.push(`Гарантия: ${String(terms.warrantyMonths.value)} мес.`);
  }
  if (terms.paymentKind !== undefined) {
    lines.push(`Вид оплаты: ${paymentKindLabel(terms.paymentKind.value)}.`);
  }
  if (terms.notes.length > 0) {
    lines.push(...terms.notes);
  }
  if (lines.length === 0) {
    missing.push("Подтверждённых коммерческих полей нет.");
    return {
      heading: "Коммерческие условия",
      body: "Подтверждённых коммерческих полей нет.",
    };
  }
  return { heading: "Коммерческие условия", body: lines.join("\n") };
}

function compileChanges(changes: readonly ChangeEvent[]): { heading: string; body: string } {
  if (changes.length === 0) {
    return {
      heading: "Изменения",
      body: "Новых изменений не зафиксировано.",
    };
  }
  const lines = changes.map((change) => {
    const from = change.previous ?? "—";
    const to = change.current ?? "—";
    return `${changeKindLabel(change.kind)}: ${from} → ${to}.`;
  });
  return { heading: "Изменения", body: lines.join("\n") };
}

function compileScore(
  score: ReportCompileInput["score"],
  missing: string[],
): { heading: string; body: string } {
  if (score === undefined) {
    missing.push("Итоговая оценка ещё не рассчитана.");
    return {
      heading: "Оценка",
      body: "Итоговая оценка ещё не рассчитана кодом. Модель её не ставит.",
    };
  }
  const lines = [
    `Итоговая оценка: ${String(score.finalScore)}.`,
    `Вердикт: ${verdictLabel(score.verdict)}.`,
    `Уверенность исходных фактов: ${String(score.confidence)}.`,
    ...score.explanation,
  ];
  return { heading: "Оценка", body: lines.join("\n") };
}

function statusLabel(status: ProcedureStatus): string {
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

function unitForFact(facts: readonly Fact[], key: string): string | undefined {
  return facts.find((item) => item.key === key)?.unit;
}

function paymentKindLabel(kind: PaymentKind): string {
  switch (kind) {
    case "advance":
      return "аванс";
    case "on_delivery":
      return "по факту поставки";
    case "deferred":
      return "отсрочка";
    case "staged":
      return "по этапам";
    case "letter_of_credit":
      return "аккредитив";
    case "unknown":
      return "не определён";
  }
}

function changeKindLabel(kind: ChangeKind): string {
  switch (kind) {
    case "status_changed":
      return "Статус";
    case "price_changed":
      return "Цена";
    case "deadline_changed":
      return "Срок подачи";
    case "document_added":
      return "Добавлен документ";
    case "document_updated":
      return "Обновлён документ";
    case "document_removed":
      return "Удалён документ";
    case "lot_changed":
      return "Лот";
    case "clarification_added":
      return "Разъяснение";
    case "clarification_answered":
      return "Ответ на разъяснение";
    case "other":
      return "Прочее";
  }
}

function verdictLabel(verdict: ScoreVerdict): string {
  switch (verdict) {
    case "accept":
      return "принять к работе";
    case "review":
      return "нужна проверка";
    case "reject":
      return "отклонить";
    case "needs_human":
      return "решает специалист";
  }
}
