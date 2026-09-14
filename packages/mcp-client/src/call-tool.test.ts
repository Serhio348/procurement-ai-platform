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
});
