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
 * a source that times out or errors keeps the others' hits but is named in
 * `failedSources` — a background pass must not treat a partially-read window
 * as covered. When every lane fails the error propagates: an empty page is
 * not an honest answer for a total outage.
 * Hits merge by publication date; `hasMore` ORs across sources so a
 * truncated lane keeps paging alive.
 *
 * Lanes fan out in parallel: each source is served by its own MCP child
 * (the routing caller), so a lane gets its own pipe, queue and full timeout
 * budget — a slow source can no longer starve a healthy sibling.
 */
export function createProcurementSearchHits(
  options: ProcurementSearchHitsOptions,
): {
  search: (query: Omit<SearchQuery, "sourceId">) => Promise<readonly SearchHit[]>;
  searchDetailed: (
    query: Omit<SearchQuery, "sourceId">,
  ) => Promise<{
    hits: readonly SearchHit[];
    hasMore?: boolean;
    /** Sources whose call failed — their window is unread, not empty. */
    failedSources?: readonly string[];
  }>;
} {
  const logger = options.logger ?? silentLogger;
  const defaultSourceIds: readonly SourceIdValue[] =
    options.sourceIds ?? [SourceId.parse("goszakupki_by")];
  const client = new ProcurementMcpClient({
    caller: options.caller,
    policyGate: new ToolPolicyGate({
      agentAllowedTools: ["procurement.search"],
    }),
    // Scan budget plus queue headroom on the source's own pipe: a bounded
    // registry scan runs ~90 s, and the call may still sit behind card
    // lookups of the same source before it even starts.
    timeoutMs: options.timeoutMs ?? 240_000,
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
    const lanes = await Promise.all(
      sourceIds.map(async (sourceId) => {
        try {
          const page = await client.search(
            ProcurementSearchRequest.parse({ sourceId, ...query }),
            RequestId.parse(randomUUID()),
          );
          return { sourceId, page, error: undefined };
        } catch (error) {
          logger.warn("Source search failed — lane reported as failed", {
            sourceId,
            err: error instanceof Error ? error.message : String(error),
          });
          return { sourceId, page: undefined, error };
        }
      }),
    );
    const failures = lanes.filter((lane) => lane.page === undefined);
    if (lanes.length > 0 && failures.length === lanes.length) {
      throw failures[0]?.error;
    }
    return {
      hits: mergeHits(lanes.flatMap((lane) => lane.page?.hits ?? [])),
      hasMore: lanes.some((lane) => lane.page?.hasMore === true),
      failedSources: failures.map((lane) => lane.sourceId as string),
    };
  };

  return {
    async search(query: Omit<SearchQuery, "sourceId">): Promise<readonly SearchHit[]> {
      return (await call(query)).hits;
    },
    async searchDetailed(
      query: Omit<SearchQuery, "sourceId">,
    ): Promise<{
      hits: readonly SearchHit[];
      hasMore?: boolean;
      failedSources?: readonly string[];
    }> {
      const response = await call(query);
      return {
        hits: response.hits,
        hasMore: response.hasMore,
        failedSources: response.failedSources,
      };
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
