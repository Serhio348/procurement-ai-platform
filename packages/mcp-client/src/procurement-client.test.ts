import { ProcurementSearchRequest, RequestId } from "@procurement/contracts";
import { describe, expect, it, vi } from "vitest";
import type { McpToolCaller } from "./call-tool.js";
import { ProcurementMcpClient } from "./procurement-client.js";
import { ToolPolicyDeniedError, ToolPolicyGate } from "./tool-policy.js";

const query = ProcurementSearchRequest.parse({
  sourceId: "fixture",
  keywords: ["transformer"],
});
const requestId = (value: string) => RequestId.parse(value);

describe("ProcurementMcpClient", () => {
  it("does not invoke transport when code policy denies the tool", async () => {
    const callTool = vi.fn<McpToolCaller["callTool"]>();
    const client = new ProcurementMcpClient({
      caller: { callTool },
      policyGate: new ToolPolicyGate({ agentAllowedTools: [] }),
    });

    await expect(client.search(query, requestId("request-1"))).rejects.toBeInstanceOf(
      ToolPolicyDeniedError,
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it("passes correlation and timeout settings to the transport", async () => {
    const callTool = vi.fn<McpToolCaller["callTool"]>().mockResolvedValue({
      structuredContent: { hits: [] },
    });
    const client = new ProcurementMcpClient({
      caller: { callTool },
      policyGate: new ToolPolicyGate({ agentAllowedTools: ["procurement.search"] }),
      timeoutMs: 1234,
    });

    await expect(client.search(query, requestId("request-2"))).resolves.toEqual({ hits: [] });
    expect(callTool).toHaveBeenCalledWith("procurement.search", query, {
      requestId: "request-2",
      timeoutMs: 1234,
    });
  });

  it("rejects malformed structured output", async () => {
    const client = new ProcurementMcpClient({
      caller: {
        callTool: vi.fn().mockResolvedValue({ structuredContent: { hits: "not-an-array" } }),
      },
      policyGate: new ToolPolicyGate({ agentAllowedTools: ["procurement.search"] }),
    });

    const result = client.search(query, requestId("request-3"));
    await expect(result).rejects.toMatchObject({ kind: "invalid_output" });
  });

  it("maps typed source errors returned by MCP", async () => {
    const client = new ProcurementMcpClient({
      caller: {
        callTool: vi.fn().mockResolvedValue({
          isError: true,
          errorKind: "source_unavailable",
          content: [{ type: "text", text: "Source is blocked" }],
        }),
      },
      policyGate: new ToolPolicyGate({ agentAllowedTools: ["procurement.search"] }),
    });

    await expect(client.search(query, requestId("request-source-error"))).rejects.toMatchObject({
      kind: "source_unavailable",
      message: "Source is blocked",
    });
  });

  it("rejects profile payloads at the external boundary", async () => {
    const client = new ProcurementMcpClient({
      caller: { callTool: vi.fn() },
      policyGate: new ToolPolicyGate({ agentAllowedTools: ["procurement.search"] }),
    });

    await expect(
      client.search(
        { ...query, domainProfile: { slug: "forbidden" } } as typeof query,
        requestId("request-4"),
      ),
    ).rejects.toThrow();
  });
});
