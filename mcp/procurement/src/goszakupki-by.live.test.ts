import { SearchQuery, SourceProcurementId } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { GoszakupkiHttpClient } from "./goszakupki-by-http.js";
import { GoszakupkiBySource } from "./goszakupki-by-source.js";

const live = process.env["RUN_GOSZAKUPKI_LIVE_TESTS"] === "1";

describe.runIf(live)("GoszakupkiBySource live contract", () => {
  const source = new GoszakupkiBySource({
    client: new GoszakupkiHttpClient({
      requestsPerMinute: 120,
      timeoutMs: 30_000,
    }),
  });

  it("searches the public list through an anonymous cookie session", async () => {
    const result = await source.search(
      SearchQuery.parse({
        sourceId: "goszakupki_by",
        keywords: ["трансформатор"],
        limit: 5,
      }),
    );

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((hit) => hit.url.startsWith("https://goszakupki.by/"))).toBe(
      true,
    );
  });

  it.each([
    ["auction/3545578", "auction"],
    ["marketing/3636646", "marketing"],
    ["request/3632989", "request"],
    ["etrade/3636341", "etrade"],
    ["single-source/3637380", "other"],
  ] as const)("parses the public %s card", async (sourceId, pageFamily) => {
    const card = await source.get(SourceProcurementId.parse(sourceId));

    expect(card.pageFamily).toBe(pageFamily);
    expect(card.title.length).toBeGreaterThan(5);
    expect(card.lots.length).toBeGreaterThan(0);
    expect(card.externalIds.some((identifier) => identifier.kind === "auc")).toBe(true);
  });
});
