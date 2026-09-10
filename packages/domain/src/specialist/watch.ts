import {
  InboxFixtureItem,
  SpecialistCardSnapshot,
  SpecialistProcurementCard,
  type ChangeKind,
  type InboxFixtureItem as InboxFixtureItemValue,
  type PlatformInstant,
  type ProcedureCard,
  type SpecialistCardSnapshot as SpecialistCardSnapshotValue,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
} from "@procurement/contracts";
import { statusLabel, uuidFromHex } from "./case.js";

/** Triage kinds whose cases the platform keeps re-reading after the decision. */
export function isWatchedTriage(card: SpecialistProcurementCardValue): boolean {
  return card.triage === "monitor" || card.triage === "participate";
}

export interface WatchChange {
  kind: ChangeKind;
  field: string;
  previous: string | null;
  current: string | null;
}

/**
 * Snapshot of the source fields the platform re-reads for a decided case.
 * Values are stored both normalized (for comparison) and as printed (for the
 * specialist), so a reformatted page cannot look like a real change.
 */
export function cardSnapshot(
  card: ProcedureCard,
  capturedAt: string,
): SpecialistCardSnapshotValue {
  const priceLabel = amountRaw(card);
  const priceKey = normalizePriceKey(priceLabel);
  const deadline = serializeInstant(card.bidsDeadline);
  return SpecialistCardSnapshot.parse({
    capturedAt,
    status: card.status,
    ...(priceKey === undefined ? {} : { priceKey }),
    ...(priceLabel === undefined ? {} : { priceLabel }),
    ...(deadline === undefined ? {} : { bidsDeadline: deadline }),
  });
}

/**
 * Compares two snapshots of the same procedure. Only a changed normalized
 * value is a change: `1 234,00 BYN` and `1234.0 BYN` are the same price.
 * A field that disappeared from the page is not reported as a change — the
 * source being incomplete is not news about the procurement.
 */
export function diffCardSnapshots(
  previous: SpecialistCardSnapshotValue,
  current: SpecialistCardSnapshotValue,
): WatchChange[] {
  const changes: WatchChange[] = [];
  if (previous.status !== current.status) {
    changes.push({
      kind: "status_changed",
      field: "status",
      previous: statusLabel(previous.status),
      current: statusLabel(current.status),
    });
  }
  if (
    current.priceKey !== undefined &&
    previous.priceKey !== undefined &&
    previous.priceKey !== current.priceKey
  ) {
    changes.push({
      kind: "price_changed",
      field: "price",
      previous: previous.priceLabel ?? previous.priceKey,
      current: current.priceLabel ?? current.priceKey,
    });
  }
  if (
    current.bidsDeadline !== undefined &&
    previous.bidsDeadline !== undefined &&
    previous.bidsDeadline !== current.bidsDeadline
  ) {
    changes.push({
      kind: "deadline_changed",
      field: "bidsDeadline",
      previous: previous.bidsDeadline,
      current: current.bidsDeadline,
    });
  }
  return changes;
}

/**
 * Canonical numeric form of a printed sum. Thousand separators, decimal comma
 * and currency words are dropped so only a real figure change survives.
 * Returns undefined when the string carries no digits at all.
 */
export function normalizePriceKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // Trailing separators ("руб." leaves a dot) must go before the decimal
  // lookup, or ",56 руб." stops ending in digits and the fraction is lost.
  const digitsOnly = raw.replaceAll(/[^\d.,]/g, "").replace(/[^\d]+$/, "");
  if (!/\d/.test(digitsOnly)) return undefined;
  // The last separator with 1-2 trailing digits is the decimal point; every
  // other separator groups thousands.
  const decimal = /[.,](\d{1,2})$/.exec(digitsOnly);
  const whole = (decimal === null ? digitsOnly : digitsOnly.slice(0, decimal.index)).replaceAll(
    /[^\d]/g,
    "",
  );
  const fraction = decimal?.[1] ?? "";
  const trimmedWhole = whole.replace(/^0+(?=\d)/, "");
  const trimmedFraction = fraction.replace(/0+$/, "");
  if (trimmedWhole.length === 0 && trimmedFraction.length === 0) return undefined;
  const left = trimmedWhole.length === 0 ? "0" : trimmedWhole;
  return trimmedFraction.length === 0 ? left : `${left}.${trimmedFraction}`;
}

/** Inbox row for a change the platform found on a decided case. */
export function inboxItemFromWatchChange(
  card: SpecialistProcurementCardValue,
  change: WatchChange,
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
      // The new value is part of the id: the same change reported twice stays
      // one inbox row, a further change becomes a new one.
      id: uuidFromHex(`inbox-watch:${card.id}:${change.kind}:${change.current ?? ""}`),
      procurementId: card.id,
      kind: change.kind,
      field: change.field,
      previous: change.previous,
      current: change.current,
      detectedAt,
      urgent: true,
    },
  });
}

/** Stores the fresh snapshot on the case without touching specialist data. */
export function withWatchSnapshot(
  card: SpecialistProcurementCardValue,
  snapshot: SpecialistCardSnapshotValue,
): SpecialistProcurementCardValue {
  return SpecialistProcurementCard.parse({ ...card, watchSnapshot: snapshot });
}

function amountRaw(card: ProcedureCard): string | undefined {
  const amount = card.amount ?? card.startingPrice;
  if (amount === undefined) return undefined;
  if ("raw" in amount && amount.raw.length > 0) return amount.raw;
  if ("amount" in amount && typeof amount.amount === "number") {
    const currency = "currency" in amount && amount.currency !== undefined ? amount.currency : "";
    return `${String(amount.amount)} ${currency}`.trim();
  }
  return undefined;
}

function serializeInstant(value: PlatformInstant | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.precision === "date" ? value.date : value.at;
}
