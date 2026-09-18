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
  const instant = deadlineInstant(card);
  return instant !== undefined && instantPassed(instant, now);
}

/** The instant acceptance closes — the live card first, then the stored snapshot. */
function deadlineInstant(card: SpecialistProcurementCard): PlatformInstant | undefined {
  const live = card.sourceCard?.bidsDeadline;
  if (live !== undefined) return live;
  const stored = card.watchSnapshot?.bidsDeadline;
  if (stored === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(stored)) {
    return { precision: "date", date: stored, timeZone: DEFAULT_TIME_ZONE };
  }
  const at = Date.parse(stored);
  return Number.isFinite(at)
    ? { precision: "date_time", at: new Date(at).toISOString() }
    : undefined;
}

/**
 * True when the window closed between the last stored snapshot and now:
 * the deadline was still ahead at `capturedAt` and is behind `now`. Field
 * diffs cannot see this — the platform keeps «приём заявок» on the page for
 * weeks after acceptance closed, so the crossing is computed from time.
 */
export function deadlineCrossedSince(
  card: SpecialistProcurementCard,
  capturedAt: string | undefined,
  now: Date,
): boolean {
  if (capturedAt === undefined) return false;
  const captured = new Date(capturedAt);
  if (!Number.isFinite(captured.getTime())) return false;
  const instant = deadlineInstant(card);
  return instant !== undefined && !instantPassed(instant, captured) && instantPassed(instant, now);
}

/**
 * True when acceptance closes within `windowMs` from `now` and has not
 * closed yet. A date-only deadline counts by local calendar distance:
 * «today or tomorrow» in the source time zone ≈ less than 36 hours,
 * without inventing a clock time the source never published.
 */
export function deadlineWithin(
  card: SpecialistProcurementCard,
  now: Date,
  windowMs: number,
): boolean {
  const instant = deadlineInstant(card);
  if (instant === undefined || instantPassed(instant, now)) return false;
  const remaining = remainingMs(instant, now);
  return remaining !== undefined && remaining <= windowMs;
}

function remainingMs(instant: PlatformInstant, now: Date): number | undefined {
  if (instant.precision === "date_time") {
    const at = Date.parse(instant.at);
    return Number.isFinite(at) ? at - now.getTime() : undefined;
  }
  const DAY_MS = 86_400_000;
  const daysLeft = Math.round(
    (Date.parse(instant.date) - Date.parse(localDate(now, instant.timeZone))) / DAY_MS,
  );
  return daysLeft < 0 ? 0 : daysLeft * DAY_MS;
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
