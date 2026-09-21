import { SpecialistSearchRun, type SpecialistSearchRun as SpecialistSearchRunValue } from "@procurement/contracts";

export interface SearchProgressHub {
  snapshot: (profileId: string) => SpecialistSearchRunValue | undefined;
  /** True while `runId` still owns the profile's progress slot (R15). */
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
  /** Profile removed: pending writes of its run become no-ops. */
  clear: (profileId: string) => void;
}

/**
 * One progress slot per profile; the newest run owns it. Writers carry
 * their runId and every mutation is a no-op once a newer `begin` replaced
 * the slot — a superseded background run silences itself (R15).
 * `undefined` never owns a slot: scoring inside a discovery pass carries
 * no runId and must not resurrect a finished manual run to "scoring".
 */
export function createSearchProgressHub(): SearchProgressHub {
  const byProfile = new Map<string, SpecialistSearchRunValue>();

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
      return byProfile.get(profileId)?.runId === runId;
    },
    begin(run) {
      byProfile.set(run.profileId, SpecialistSearchRun.parse(run));
    },
    scored(profileId, runId, patch) {
      const current = owned(profileId, runId);
      if (current === undefined) return;
      byProfile.set(profileId, SpecialistSearchRun.parse({ ...current, ...patch, status: "scoring" }));
    },
    skip(profileId, runId, row) {
      const current = owned(profileId, runId);
      if (current === undefined) return;
      byProfile.set(
        profileId,
        SpecialistSearchRun.parse({ ...current, skipped: [...current.skipped, row] }),
      );
    },
    finish(profileId, runId, status) {
      const current = owned(profileId, runId);
      if (current === undefined) return;
      byProfile.set(profileId, SpecialistSearchRun.parse({ ...current, status }));
    },
    clear(profileId) {
      byProfile.delete(profileId);
    },
  };
}
