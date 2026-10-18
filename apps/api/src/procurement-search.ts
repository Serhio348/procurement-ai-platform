import { randomUUID } from "node:crypto";
import {
  ProcurementSearchRequest,
  ProcurementSearchResponse,
  RequestId,
  type SearchQuery,
  SourceId,
  type SearchHit,
  type SourceId as SourceIdValue,
} from "@procurement/contracts";
import {
  callValidatedTool,
  McpToolCallError,
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
    options?: {
      cursors?: Readonly<Record<string, string>>;
      timeoutMs?: number;
      allowEmpty?: boolean;
      signal?: AbortSignal;
    },
  ) => Promise<{
    hits: readonly SearchHit[];
    hasMore?: boolean;
    /** Sources whose call failed — their window is unread, not empty. */
    failedSources?: readonly string[];
    /** Per-source resume tokens for lanes still truncated mid-window. */
    cursors: Record<string, string>;
  }>;
} {
  const logger = options.logger ?? silentLogger;
  const defaultSourceIds: readonly SourceIdValue[] =
    options.sourceIds ?? [SourceId.parse("goszakupki_by")];
  const policyGate = new ToolPolicyGate({
    agentAllowedTools: ["procurement.search"],
  });
  // Scan budget plus queue headroom on the source's own pipe: a bounded
  // registry scan runs up to ~180 s, and the call may still sit behind
  // card lookups of the same source before it even starts. Callers running
  // several stages inside one operation pass the *remainder* per call.
  const defaultTimeoutMs = options.timeoutMs ?? 300_000;

  const call = async (
    query: Omit<SearchQuery, "sourceId">,
    callOptions?: {
      cursors?: Readonly<Record<string, string>>;
      timeoutMs?: number;
      allowEmpty?: boolean;
      signal?: AbortSignal;
    },
  ) => {
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
          const scanCursor = callOptions?.cursors?.[sourceId];
          const request = ProcurementSearchRequest.parse({
            sourceId,
            ...query,
            ...(scanCursor === undefined ? {} : { scanCursor }),
          });
          // Sequential stages of one operation pass their remaining budget —
          // the per-call timeoutMs is a share of a deadline, never a fresh
          // full budget.
          const page = await callValidatedTool({
            toolName: "procurement.search",
            input: request,
            inputSchema: ProcurementSearchRequest,
            outputSchema: ProcurementSearchResponse,
            caller: options.caller,
            policyGate,
            requestId: RequestId.parse(randomUUID()),
            timeoutMs: callOptions?.timeoutMs ?? defaultTimeoutMs,
            ...(callOptions?.signal === undefined ? {} : { signal: callOptions.signal }),
            logger,
          });
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
    if (lanes.length > 0 && failures.length === lanes.length && callOptions?.allowEmpty !== true) {
      throw failures[0]?.error;
    }
    return {
      hits: mergeHits(lanes.flatMap((lane) => lane.page?.hits ?? [])),
      hasMore: lanes.some((lane) => lane.page?.hasMore === true),
      failedSources: failures.map((lane) => lane.sourceId as string),
      // A lane that finished its window stops reporting a token — the key
      // simply disappears, clearing the resume position.
      cursors: Object.fromEntries(
        lanes.flatMap((lane) =>
          lane.page?.scanCursor === undefined ? [] : [[lane.sourceId, lane.page.scanCursor]],
        ),
      ),
    };
  };

  return {
    async search(query: Omit<SearchQuery, "sourceId">): Promise<readonly SearchHit[]> {
      return (await call(query)).hits;
    },
    async searchDetailed(
      query: Omit<SearchQuery, "sourceId">,
      callOptions?: {
        cursors?: Readonly<Record<string, string>>;
        timeoutMs?: number;
        allowEmpty?: boolean;
        signal?: AbortSignal;
      },
    ): Promise<{
      hits: readonly SearchHit[];
      hasMore?: boolean;
      failedSources?: readonly string[];
      cursors: Record<string, string>;
    }> {
      const response = await call(query, callOptions);
      return {
        hits: response.hits,
        hasMore: response.hasMore,
        failedSources: response.failedSources,
        cursors: response.cursors,
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
