import { RequestId, SearchHit, SourceId, electricalEquipmentSeedV1 } from "@procurement/contracts";
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
      sourceId: SourceId.parse("goszakupki_by"),
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
});
