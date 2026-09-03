import {
  InboxFixture,
  InboxFixtureItem,
  SpecialistInboxEntry,
  SpecialistProcurementCard,
  type InboxFixtureItem as InboxFixtureItemValue,
  type ProcedureStatus,
} from "@procurement/contracts";
import { compileChangeAlert } from "../notification/message.js";

export class SpecialistCatalog {
  readonly #byChangeId = new Map<string, InboxFixtureItemValue>();
  readonly #order: InboxFixtureItemValue[] = [];

  static parse(raw: unknown): SpecialistCatalog {
    const fixture = InboxFixture.parse(raw);
    const catalog = new SpecialistCatalog();
    for (const item of fixture.items) {
      catalog.record(item);
    }
    return catalog;
  }

  record(raw: unknown): { duplicate: boolean; item: InboxFixtureItemValue } {
    const item = InboxFixtureItem.parse(raw);
    const existing = this.#byChangeId.get(item.change.id);
    if (existing !== undefined) {
      return { duplicate: true, item: existing };
    }
    this.#byChangeId.set(item.change.id, item);
    this.#order.push(item);
    return { duplicate: false, item };
  }

  urgentInbox(): SpecialistInboxEntry[] {
    return this.#order.filter((item) => item.change.urgent).map(toInboxEntry);
  }

  procurements(): SpecialistProcurementCard[] {
    const latest = new Map<string, InboxFixtureItemValue>();
    for (const item of this.#order) {
      latest.set(item.change.procurementId, item);
    }
    return [...latest.values()].map(toProcurementCard);
  }

  procurement(id: string): SpecialistProcurementCard | undefined {
    return this.procurements().find((item) => item.id === id);
  }
}

function toInboxEntry(item: InboxFixtureItemValue): SpecialistInboxEntry {
  const presented = presentChange(item);
  return SpecialistInboxEntry.parse({
    id: item.change.id,
    procurementId: item.change.procurementId,
    title: item.procurement.title,
    status: item.procurement.status,
    statusLabel: statusLabel(item.procurement.status),
    url: item.procurement.url,
    sourceProcurementId: item.procurement.sourceProcurementId,
    summary: presented.summary,
    detail: presented.detail,
    detectedOn: item.change.detectedAt.slice(0, 10),
    urgent: true,
  });
}

function toProcurementCard(item: InboxFixtureItemValue): SpecialistProcurementCard {
  const presented = presentChange(item);
  return SpecialistProcurementCard.parse({
    id: item.change.procurementId,
    title: item.procurement.title,
    status: item.procurement.status,
    statusLabel: statusLabel(item.procurement.status),
    url: item.procurement.url,
    sourceProcurementId: item.procurement.sourceProcurementId,
    latestChange: {
      summary: presented.summary,
      detail: presented.detail,
      detectedOn: item.change.detectedAt.slice(0, 10),
      urgent: item.change.urgent,
    },
  });
}

function presentChange(item: InboxFixtureItemValue): { summary: string; detail: string } {
  const compiled = compileChangeAlert([item.change], {
    title: item.procurement.title,
    sourceProcurementId: item.procurement.sourceProcurementId,
    url: item.procurement.url,
  });
  const summaryCompiled = compileChangeAlert([item.change]);
  return {
    summary: firstLine(summaryCompiled?.body ?? ""),
    detail: compiled?.body ?? "",
  };
}

function firstLine(body: string): string {
  const line = body.split("\n").find((item) => item.length > 0);
  return line ?? "Изменение закупки";
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
