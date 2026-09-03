import { FilesPutRequest, RequestId } from "@procurement/contracts";
import { describe, expect, it, vi } from "vitest";
import type { McpToolCaller } from "./call-tool.js";
import { DocumentsMcpClient } from "./documents-client.js";
import { ToolPolicyDeniedError, ToolPolicyGate } from "./tool-policy.js";

const requestId = RequestId.parse("request-docs");

describe("DocumentsMcpClient", () => {
  it("does not invoke transport when the compiled allowlist omits the tool", async () => {
    const callTool = vi.fn<McpToolCaller["callTool"]>();
    const client = new DocumentsMcpClient({
      caller: { callTool },
      policyGate: new ToolPolicyGate({ agentAllowedTools: ["procurement.search"] }),
    });

    await expect(
      client.download({ sourceUrl: "https://example.test/files/spec-001.pdf" }, requestId),
    ).rejects.toBeInstanceOf(ToolPolicyDeniedError);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("puts a blob only when files.put is allowed", async () => {
    const callTool = vi.fn<McpToolCaller["callTool"]>().mockResolvedValue({
      structuredContent: {
        hash: "a".repeat(64),
        storageKey: `blobs/${"a".repeat(64)}`,
        sizeBytes: 4,
      },
    });
    const client = new DocumentsMcpClient({
      caller: { callTool },
      policyGate: new ToolPolicyGate({ agentAllowedTools: ["files.put"] }),
    });

    await expect(
      client.putFile(FilesPutRequest.parse({ bytesBase64: "dGVzdA==" }), requestId),
    ).resolves.toMatchObject({ sizeBytes: 4 });
    expect(callTool).toHaveBeenCalledWith(
      "files.put",
      expect.objectContaining({ bytesBase64: "dGVzdA==" }),
      expect.objectContaining({ requestId: "request-docs" }),
    );
  });
});
