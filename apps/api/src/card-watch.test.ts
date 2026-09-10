import { ProcedureCard, SourceId } from "@procurement/contracts";
import type { McpToolCaller } from "@procurement/mcp-client";
import { describe, expect, it, vi } from "vitest";
import { createProcurementCardWatch } from "./card-watch.js";

function cardCaller(cards: Record<string, unknown>): McpToolCaller {
  return {
    callTool: vi.fn(async (name, input) => {
      if (name !== "procurement.get") throw new Error(`unexpected tool: ${String(name)}`);
      const key = String((input as { sourceProcurementId?: unknown }).sourceProcurementId);
      const card = cards[key];
      if (card === undefined) throw new Error("card not found");
      return { structuredContent: card };
    }) as McpToolCaller["callTool"],
  };
}

function cardFor(id: string, status: string, price: string) {
  return ProcedureCard.parse({
    sourceId: "goszakupki_by",
    sourceProcurementId: id,
    url: `https://goszakupki.by/auction/view/${id}`,
    title: "Поставка НКУ-0,4",
    fetchedAt: "2026-09-10T00:00:00.000Z",
    status,
    amount: { kind: "limit", amount: null, raw: price },
  });
}

describe("createProcurementCardWatch", () => {
  it("fetches a card through procurement.get and returns it", async () => {
    const watch = createProcurementCardWatch({
      caller: cardCaller({ "auction/200": cardFor("auction/200", "accepting_bids", "1 000,00 BYN") }),
      sourceId: SourceId.parse("goszakupki_by"),
    });

    const card = await watch.read("auction/200");

    expect(card).toBeDefined();
    expect(card?.sourceProcurementId).toBe("auction/200");
    expect(card?.amount?.raw).toBe("1 000,00 BYN");
  });

  it("returns undefined for a missing or broken card", async () => {
    const watch = createProcurementCardWatch({
      caller: {
        callTool: async () => {
          throw new Error("source unavailable");
        },
      },
      sourceId: SourceId.parse("goszakupki_by"),
    });

    const card = await watch.read("auction/404");

    expect(card).toBeUndefined();
  });
});
