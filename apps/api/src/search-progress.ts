import { SpecialistSearchRun, type SpecialistSearchRun as SpecialistSearchRunValue } from "@procurement/contracts";

/** Statuses after which a run must never move again. */
const TERMINAL_STATUSES = new Set(["done", "failed", "interrupted", "cancelled"]);

export interface SearchProgressHub {
  snapshot: (profileId: string) => SpecialistSearchRunValue | undefined;
  /** True while `runId` still owns the profile's progress slot (R15)
   * and the run has not reached a terminal state (R35). */
  isCurrent: (profileId: string, runId: string) => boolean;
  begin: (run: SpecialistSearchRunValue) => void;
  scored: (
    profileId: string,
    runId: string | undefined,
    patch: Partial<Pick<SpecialistSearchRunValue, "scoredCount" | "matchCount" | "discardedCount" | "reviewCount">>,
  ) => void;
  skip: (
    profileId: string,
    runId: string | undefined,
    row: SpecialistSearchRunValue["skipped"][number],
  ) => void;
  finish: (profileId: string, runId: string | undefined, status: "done" | "failed") => void;
  /**
   * Stops the profile's live run (R35). The cancellation is also remembered:
   * a search whose listing phase is still in flight has no run yet — when
   * its `begin` finally lands, the run is stored already cancelled and the
   * scoring loop exits on its first liveness check.
   */
  cancel: (profileId: string) => void;
  /** Profile removed: pending writes of its run become no-ops. */
  clear: (profileId: string) => void;
}

/**
 * One progress slot per profile; the newest run owns it. Writers carry
 * their runId and every mutation is a no-op once a newer `begin` replaced
 * the slot — a superseded background run silences itself (R15).
 * `undefined` never owns a slot: scoring inside a discovery pass carries
 * no runId and must not resurrect a finished manual run to "scoring".
 * A terminal run is immutable: a late `scored`/`finish` write cannot
 * flip "cancelled" back to "scoring" or "done" (R35).
 */
export function createSearchProgressHub(): SearchProgressHub {
  const byProfile = new Map<string, SpecialistSearchRunValue>();
  // Profiles whose next run must land already cancelled: the listing phase
  // of a button search holds no run yet, so a plain slot write cannot
  // reach it (R35). The marker expires quickly — a stray cancel must not
  // poison a search started a minute later.
  const CANCEL_AHEAD_MS = 60_000;
  const cancelledAhead = new Map<string, number>();

  const consumeCancelledAhead = (profileId: string): boolean => {
    const at = cancelledAhead.get(profileId);
    cancelledAhead.delete(profileId);
    return at !== undefined && Date.now() - at < CANCEL_AHEAD_MS;
  };

  const owned = (
    profileId: string,
    runId: string | undefined,
  ): SpecialistSearchRunValue | undefined => {
    const current = byProfile.get(profileId);
    if (current === undefined || runId === undefined || current.runId !== runId) return undefined;
    return current;
  };

  return {
    snapshot(profileId) {
      return byProfile.get(profileId);
    },
    isCurrent(profileId, runId) {
      const current = byProfile.get(profileId);
      return (
        current?.runId === runId && !TERMINAL_STATUSES.has(current.status)
      );
    },
    begin(run) {
      const cancelled = consumeCancelledAhead(run.profileId);
      byProfile.set(
        run.profileId,
        SpecialistSearchRun.parse(
          cancelled ? { ...run, status: "cancelled" } : run,
        ),
      );
    },
    scored(profileId, runId, patch) {
      const current = owned(profileId, runId);
      if (current === undefined || TERMINAL_STATUSES.has(current.status)) return;
      byProfile.set(profileId, SpecialistSearchRun.parse({ ...current, ...patch, status: "scoring" }));
    },
    skip(profileId, runId, row) {
      const current = owned(profileId, runId);
      if (current === undefined || TERMINAL_STATUSES.has(current.status)) return;
      byProfile.set(
        profileId,
        SpecialistSearchRun.parse({ ...current, skipped: [...current.skipped, row] }),
      );
    },
    finish(profileId, runId, status) {
      const current = owned(profileId, runId);
      if (current === undefined || TERMINAL_STATUSES.has(current.status)) return;
      byProfile.set(profileId, SpecialistSearchRun.parse({ ...current, status }));
    },
    cancel(profileId) {
      const current = byProfile.get(profileId);
      if (current !== undefined && !TERMINAL_STATUSES.has(current.status)) {
        // A live run already finished its listing — mark it and let the
        // next legitimate search start clean.
        byProfile.set(
          profileId,
          SpecialistSearchRun.parse({ ...current, status: "cancelled" }),
        );
        return;
      }
      // No run yet: a listing may still be in flight — its begin() must
      // land already cancelled.
      cancelledAhead.set(profileId, Date.now());
    },
    clear(profileId) {
      cancelledAhead.delete(profileId);
      byProfile.delete(profileId);
    },
  };
}
