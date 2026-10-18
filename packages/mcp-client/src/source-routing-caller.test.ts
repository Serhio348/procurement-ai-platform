import { describe, expect, it, vi } from "vitest";
import type { McpCallResult, McpToolCaller } from "./call-tool.js";
import { createSourceRoutingCaller } from "./source-routing-caller.js";

const options = { requestId: "req-1" as never, timeoutMs: 5_000 };

describe("createSourceRoutingCaller", () => {
  const ok: McpCallResult = { structuredContent: { hits: [] } };

  it("routes by arguments.sourceId to that source's child", async () => {
    const goszakupki = { callTool: vi.fn<McpToolCaller["callTool"]>().mockResolvedValue(ok) };
    const butb = { callTool: vi.fn<McpToolCaller["callTool"]>().mockResolvedValue(ok) };
    const caller = createSourceRoutingCaller({
      callers: new Map([
        ["goszakupki_by", goszakupki],
        ["butb", butb],
      ]),
      fallback: goszakupki,
    });

    await caller.callTool("procurement.search", { sourceId: "butb", keywords: ["a"] }, options);
    await caller.callTool(
      "procurement.get",
      { sourceId: "goszakupki_by", sourceProcurementId: "auction/1" },
      options,
    );

    expect(butb.callTool).toHaveBeenCalledTimes(1);
    expect(goszakupki.callTool).toHaveBeenCalledTimes(1);
    expect(butb.callTool.mock.calls[0]?.[1]).toMatchObject({ sourceId: "butb" });
  });

  it("routes procurement.download by its sourceId field", async () => {
    const goszakupki = { callTool: vi.fn<McpToolCaller["callTool"]>().mockResolvedValue(ok) };
    const butb = { callTool: vi.fn<McpToolCaller["callTool"]>().mockResolvedValue(ok) };
    const caller = createSourceRoutingCaller({
      callers: new Map([
        ["goszakupki_by", goszakupki],
        ["butb", butb],
      ]),
      fallback: goszakupki,
    });

    await caller.callTool(
      "procurement.download",
      { sourceId: "butb", downloadUrl: "https://zakupki.butb.by/auctions/download?id=1" },
      options,
    );

    expect(butb.callTool).toHaveBeenCalledTimes(1);
    expect(goszakupki.callTool).not.toHaveBeenCalled();
  });

  it("sends sourceless calls (procurement.sources) and unknown sources to the fallback", async () => {
    const goszakupki = { callTool: vi.fn<McpToolCaller["callTool"]>().mockResolvedValue(ok) };
    const butb = { callTool: vi.fn<McpToolCaller["callTool"]>().mockResolvedValue(ok) };
    const caller = createSourceRoutingCaller({
      callers: new Map([
        ["goszakupki_by", goszakupki],
        ["butb", butb],
      ]),
      fallback: goszakupki,
    });

    await caller.callTool("procurement.sources", {}, options);
    await caller.callTool("procurement.get", { sourceId: "etrade", id: "1" }, options);

    expect(goszakupki.callTool).toHaveBeenCalledTimes(2);
    expect(butb.callTool).not.toHaveBeenCalled();
  });

  it("rejects a configured-but-unconnected source as source_unavailable", async () => {
    const goszakupki = { callTool: vi.fn<McpToolCaller["callTool"]>().mockResolvedValue(ok) };
    const caller = createSourceRoutingCaller({
      callers: new Map([["goszakupki_by", goszakupki]]),
      fallback: goszakupki,
      missing: new Set(["butb"]),
    });

    await expect(
      caller.callTool("procurement.search", { sourceId: "butb", keywords: ["a"] }, options),
    ).rejects.toMatchObject({ name: "McpToolCallError", kind: "source_unavailable" });
    expect(goszakupki.callTool).not.toHaveBeenCalled();
  });
});
