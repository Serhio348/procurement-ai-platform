import { McpToolCallError, type McpToolCaller } from "./call-tool.js";

export interface SourceRoutingCallerOptions {
  /** Serialized callers keyed by the source their child process serves. */
  callers: ReadonlyMap<string, McpToolCaller>;
  /** Calls without a sourceId (procurement.sources) go here. */
  fallback: McpToolCaller;
  /**
   * Sources that were configured but whose child never connected: their
   * calls fail as source_unavailable instead of leaking to another lane.
   */
  missing?: ReadonlySet<string>;
}

/**
 * Dispatches each call to the per-source MCP child by `arguments.sourceId`.
 * Every procurement tool carries that field — including download — so the
 * only sourceless tool is `procurement.sources`, which the caller probes
 * per child instead.
 */
export function createSourceRoutingCaller(options: SourceRoutingCallerOptions): McpToolCaller {
  return {
    callTool(toolName, argumentsValue, callOptions) {
      const sourceId = (argumentsValue as { sourceId?: unknown }).sourceId;
      if (typeof sourceId === "string" && sourceId.length > 0) {
        const target = options.callers.get(sourceId);
        if (target !== undefined) {
          return target.callTool(toolName, argumentsValue, callOptions);
        }
        if (options.missing?.has(sourceId) === true) {
          return Promise.reject(
            new McpToolCallError(
              "source_unavailable",
              toolName,
              `Procurement source ${sourceId} is not connected`,
            ),
          );
        }
      }
      return options.fallback.callTool(toolName, argumentsValue, callOptions);
    },
  };
}
