import {
  InboxFixtureItem,
  ProcedureStatus,
  SpecialistProcurementCard,
  type ChangeEvent,
  type ChangeKind,
  type InboxFixtureItem as InboxFixtureItemValue,
  type SpecialistInboxTopic as SpecialistInboxTopicValue,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
} from "@procurement/contracts";
import { statusLabel, uuidFromHex } from "./case.js";

export function inboxTopic(kind: ChangeKind): SpecialistInboxTopicValue {
  if (kind === "procedure_found") return "new_found";
  if (kind === "document_added" || kind === "document_updated" || kind === "document_removed") {
    return "documents";
  }
  return "card_update";
}

export function inboxTopicLabel(topic: SpecialistInboxTopicValue): string {
  switch (topic) {
    case "new_found":
      return "Новая закупка";
    case "documents":
      return "Документы";
    case "card_update":
      return "Карточка";
  }
}

export function inboxItemFromFoundCard(
  card: SpecialistProcurementCardValue,
  detectedAt: string,
): InboxFixtureItemValue {
  return InboxFixtureItem.parse({
    procurement: {
      title: card.title,
      status: card.status,
      url: card.url,
      sourceProcurementId: card.sourceProcurementId,
    },
    change: {
      id: uuidFromHex(`inbox-found:${card.id}`),
      procurementId: card.id,
      kind: "procedure_found",
      previous: null,
      current: card.title,
      detectedAt,
      urgent: true,
    },
  });
}

/**
 * Applies the already detected change onto the case. Does not fetch the
 * source again and does not invent prices.
 */
export function applyInboxChangeToCard(
  card: SpecialistProcurementCardValue,
  change: ChangeEvent,
): SpecialistProcurementCardValue {
  const next: SpecialistProcurementCardValue = { ...card };
  if (change.kind === "status_changed" && change.current !== null) {
    const parsed = ProcedureStatus.safeParse(change.current);
    if (parsed.success) {
      next.status = parsed.data;
      next.statusLabel = statusLabel(parsed.data);
    } else {
      next.statusLabel = change.current;
    }
  }
  if (change.kind === "price_changed" && change.current !== null) {
    next.amountLabel = change.current;
  }
  return SpecialistProcurementCard.parse(next);
}

export function inboxDocumentLinks(
  card: SpecialistProcurementCardValue | undefined,
): { name: string; url: string }[] {
  if (card === undefined) return [];
  return card.documents
    .map((document) => {
      const url = document.downloadUrl ?? document.sourceUrl;
      return { name: document.name, url };
    })
    .filter((document) => document.url.length > 0);
}

