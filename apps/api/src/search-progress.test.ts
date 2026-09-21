import { describe, expect, it } from "vitest";
import { createSearchProgressHub } from "./search-progress.js";

const profileId = "00000000-0000-4000-8000-000000000064";
const runA = "00000000-0000-4000-8000-0000000000a1";
const runB = "00000000-0000-4000-8000-0000000000b2";

function run(runId: string) {
  return {
    profileId,
    runId,
    profileName: "НКУ",
    status: "retrieving" as const,
    retrievedCount: 10,
    scoredCount: 0,
    matchCount: 0,
    discardedCount: 2,
    reviewCount: 8,
    listingDiscardedCount: 0,
    skipped: [],
  };
}

describe("createSearchProgressHub", () => {
  it("tracks scored cards without dropping listing discards", () => {
    const hub = createSearchProgressHub();
    hub.begin(run(runA));
    hub.scored(profileId, runA, { scoredCount: 1, matchCount: 1, discardedCount: 2, reviewCount: 0 });
    expect(hub.snapshot(profileId)).toMatchObject({
      status: "scoring",
      scoredCount: 1,
      matchCount: 1,
      discardedCount: 2,
    });
    hub.skip(profileId, runA, {
      sourceProcurementId: "auction/1",
      title: "Монтаж НКУ",
      reason: "услуга в голове заголовка",
      stage: "card",
    });
    hub.finish(profileId, runA, "done");
    expect(hub.snapshot(profileId)?.status).toBe("done");
    expect(hub.snapshot(profileId)?.skipped).toEqual([
      {
        sourceProcurementId: "auction/1",
        title: "Монтаж НКУ",
        reason: "услуга в голове заголовка",
        stage: "card",
      },
    ]);
  });

  it("drops writes from a superseded run so two runs cannot interleave (R15)", () => {
    const hub = createSearchProgressHub();
    hub.begin(run(runA));
    hub.begin(run(runB));
    // The older run keeps working in the background — its writes are no-ops.
    hub.scored(profileId, runA, { scoredCount: 9, matchCount: 9 });
    hub.skip(profileId, runA, {
      sourceProcurementId: "auction/old",
      title: "Старая карточка",
      reason: "проигнорировано",
      stage: "card",
    });
    hub.finish(profileId, runA, "done");
    expect(hub.isCurrent(profileId, runA)).toBe(false);
    expect(hub.isCurrent(profileId, runB)).toBe(true);
    expect(hub.snapshot(profileId)).toMatchObject({ runId: runB, status: "retrieving", scoredCount: 0 });
  });

  it("drops unguarded writes and clears the slot when the profile is removed", () => {
    const hub = createSearchProgressHub();
    hub.begin(run(runA));
    // Discovery scoring carries no runId — it must not resurrect a run.
    hub.scored(profileId, undefined, { scoredCount: 5 });
    expect(hub.snapshot(profileId)?.scoredCount).toBe(0);
    hub.clear(profileId);
    hub.finish(profileId, runA, "done");
    expect(hub.snapshot(profileId)).toBeUndefined();
    expect(hub.isCurrent(profileId, runA)).toBe(false);
  });
});
