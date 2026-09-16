import { SpecialistWorkingProfile } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { profileToSiteSearchQuery } from "./profile-search-query.js";

function toIsoDateTime(value: string): string {
  return `${value}T00:00:00+03:00`;
}

describe("profileToSiteSearchQuery", () => {
  it("copies every filled advanced-search window onto the source query", () => {
    const profile = SpecialistWorkingProfile.parse({
      name: "КТПБ",
      keywords: ["КТПБ"],
      excludeKeywords: ["ремонт"],
      statuses: ["accepting_bids", "auction_in_progress"],
      excludeSingleSource: true,
      filters: {
        buyerUnp: "123456789",
        buyerText: "Гродноэнерго",
        procurementNumber: "auc0003664806",
        priceFrom: 1000,
        priceTo: 500000,
        publishedFrom: "2026-09-01",
        publishedTo: "2026-09-30",
        requestEndFrom: "2026-09-16",
        requestEndTo: "2026-10-01",
        auctionFrom: "2026-09-20",
        auctionTo: "2026-09-25",
        typeIds: ["Auction", "singleSource"],
        regionIds: ["4", "7"],
      },
    });

    expect(
      profileToSiteSearchQuery(profile, { limit: 50, offset: 0, toIsoDateTime }),
    ).toEqual({
      keywords: ["КТПБ"],
      excludeKeywords: ["ремонт"],
      buyerUnp: "123456789",
      buyerText: "Гродноэнерго",
      procurementNumber: "auc0003664806",
      priceFrom: 1000,
      priceTo: 500000,
      publishedFrom: "2026-09-01T00:00:00+03:00",
      publishedTo: "2026-09-30T00:00:00+03:00",
      requestEndFrom: "2026-09-16T00:00:00+03:00",
      requestEndTo: "2026-10-01T00:00:00+03:00",
      auctionFrom: "2026-09-20T00:00:00+03:00",
      auctionTo: "2026-09-25T00:00:00+03:00",
      typeIds: ["Auction"],
      statusIds: [],
      statuses: ["accepting_bids", "auction_in_progress"],
      regionIds: ["4", "7"],
      kinds: [],
      limit: 50,
      offset: 0,
    });
  });

  it("does not invent type or date filters when those windows are empty", () => {
    const profile = SpecialistWorkingProfile.parse({
      keywords: ["КТПБ"],
      statuses: ["accepting_bids"],
      filters: {},
    });

    const query = profileToSiteSearchQuery(profile, { limit: 20, offset: 0, toIsoDateTime });
    expect(query.typeIds).toEqual([]);
    expect(query.regionIds).toEqual([]);
    expect(query.publishedFrom).toBeUndefined();
    expect(query.requestEndFrom).toBeUndefined();
    expect(query.statuses).toEqual(["accepting_bids"]);
  });
});
