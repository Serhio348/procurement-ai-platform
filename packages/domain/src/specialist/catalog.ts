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
import { inboxTopic, inboxTopicLabel } from "./inbox-action.js";
import { mergeProfileIds } from "./profile-cases.js";

export class SpecialistCatalog {
  readonly #byChangeId = new Map<string, InboxFixtureItemValue>();
  readonly #order: InboxFixtureItemValue[] = [];
  readonly #cases = new Map<string, SpecialistProcurementCardValue>();
  readonly #dismissed = new Set<string>();
  readonly #pruned = new Set<string>();

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
    // A case purged in this process must not come back through a later upsert:
    // persist would write it again and the specialist would find it in trash
    // after a reload. A genuinely re-found procedure arrives with a new id.
    if (this.#pruned.has(card.id)) return;
    const previous = this.#cases.get(card.id);
    const parsed = SpecialistProcurementCard.parse(card);
    this.#cases.set(
      card.id,
      SpecialistProcurementCard.parse({
        ...parsed,
        profileIds: mergeProfileIds(previous?.profileIds, parsed.profileIds),
      }),
    );
  }

  dropCase(id: string): void {
    this.#cases.delete(id);
    this.#pruned.add(id);
    this.dismissByProcurementId(id);
  }

  inboxItem(id: string): InboxFixtureItemValue | undefined {
    if (this.#dismissed.has(id)) return undefined;
    return this.#byChangeId.get(id);
  }

  dismiss(id: string): boolean {
    if (this.#byChangeId.get(id) === undefined) return false;
    this.#dismissed.add(id);
    return true;
  }

  dismissMany(ids: readonly string[]): void {
    for (const id of ids) {
      this.dismiss(id);
    }
  }

  dismissByProcurementId(procurementId: string): void {
    for (const item of this.#order) {
      if (item.change.procurementId === procurementId) {
        this.#dismissed.add(item.change.id);
      }
    }
  }

  dismissedIds(): string[] {
    return [...this.#dismissed];
  }

  /** Every recorded inbox row, dismissed ones included, in arrival order. For persistence. */
  inboxItems(): InboxFixtureItemValue[] {
    return [...this.#order];
  }

  /**
   * Drops undecided live cases a search has not returned for `maxAgeMs`.
   * Cases from a fixture inbox are left alone; a legacy live case without
   * lastSeenAt counts as stale. Inbox rows of pruned cases are dismissed so the
   * inbox cannot point at a card that no longer exists.
   */
  prune(input: { now: string; maxAgeMs: number; keepSourceIds: ReadonlySet<string> }): string[] {
    const cutoff = Date.parse(input.now) - input.maxAgeMs;
    const removed: string[] = [];
    for (const card of this.#cases.values()) {
      if (!card.live || card.triage !== undefined) continue;
      if (input.keepSourceIds.has(card.sourceProcurementId)) continue;
      const seen = card.lastSeenAt === undefined ? Number.NaN : Date.parse(card.lastSeenAt);
      if (Number.isFinite(seen) && seen >= cutoff) continue;
      removed.push(card.id);
    }
    for (const id of removed) {
      this.#cases.delete(id);
      this.#pruned.add(id);
      this.dismissByProcurementId(id);
    }
    return removed;
  }

  urgentInbox(): SpecialistInboxEntry[] {
    return this.#order
      .filter((item) => item.change.urgent && !this.#dismissed.has(item.change.id))
      .map(toInboxEntry);
  }

  /**
   * Cases the specialist actually stored. Inbox stubs are listing-only:
   * persisting them as workspace_procurements recreates other cabinets'
   * rejects after a restart.
   */
  storedCases(): SpecialistProcurementCard[] {
    return [...this.#cases.values()];
  }

  procurements(): SpecialistProcurementCard[] {
    const latest = new Map<string, InboxFixtureItemValue>();
    for (const item of this.#order) {
      latest.set(item.change.procurementId, item);
    }
    const fromChanges = [...latest.values()].map(toProcurementCard);
    const rest = fromChanges.filter(
      (item) => !this.#cases.has(item.id) && !this.#pruned.has(item.id),
    );
    return [...this.storedCases(), ...rest];
  }

  procurement(id: string): SpecialistProcurementCard | undefined {
    return this.procurements().find((item) => item.id === id);
  }
}

function toInboxEntry(item: InboxFixtureItemValue): SpecialistInboxEntry {
  const presented = presentChange(item);
  const topic = inboxTopic(item.change.kind);
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
    kind: item.change.kind,
    topic,
    topicLabel: inboxTopicLabel(topic),
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
