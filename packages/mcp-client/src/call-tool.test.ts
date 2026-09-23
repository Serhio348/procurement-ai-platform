import { RequestId } from "@procurement/contracts";
import { describe, expect, it, vi } from "vitest";
import { serializeMcpToolCaller, type McpToolCaller } from "./call-tool.js";

describe("serializeMcpToolCaller", () => {
  it("does not start a second stdio call until the first finishes", async () => {
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const inner: McpToolCaller = {
      callTool: vi.fn(async (toolName) => {
        started.push(toolName);
        if (toolName === "procurement.get") {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return {};
      }),
    };
    const caller = serializeMcpToolCaller(inner);
    const requestId = RequestId.parse("00000000-0000-4000-8000-000000000001");

    const first = caller.callTool("procurement.get", {}, { requestId, timeoutMs: 1_000 });
    const second = caller.callTool(
      "procurement.get_documents",
      {},
      { requestId, timeoutMs: 1_000 },
    );
    await vi.waitFor(() => {
      expect(started).toEqual(["procurement.get"]);
    });
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(started).toEqual(["procurement.get", "procurement.get_documents"]);
  });

  it("fails a queued call whose deadline expired while waiting", async () => {
    let releaseFirst: (() => void) | undefined;
    const inner: McpToolCaller = {
      callTool: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return {};
      }),
    };
    const caller = serializeMcpToolCaller(inner);
    const requestId = RequestId.parse("00000000-0000-4000-8000-000000000002");

    const first = caller.callTool("procurement.get", {}, { requestId, timeoutMs: 60_000 });
    // This call's whole budget is spent while it waits behind `first`.
    const second = caller.callTool(
      "procurement.download",
      {},
      { requestId, timeoutMs: 5 },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseFirst?.();

    await expect(first).resolves.toEqual({});
    await expect(second).rejects.toMatchObject({
      name: "McpToolCallError",
      kind: "timeout",
      toolName: "procurement.download",
    });
    // The expired call never reached the pipe.
    expect(inner.callTool).toHaveBeenCalledTimes(1);
  });

  it("runs a high-priority call before queued normal ones", async () => {
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const inner: McpToolCaller = {
      callTool: vi.fn(async (toolName) => {
        started.push(toolName);
        if (toolName === "procurement.get_history") {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return {};
      }),
    };
    const caller = serializeMcpToolCaller(inner);
    const requestId = RequestId.parse("00000000-0000-4000-8000-000000000003");

    const first = caller.callTool("procurement.get_history", {}, { requestId, timeoutMs: 60_000 });
    await vi.waitFor(() => {
      expect(started).toEqual(["procurement.get_history"]);
    });
    const bulk = caller.callTool("procurement.download", {}, { requestId, timeoutMs: 60_000 });
    const urgent = caller.callTool(
      "procurement.get",
      {},
      { requestId, timeoutMs: 60_000, priority: "high" },
    );
    releaseFirst?.();
    await Promise.all([first, bulk, urgent]);
    expect(started).toEqual([
      "procurement.get_history",
      "procurement.get",
      "procurement.download",
    ]);
  });
});
