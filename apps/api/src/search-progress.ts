import { SpecialistSearchRun, type SpecialistSearchRun as SpecialistSearchRunValue } from "@procurement/contracts";

export interface SearchProgressHub {
  snapshot: (profileId: string) => SpecialistSearchRunValue | undefined;
  begin: (run: SpecialistSearchRunValue) => void;
  scored: (
    profileId: string,
    patch: Partial<Pick<SpecialistSearchRunValue, "scoredCount" | "matchCount" | "discardedCount" | "reviewCount">>,
  ) => void;
  skip: (
    profileId: string,
    row: SpecialistSearchRunValue["skipped"][number],
  ) => void;
  finish: (profileId: string, status: "done" | "failed") => void;
}

export function createSearchProgressHub(): SearchProgressHub {
  const byProfile = new Map<string, SpecialistSearchRunValue>();

  return {
    snapshot(profileId) {
      return byProfile.get(profileId);
    },
    begin(run) {
      byProfile.set(run.profileId, SpecialistSearchRun.parse(run));
    },
    scored(profileId, patch) {
      const current = byProfile.get(profileId);
      if (current === undefined) return;
      byProfile.set(profileId, SpecialistSearchRun.parse({ ...current, ...patch, status: "scoring" }));
    },
    skip(profileId, row) {
      const current = byProfile.get(profileId);
      if (current === undefined) return;
      byProfile.set(
        profileId,
        SpecialistSearchRun.parse({ ...current, skipped: [...current.skipped, row] }),
      );
    },
    finish(profileId, status) {
      const current = byProfile.get(profileId);
      if (current === undefined) return;
      byProfile.set(profileId, SpecialistSearchRun.parse({ ...current, status }));
    },
  };
}
