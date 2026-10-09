import { TELEGRAM_MAX_TEXT_LENGTH, type ChangeEvent, type ChangeKind } from "@procurement/contracts";

export interface ChangeAlertCard {
  title?: string;
  sourceProcurementId?: string;
  url?: string;
}

export interface CompiledChangeAlert {
  title: string;
  body: string;
}

/**
 * Renders already detected ChangeEvents. Previous/current strings are copied
 * as-is; no price or advance figure is invented here.
 */
export function compileChangeAlert(
  changes: readonly ChangeEvent[],
  card: ChangeAlertCard = {},
): CompiledChangeAlert | undefined {
  if (changes.length === 0) return undefined;

  const title =
    card.title !== undefined && card.title.length > 0
      ? card.title
      : "Изменение закупки";
  const lines: string[] = [];
  if (card.sourceProcurementId !== undefined && card.sourceProcurementId.length > 0) {
    lines.push(`Номер: ${card.sourceProcurementId}.`);
  }
  if (card.url !== undefined && card.url.length > 0) {
    lines.push(`Ссылка: ${card.url}.`);
  }
  for (const change of changes) {
    lines.push(changeLine(change));
  }
  return { title, body: lines.join("\n") };
}

export function compileTelegramText(title: string, body: string): string {
  return truncateTelegramText(`${title}\n\n${body}`);
}

export function truncateTelegramText(
  text: string,
  maxLength: number = TELEGRAM_MAX_TEXT_LENGTH,
): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 1)}…`;
}

function changeLine(change: ChangeEvent): string {
  const urgentMark = change.urgent ? " (срочно)" : "";
  if (change.field === "chronology" && change.current !== null && change.current.length > 0) {
    return `Событие${urgentMark}: ${change.current}.`;
  }
  const from = change.previous ?? "—";
  const to = change.current ?? "—";
  return `${changeKindLabel(change.kind)}${urgentMark}: ${from} → ${to}.`;
}

function changeKindLabel(kind: ChangeKind): string {
  switch (kind) {
    case "procedure_found":
      return "Новая закупка";
    case "procedure_candidate":
      return "На проверку";
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
