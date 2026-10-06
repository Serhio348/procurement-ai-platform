import {
  InboxFixture,
  InboxFixtureItem,
  SpecialistInboxEntry,
  SpecialistProcurementCard,
  type InboxFixtureItem as InboxFixtureItemValue,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
} from "@procurement/contracts";
import { compileChangeAlert } from "../notification/message.js";
import { isPrunableUndecidedCase, statusLabel } from "./case.js";
import { inboxTopic, inboxTopicLabel } from "./inbox-action.js";
import { mergeProfileIds, releaseProfileFromCard } from "./profile-cases.js";

export class SpecialistCatalog {
  readonly #byChangeId = new Map<string, InboxFixtureItemValue>();
  readonly #order: InboxFixtureItemValue[] = [];
  readonly #cases = new Map<string, SpecialistProcurementCardValue>();
  readonly #dismissed = new Set<string>();
  readonly #pruned = new Set<string>();
  /** Profiles deleted in this process. A later upsert must not reattach them. */
  readonly #goneProfiles = new Set<string>();

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
    const profileIds = mergeProfileIds(previous?.profileIds, parsed.profileIds).filter(
      (id) => !this.#goneProfiles.has(id),
    );
    const assessments = Object.fromEntries(
      Object.entries(parsed.assessments).filter(([id]) => !this.#goneProfiles.has(id)),
    );
    // An in-flight search of a deleted profile still holds the old card. Do not
    // recreate an undecided case that belonged only to that profile.
    const onlyGone =
      parsed.profileIds.some((id) => this.#goneProfiles.has(id)) &&
      profileIds.length === 0 &&
      parsed.triage === undefined &&
      parsed.archived !== true;
    if (onlyGone && previous === undefined) return;
    this.#cases.set(
      card.id,
      SpecialistProcurementCard.parse({
        ...parsed,
        profileIds,
        assessments,
      }),
    );
  }

  /**
   * Detach one profile from every stored card. Undecided cards that no other
   * profile holds are forgotten (the same source may be found again). A
   * specialist decision stays, without that profile's verdict.
   */
  releaseProfile(profileId: string, hasDecision: (sourceProcurementId: string) => boolean): void {
    this.#goneProfiles.add(profileId);
    for (const card of [...this.#cases.values()]) {
      const released = releaseProfileFromCard(
        card,
        profileId,
        hasDecision(card.sourceProcurementId),
      );
      if (released.action === "drop") {
        this.#cases.delete(card.id);
        this.#forgetInbox(card.id);
        continue;
      }
      if (released.action === "keep") this.#cases.set(card.id, released.card);
    }
  }

  dropCase(id: string): void {
    this.#cases.delete(id);
    this.#pruned.add(id);
    this.dismissByProcurementId(id);
  }

  /**
   * Drops a review miss so the list and inbox no longer show it. The same
   * source id may come back on a later search (new phrases); unlike dropCase
   * this does not permanently block the stable listing id.
   */
  forgetCase(id: string): void {
    this.#cases.delete(id);
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

  /** A later search found the same review hit: the row belongs in the inbox again. */
  undismiss(id: string): void {
    this.#dismissed.delete(id);
  }

  dismissMany(ids: readonly string[]): void {
    for (const id of ids) {
      this.dismiss(id);
    }
  }

  /** Removes inbox rows of a dropped case so the next persist cannot write them back. */
  #forgetInbox(procurementId: string): void {
    for (let index = this.#order.length - 1; index >= 0; index -= 1) {
      const item = this.#order[index];
      if (item === undefined || item.change.procurementId !== procurementId) continue;
      this.#order.splice(index, 1);
      this.#byChangeId.delete(item.change.id);
      this.#dismissed.delete(item.change.id);
    }
  }

  dismissByProcurementId(procurementId: string): void {
    for (const item of this.#order) {
      if (item.change.procurementId === procurementId) {
        this.#dismissed.add(item.change.id);
      }
    }
  }

  /**
   * All pending document-change rows of the case. «Скачать документы»
   * ingests the whole listed pack, so sibling document rows describe the
   * same resolved state — keeping them would report stale news. Rows for
   * other topics (status, price) stay.
   */
  dismissDocumentChanges(procurementId: string): void {
    for (const item of this.#order) {
      if (
        item.change.procurementId === procurementId &&
        inboxTopic(item.change.kind) === "documents"
      ) {
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
   * Drops unused search hits. Watch / participate / reject stay, as do ids
   * from the current search queue. Inbox rows of pruned cases are dismissed.
   */
  prune(input: {
    now: string;
    maxAgeMs: number;
    keepSourceIds: ReadonlySet<string>;
    keepCaseIds?: ReadonlySet<string>;
  }): string[] {
    const cutoff = Date.parse(input.now) - input.maxAgeMs;
    const removed: string[] = [];
    for (const card of this.#cases.values()) {
      if (!isPrunableUndecidedCase(card, cutoff, input.keepSourceIds, input.keepCaseIds)) {
        continue;
      }
      removed.push(card.id);
    }
    for (const id of removed) {
      this.#cases.delete(id);
      this.dismissByProcurementId(id);
    }
    return removed;
  }

  urgentInbox(): SpecialistInboxEntry[] {
    return this.#order
      .filter(
        (item) =>
          (item.change.urgent || item.change.kind === "procedure_candidate") &&
          !this.#dismissed.has(item.change.id),
      )
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
    const fromChanges = [...latest.values()]
      .filter((item) => !this.#dismissed.has(item.change.id))
      .map(toProcurementCard);
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
    urgent: item.change.urgent,
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
