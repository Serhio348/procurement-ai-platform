import { randomUUID } from "node:crypto";
import {
  ProcurementSearchRequest,
  RequestId,
  SourceId,
  type SearchHit,
  type SourceId as SourceIdValue,
} from "@procurement/contracts";
import {
  McpToolCallError,
  ProcurementMcpClient,
  ToolPolicyGate,
  type McpToolCaller,
} from "@procurement/mcp-client";
import { silentLogger, type Logger } from "@procurement/observability";

export interface ProcurementSearchHitsOptions {
  caller: McpToolCaller;
  sourceId: SourceIdValue;
  logger?: Logger;
  timeoutMs?: number;
}

/**
 * Console search talks to Procurement MCP as a client. Keywords come from the
 * current working profile at call time, not from the HTTP body.
 */
export function createProcurementSearchHits(
  options: ProcurementSearchHitsOptions,
): {
  search: (
    limit: number,
    keywords: readonly string[],
    excludeKeywords?: readonly string[],
  ) => Promise<readonly SearchHit[]>;
} {
  const sourceId = SourceId.parse(options.sourceId);
  const client = new ProcurementMcpClient({
    caller: options.caller,
    policyGate: new ToolPolicyGate({
      agentAllowedTools: ["procurement.search"],
    }),
    timeoutMs: options.timeoutMs ?? 120_000,
    logger: options.logger ?? silentLogger,
  });

  return {
    async search(
      limit: number,
      keywords: readonly string[],
      excludeKeywords?: readonly string[],
    ): Promise<readonly SearchHit[]> {
      if (keywords.length === 0) {
        throw new McpToolCallError(
          "invalid_request",
          "procurement.search",
          "В профиле нет ключевых слов для поиска.",
        );
      }
      const response = await client.search(
        ProcurementSearchRequest.parse({
          sourceId,
          keywords: [...keywords],
          excludeKeywords: [...(excludeKeywords ?? [])],
          searchText: keywords.join(" "),
          limit,
          offset: 0,
        }),
        RequestId.parse(randomUUID()),
      );
      return response.hits;
    },
  };
}
