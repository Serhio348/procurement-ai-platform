import {
  SpecialistProcurementCard,
  type PlatformInstant,
  type ProcedureCard,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
} from "@procurement/contracts";
import { statusLabel } from "./case.js";
import { cardSnapshot } from "./watch.js";

export interface NamedSourceField {
  label: string;
  value: string;
}

/**
 * Labels as printed on goszakupki.by, in the order the specialist sees on the
 * source page. The adapter stores them in rawFields; the console must not
 * invent a parallel vocabulary.
 */
export const PROCEDURE_DETAIL_FIELD_ORDER = [
  "Дата размещения приглашения",
  "Дата размещения заявки на покупку",
  "Дата окончания приема предложений",
  "Дата окончания приема сведений",
  "Дата окончания приема документов и (или) сведений",
  "Дата и время окончания приема запросов о разъяснении документации о закупке",
  "Дата и время проведения электронного аукциона",
  "Общая ориентировочная стоимость закупки",
  "Общая предельная стоимость закупки",
  "Размер платы оператору за обеспечение проведения процедуры закупки",
  "Требования к участникам процедуры закупки, включая при необходимости перечень документов и (или) сведений, представляемых участниками процедуры закупки для подтверждения их соответствия установленным требованиям",
  "Требования к участникам, включая перечень документов и (или) сведений для их проверки",
  "Иные сведения",
] as const;

/** Copies the live platform card onto the specialist case and refreshes listing fields. */
export function applySourceCard(
  card: SpecialistProcurementCardValue,
  source: ProcedureCard,
  now: string,
): SpecialistProcurementCardValue {
  const buyer = source.buyer?.name ?? card.buyerName;
  const amount = procedureAmountLabel(source) ?? card.amountLabel;
  const printedStatus = source.sourceStatus?.trim();
  // Lot badges are often empty on marketing/request pages. Do not wipe the
  // listing status ("Рассмотрение предложений") with a blank "неизвестен".
  const nextStatus = source.status !== "unknown" ? source.status : card.status;
  const nextStatusLabel =
    printedStatus !== undefined && printedStatus.length > 0
      ? printedStatus
      : source.status !== "unknown"
        ? statusLabel(source.status)
        : card.statusLabel;
  return SpecialistProcurementCard.parse({
    ...card,
    title: source.title,
    status: nextStatus,
    statusLabel: nextStatusLabel,
    ...(buyer === undefined ? {} : { buyerName: buyer }),
    ...(amount === undefined ? {} : { amountLabel: amount }),
    sourceCard: source,
    watchSnapshot: cardSnapshot(source, now),
  });
}

export function procedureBuyerFields(card: ProcedureCard): NamedSourceField[] {
  const buyer = card.buyer;
  if (buyer === undefined) return [];
  const rows: NamedSourceField[] = [{ label: "Наименование", value: buyer.name }];
  if (buyer.address !== undefined) {
    rows.push({ label: "Место нахождения", value: buyer.address });
  }
  if (buyer.registrationNumber !== undefined) {
    rows.push({ label: "УНП", value: buyer.registrationNumber });
  }
  if (buyer.contact !== undefined) {
    rows.push({ label: "Контактные номера", value: buyer.contact });
  }
  return rows;
}

/**
 * Rows for the "основная информация" block. Prefers the wording from the page
 * (rawFields) so a specialist sees the same table as on goszakupki.by. Typed
 * dates and the amount are a fallback when the adapter only filled those.
 */
export function procedureDetailFields(card: ProcedureCard): NamedSourceField[] {
  const rows: NamedSourceField[] = [];
  const shown = new Set<string>();
  for (const label of PROCEDURE_DETAIL_FIELD_ORDER) {
    const value = card.rawFields[label];
    if (value === undefined || value.length === 0) continue;
    rows.push({ label, value });
    shown.add(label);
  }
  appendTypedFallback(rows, shown, "Дата размещения приглашения", printInstant(card.publishedAt));
  appendTypedFallback(
    rows,
    shown,
    "Дата окончания приема предложений",
    printInstant(card.bidsDeadline),
  );
  appendTypedFallback(
    rows,
    shown,
    "Дата и время проведения электронного аукциона",
    printInstant(card.auctionAt),
  );
  if (!shown.has("Общая предельная стоимость закупки") && !shown.has("Общая ориентировочная стоимость закупки")) {
    const amount = card.amount;
    if (amount !== undefined) {
      rows.push({
        label:
          amount.kind === "indicative"
            ? "Общая ориентировочная стоимость закупки"
            : "Общая предельная стоимость закупки",
        value: amount.raw,
      });
    }
  }
  return rows;
}

export function procedurePublicId(card: ProcedureCard): string | undefined {
  return (
    card.externalIds.find((item) => item.kind === "auc")?.value ??
    card.externalIds.find((item) => item.kind === "gias")?.value
  );
}

export function procedureAmountLabel(card: ProcedureCard): string | undefined {
  const amount = card.amount ?? card.startingPrice;
  if (amount === undefined) return undefined;
  if ("raw" in amount && typeof amount.raw === "string" && amount.raw.length > 0) return amount.raw;
  if ("amount" in amount && typeof amount.amount === "number") {
    const currency = "currency" in amount && amount.currency !== undefined ? amount.currency : "";
    return `${String(amount.amount)} ${currency}`.trim();
  }
  return undefined;
}

export function printInstant(value: PlatformInstant | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.precision === "date") return printIsoDate(value.date);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value.at);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return value.at;
  return `${printIsoDate(match[1])} ${match[2]}:${match[3]}`;
}

function printIsoDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  if (year === undefined || month === undefined || day === undefined) return iso;
  return `${day}.${month}.${year}`;
}

function appendTypedFallback(
  rows: NamedSourceField[],
  shown: Set<string>,
  label: string,
  value: string | undefined,
): void {
  if (value === undefined || shown.has(label)) return;
  rows.push({ label, value });
  shown.add(label);
}
