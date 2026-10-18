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

  it("routes a butb-namespaced id to the butb lane instead of the wired default", async () => {
    const callTool = vi.fn<McpToolCaller["callTool"]>(async (name, input) => {
      if (name !== "procurement.get") throw new Error(`unexpected tool: ${String(name)}`);
      return {
        structuredContent: cardFor(
          String((input as { sourceProcurementId?: unknown }).sourceProcurementId),
          "accepting_bids",
          "2 000,00 BYN",
        ),
      };
    });
    const watch = createProcurementCardWatch({
      caller: { callTool },
      sourceId: SourceId.parse("goszakupki_by"),
    });

    const card = await watch.read("butb/AU2026101500123");

    expect(card?.sourceProcurementId).toBe("butb/AU2026101500123");
    expect(callTool.mock.calls[0]?.[1]).toMatchObject({
      sourceId: SourceId.parse("butb"),
      sourceProcurementId: "butb/AU2026101500123",
    });
  });

  it("probes a butb-hosted document on the butb lane and keeps externals on the default", async () => {
    const callTool = vi.fn<McpToolCaller["callTool"]>(async (name) => {
      if (name !== "procurement.download") throw new Error(`unexpected tool: ${String(name)}`);
      return {
        structuredContent: {
          hash: "a".repeat(64),
          storageKey: `blobs/${"a".repeat(64)}`,
          sizeBytes: 4,
          contentType: "application/pdf",
        },
      };
    });
    const watch = createProcurementCardWatch({
      caller: { callTool },
      sourceId: SourceId.parse("goszakupki_by"),
    });

    await watch.probeDocument?.(
      "https://zakupki.butb.by/auctions/download?id=6116020&name=tz.pdf",
    );
    await watch.probeDocument?.("https://files.example.by/docs/tz.pdf");

    expect(callTool.mock.calls[0]?.[1]).toMatchObject({
      sourceId: SourceId.parse("butb"),
      downloadUrl: "https://zakupki.butb.by/auctions/download?id=6116020&name=tz.pdf",
    });
    expect(callTool.mock.calls[1]?.[1]).toMatchObject({
      sourceId: SourceId.parse("goszakupki_by"),
      downloadUrl: "https://files.example.by/docs/tz.pdf",
    });
  });
});
