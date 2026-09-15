import { describe, expect, it } from "vitest";
import { createSearchProgressHub } from "./search-progress.js";

const profileId = "00000000-0000-4000-8000-000000000064";

describe("createSearchProgressHub", () => {
  it("tracks scored cards without dropping listing discards", () => {
    const hub = createSearchProgressHub();
    hub.begin({
      profileId,
      profileName: "НКУ",
      status: "retrieving",
      retrievedCount: 10,
      scoredCount: 0,
      matchCount: 0,
      discardedCount: 2,
      reviewCount: 8,
    });
    hub.scored(profileId, { scoredCount: 1, matchCount: 1, discardedCount: 2, reviewCount: 0 });
    expect(hub.snapshot(profileId)).toMatchObject({
      status: "scoring",
      scoredCount: 1,
      matchCount: 1,
      discardedCount: 2,
    });
    hub.skip(profileId, {
      sourceProcurementId: "auction/1",
      title: "Монтаж НКУ",
      reason: "услуга в голове заголовка",
      stage: "card",
    });
    hub.finish(profileId, "done");
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
});
