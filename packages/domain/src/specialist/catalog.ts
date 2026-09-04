import {
  InboxFixture,
  InboxFixtureItem,
  SpecialistInboxEntry,
  SpecialistProcurementCard,
  type InboxFixtureItem as InboxFixtureItemValue,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
} from "@procurement/contracts";
import { compileChangeAlert } from "../notification/message.js";
import { statusLabel } from "./case.js";

export class SpecialistCatalog {
  readonly #byChangeId = new Map<string, InboxFixtureItemValue>();
  readonly #order: InboxFixtureItemValue[] = [];
  readonly #cases = new Map<string, SpecialistProcurementCardValue>();

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

  upsertCase(card: SpecialistProcurementCardValue): void {
    this.#cases.set(card.id, SpecialistProcurementCard.parse(card));
  }

  urgentInbox(): SpecialistInboxEntry[] {
    return this.#order.filter((item) => item.change.urgent).map(toInboxEntry);
  }

  procurements(): SpecialistProcurementCard[] {
    const latest = new Map<string, InboxFixtureItemValue>();
    for (const item of this.#order) {
      latest.set(item.change.procurementId, item);
    }
    const fromChanges = [...latest.values()].map(toProcurementCard);
    const rest = fromChanges.filter((item) => !this.#cases.has(item.id));
    return [...this.#cases.values(), ...rest];
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
