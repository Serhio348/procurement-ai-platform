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
    // This call's whole budget is spent while it waits behind `first` — the
    // queue timer rejects it on its own deadline, before the pipe frees.
    const second = caller.callTool(
      "procurement.download",
      {},
      { requestId, timeoutMs: 5 },
    );
    const secondRejected = expect(second).rejects.toMatchObject({
      name: "McpToolCallError",
      kind: "timeout",
      toolName: "procurement.download",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseFirst?.();

    await expect(first).resolves.toEqual({});
    await secondRejected;
    // The expired call never reached the pipe.
    expect(inner.callTool).toHaveBeenCalledTimes(1);
  });

  it("settles a queued call at its deadline even while the pipe never frees", async () => {
    // The running call never resolves — the queued one's promise must still
    // reject on its own timer, not whenever the queue happens to move.
    const inner: McpToolCaller = {
      callTool: vi.fn(async () => {
        await new Promise<void>(() => undefined);
        return {};
      }),
    };
    const caller = serializeMcpToolCaller(inner);
    const requestId = RequestId.parse("00000000-0000-4000-8000-000000000004");

    void caller.callTool("procurement.search", {}, { requestId, timeoutMs: 60_000 });
    const waiting = caller.callTool(
      "procurement.get",
      {},
      { requestId, timeoutMs: 20 },
    );
    const settledAt = Date.now();
    await expect(waiting).rejects.toMatchObject({ name: "McpToolCallError", kind: "timeout" });
    expect(Date.now() - settledAt).toBeLessThan(1_000);
    expect(inner.callTool).toHaveBeenCalledTimes(1);
  });

  it("dequeues past an expired entry — the next call still runs on the pipe", async () => {
    let releaseFirst: (() => void) | undefined;
    const started: string[] = [];
    const inner: McpToolCaller = {
      callTool: vi.fn(async (toolName) => {
        started.push(toolName);
        if (toolName === "procurement.search") {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return {};
      }),
    };
    const caller = serializeMcpToolCaller(inner);
    const requestId = RequestId.parse("00000000-0000-4000-8000-000000000005");

    const first = caller.callTool("procurement.search", {}, { requestId, timeoutMs: 60_000 });
    const expired = caller.callTool("procurement.get", {}, { requestId, timeoutMs: 5 });
    const next = caller.callTool(
      "procurement.get_documents",
      {},
      { requestId, timeoutMs: 60_000 },
    );
    await expect(expired).rejects.toMatchObject({ kind: "timeout" });
    releaseFirst?.();
    await expect(first).resolves.toEqual({});
    await expect(next).resolves.toEqual({});
    // The expired entry never touched the source; the live one ran after it.
    expect(started).toEqual(["procurement.search", "procurement.get_documents"]);
  });

  it("rejects an already-aborted call without enqueueing it", async () => {
    const inner: McpToolCaller = { callTool: vi.fn(async () => ({})) };
    const caller = serializeMcpToolCaller(inner);
    const requestId = RequestId.parse("00000000-0000-4000-8000-000000000006");
    const controller = new AbortController();
    controller.abort();

    await expect(
      caller.callTool(
        "procurement.search",
        {},
        { requestId, timeoutMs: 60_000, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "McpToolCallError", kind: "aborted" });
    expect(inner.callTool).not.toHaveBeenCalled();
  });

  it("rejects a queued call whose caller aborts while it waits", async () => {
    let releaseFirst: (() => void) | undefined;
    const started: string[] = [];
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
    const requestId = RequestId.parse("00000000-0000-4000-8000-000000000007");
    const controller = new AbortController();

    const first = caller.callTool("procurement.get", {}, { requestId, timeoutMs: 60_000 });
    const cancelled = caller.callTool(
      "procurement.search",
      {},
      { requestId, timeoutMs: 60_000, signal: controller.signal },
    );
    const cancelledRejected = expect(cancelled).rejects.toMatchObject({
      kind: "aborted",
    });
    const next = caller.callTool(
      "procurement.get_documents",
      {},
      { requestId, timeoutMs: 60_000 },
    );
    await vi.waitFor(() => {
      expect(started).toEqual(["procurement.get"]);
    });
    controller.abort();
    await cancelledRejected;
    releaseFirst?.();
    await expect(first).resolves.toEqual({});
    await expect(next).resolves.toEqual({});
    // The cancelled entry never touched the source and did not stall the
    // calls queued behind it.
    expect(started).toEqual(["procurement.get", "procurement.get_documents"]);
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
