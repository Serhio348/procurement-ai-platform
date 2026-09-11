import type { PlatformInstant, SpecialistProcurementCard } from "@procurement/contracts";

const DEFAULT_TIME_ZONE = "Europe/Minsk";

/**
 * True when the bids deadline the source published is already behind `now`.
 * Decided from dates alone, not from the source status: a platform may keep
 * "рассмотрение" on a card for weeks after acceptance closed, and the
 * specialist should see that the window is gone regardless. A date-only
 * deadline stays open until the end of that day in the source time zone.
 */
export function bidsDeadlinePassed(card: SpecialistProcurementCard, now: Date): boolean {
  const live = card.sourceCard?.bidsDeadline;
  if (live !== undefined) return instantPassed(live, now);
  const stored = card.watchSnapshot?.bidsDeadline;
  if (stored === undefined) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(stored)) {
    return instantPassed({ precision: "date", date: stored, timeZone: DEFAULT_TIME_ZONE }, now);
  }
  const at = Date.parse(stored);
  return Number.isFinite(at) && at < now.getTime();
}

function instantPassed(instant: PlatformInstant, now: Date): boolean {
  if (instant.precision === "date_time") {
    const at = Date.parse(instant.at);
    return Number.isFinite(at) && at < now.getTime();
  }
  return localDate(now, instant.timeZone) > instant.date;
}

function localDate(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
