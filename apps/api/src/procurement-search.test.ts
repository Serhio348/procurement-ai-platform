import {
  RequestId,
  SearchHit,
  SourceId,
  electricalEquipmentSeedV1,
  type SearchQuery,
} from "@procurement/contracts";
import type { McpToolCaller } from "@procurement/mcp-client";
import { describe, expect, it, vi } from "vitest";
import { createProcurementSearchHits } from "./procurement-search.js";

describe("createProcurementSearchHits", () => {
  it("searches goszakupki_by with profile keywords and never calls procurement.get", async () => {
    const callTool = vi.fn<McpToolCaller["callTool"]>().mockResolvedValue({
      structuredContent: {
        hits: [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/3629820",
            url: "https://goszakupki.by/auction/view/3629820",
            title: "2БКТПБ 400кВА",
          }),
        ],
      },
    });
    const port = createProcurementSearchHits({
      caller: { callTool },
      sourceIds: [SourceId.parse("goszakupki_by")],
    });

    const hits = await port.search({
      limit: 20,
      keywords: electricalEquipmentSeedV1.keywords,
      excludeKeywords: [],
      buyerUnp: "",
      buyerText: "",
      procurementNumber: "",
      regionIds: [],
      typeIds: [],
      statusIds: [],
      statuses: [],
      kinds: [],
      offset: 0,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.sourceProcurementId).toBe("auction/3629820");
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0]?.[0]).toBe("procurement.search");
    expect(callTool.mock.calls[0]?.[1]).toMatchObject({
      sourceId: "goszakupki_by",
      keywords: [...electricalEquipmentSeedV1.keywords],
      excludeKeywords: [],
      limit: 20,
      offset: 0,
    });
    expect(callTool.mock.calls[0]?.[1]).not.toHaveProperty("profile");
    expect(RequestId.parse(String(callTool.mock.calls[0]?.[2]?.requestId)).length).toBeGreaterThan(0);
  });

  const baseQuery = (): Omit<SearchQuery, "sourceId"> => ({
    limit: 20,
    keywords: ["трансформатор"],
    excludeKeywords: [],
    buyerUnp: "",
    buyerText: "",
    procurementNumber: "",
    regionIds: [],
    typeIds: [],
    statusIds: [],
    statuses: [],
    kinds: [],
    offset: 0,
  });

  it("fans out to every enabled source and merges hits newest-first", async () => {
    const callTool = vi.fn<McpToolCaller["callTool"]>().mockImplementation(async (_tool, args) => ({
      structuredContent: {
        hits: [
          SearchHit.parse({
            sourceId: (args as { sourceId: string }).sourceId,
            sourceProcurementId:
              (args as { sourceId: string }).sourceId === "butb" ? "butb/AU1" : "auction/9",
            url: "https://example.test/card",
            title: "hit",
            publishedAt:
              (args as { sourceId: string }).sourceId === "butb"
                ? { precision: "date", date: "2026-10-20", timeZone: "Europe/Minsk" }
                : { precision: "date", date: "2026-10-10", timeZone: "Europe/Minsk" },
          }),
        ],
        hasMore: (args as { sourceId: string }).sourceId === "butb",
      },
    }));
    const port = createProcurementSearchHits({
      caller: { callTool },
      sourceIds: [SourceId.parse("goszakupki_by"), SourceId.parse("butb")],
    });

    const page = await port.searchDetailed(baseQuery());

    expect(callTool).toHaveBeenCalledTimes(2);
    expect(page.hits.map((hit) => hit.sourceProcurementId)).toEqual(["butb/AU1", "auction/9"]);
    expect(page.hasMore).toBe(true);
  });

  it("returns the healthy source's page when the other source fails", async () => {
    const callTool = vi.fn<McpToolCaller["callTool"]>().mockImplementation(async (_tool, args) => {
      if ((args as { sourceId: string }).sourceId === "butb") {
        throw new Error("jsf session lost");
      }
      return {
        structuredContent: {
          hits: [
            SearchHit.parse({
              sourceId: "goszakupki_by",
              sourceProcurementId: "auction/1",
              url: "https://goszakupki.by/auction/view/1",
              title: "kept",
            }),
          ],
        },
      };
    });
    const port = createProcurementSearchHits({
      caller: { callTool },
      sourceIds: [SourceId.parse("goszakupki_by"), SourceId.parse("butb")],
    });

    const hits = await port.search(baseQuery());

    expect(hits.map((hit) => hit.sourceProcurementId)).toEqual(["auction/1"]);
  });

  it("lets the workspace gate drop the pilot source outside the pilot", async () => {
    const callTool = vi.fn<McpToolCaller["callTool"]>().mockResolvedValue({
      structuredContent: { hits: [] },
    });
    let workspaceId: string | undefined = "ws-admin";
    const port = createProcurementSearchHits({
      caller: { callTool },
      sourceIds: [SourceId.parse("goszakupki_by"), SourceId.parse("butb")],
      activeWorkspaceId: () => workspaceId,
      sourcesForWorkspace: (id) =>
        id === "ws-admin"
          ? [SourceId.parse("goszakupki_by"), SourceId.parse("butb")]
          : [SourceId.parse("goszakupki_by")],
    });

    await port.search(baseQuery());
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(
      callTool.mock.calls.map((call) => (call[1] as { sourceId: string }).sourceId).sort(),
    ).toEqual(["butb", "goszakupki_by"]);

    callTool.mockClear();
    workspaceId = "ws-other";
    await port.search(baseQuery());
    expect(callTool).toHaveBeenCalledTimes(1);
    expect((callTool.mock.calls[0]?.[1] as { sourceId: string }).sourceId).toBe("goszakupki_by");
  });
});
