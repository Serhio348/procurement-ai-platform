import { randomUUID } from "node:crypto";
import {
  ProcurementSearchRequest,
  RequestId,
  type SearchQuery,
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
  /**
   * Sources the fan-out may use, in preference order. Defaults to the
   * goszakupki lane alone — the single-source behaviour before BUTB.
   */
  sourceIds?: readonly SourceIdValue[];
  /**
   * Narrows `sourceIds` for the calling cabinet (BUTB_WORKSPACE_IDS pilot).
   * Receives undefined outside a cabinet scope; absent: every call uses
   * `sourceIds` unchanged.
   */
  sourcesForWorkspace?: (workspaceId: string | undefined) => readonly SourceIdValue[];
  /** Current-cabinet lookup; evaluated per call inside the request scope. */
  activeWorkspaceId?: () => string | undefined;
  logger?: Logger;
  timeoutMs?: number;
}

/**
 * Console search talks to Procurement MCP as a client. Keywords come from the
 * current working profile at call time, not from the HTTP body.
 *
 * With several sources enabled the query fans out to each one independently:
 * a source that times out or errors contributes an empty page (and a warn
 * line), never an exception — one platform must not dark the whole console.
 * Hits merge by publication date; `hasMore` ORs across sources so a
 * truncated lane keeps paging alive.
 */
export function createProcurementSearchHits(
  options: ProcurementSearchHitsOptions,
): {
  search: (query: Omit<SearchQuery, "sourceId">) => Promise<readonly SearchHit[]>;
  searchDetailed: (
    query: Omit<SearchQuery, "sourceId">,
  ) => Promise<{ hits: readonly SearchHit[]; hasMore?: boolean }>;
} {
  const logger = options.logger ?? silentLogger;
  const defaultSourceIds: readonly SourceIdValue[] =
    options.sourceIds ?? [SourceId.parse("goszakupki_by")];
  const client = new ProcurementMcpClient({
    caller: options.caller,
    policyGate: new ToolPolicyGate({
      agentAllowedTools: ["procurement.search"],
    }),
    timeoutMs: options.timeoutMs ?? 120_000,
    logger,
  });

  const call = async (query: Omit<SearchQuery, "sourceId">) => {
    if (query.keywords.length === 0) {
      throw new McpToolCallError(
        "invalid_request",
        "procurement.search",
        "В профиле нет ключевых слов для поиска.",
      );
    }
    const sourceIds = options.sourcesForWorkspace?.(options.activeWorkspaceId?.()) ?? defaultSourceIds;
    const pages = await Promise.all(
      sourceIds.map(async (sourceId) => {
        try {
          return await client.search(
            ProcurementSearchRequest.parse({ sourceId, ...query }),
            RequestId.parse(randomUUID()),
          );
        } catch (error) {
          logger.warn("Source search failed — returning an empty page", {
            sourceId,
            err: error instanceof Error ? error.message : String(error),
          });
          return { hits: [] as readonly SearchHit[], hasMore: false };
        }
      }),
    );
    return {
      hits: mergeHits(pages.flatMap((page) => page.hits)),
      hasMore: pages.some((page) => page.hasMore === true),
    };
  };

  return {
    async search(query: Omit<SearchQuery, "sourceId">): Promise<readonly SearchHit[]> {
      return (await call(query)).hits;
    },
    async searchDetailed(
      query: Omit<SearchQuery, "sourceId">,
    ): Promise<{ hits: readonly SearchHit[]; hasMore?: boolean }> {
      const response = await call(query);
      return { hits: response.hits, hasMore: response.hasMore };
    },
  };
}

/**
 * Cross-source order: newest publication first, undated rows last. Sources
 * cannot collide on sourceProcurementId — each carries its own prefix — so
 * no dedup key exists across platforms until a GIAS link is implemented.
 */
function mergeHits(hits: readonly SearchHit[]): readonly SearchHit[] {
  const key = (hit: SearchHit): string => {
    const at = hit.publishedAt;
    if (at === undefined) return "";
    return at.precision === "date" ? at.date : at.at;
  };
  return [...hits].sort((left, right) => key(right).localeCompare(key(left)));
}
