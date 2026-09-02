import {
  ProcurementGetChangesRequest,
  ProcurementGetChangesResponse,
  ProcurementGetDocumentsResponse,
  ProcurementGetHistoryResponse,
  ProcurementGetLotsResponse,
  ProcurementGetRequest,
  ProcurementGetResponse,
  ProcurementGetStatusResponse,
  ProcurementSearchRequest,
  ProcurementSearchResponse,
  type ProcurementSourcePort,
} from "@procurement/contracts";
import type { Logger } from "@procurement/observability";
import { silentLogger } from "@procurement/observability";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZodError } from "zod";
import {
  ProcurementSourceRegistry,
  SourceRecordNotFoundError,
  SourceUnavailableError,
} from "./source-registry.js";

export interface ProcurementMcpServerOptions {
  sources: readonly ProcurementSourcePort[];
  logger?: Logger;
}

export function createProcurementMcpServer(options: ProcurementMcpServerOptions): McpServer {
  const registry = new ProcurementSourceRegistry(options.sources);
  const logger = options.logger ?? silentLogger;
  const server = new McpServer({
    name: "procurement",
    version: "0.1.0",
  });

  server.registerTool(
    "procurement.search",
    {
      description: "Search a configured procurement source using a source-neutral query.",
      inputSchema: ProcurementSearchRequest,
      outputSchema: ProcurementSearchResponse,
      annotations: readOnlyOpenWorld,
    },
    async (input, extra) =>
      executeTool("procurement.search", logger, correlationId(extra), async () => {
        const request = ProcurementSearchRequest.parse(input);
        const output = await registry.get(request.sourceId).search(request);
        return ProcurementSearchResponse.parse(output);
      }),
  );

  server.registerTool(
    "procurement.get",
    {
      description: "Fetch a procurement procedure card by source record id.",
      inputSchema: ProcurementGetRequest,
      outputSchema: ProcurementGetResponse,
      annotations: readOnlyOpenWorld,
    },
    async (input, extra) =>
      executeTool("procurement.get", logger, correlationId(extra), async () => {
        const request = ProcurementGetRequest.parse(input);
        const output = await registry.get(request.sourceId).get(request.sourceProcurementId);
        return ProcurementGetResponse.parse(output);
      }),
  );

  server.registerTool(
    "procurement.get_status",
    {
      description: "Fetch normalized and original status fields for a procurement.",
      inputSchema: ProcurementGetRequest,
      outputSchema: ProcurementGetStatusResponse,
      annotations: readOnlyOpenWorld,
    },
    async (input, extra) =>
      executeTool("procurement.get_status", logger, correlationId(extra), async () => {
        const request = ProcurementGetRequest.parse(input);
        const output = await registry.get(request.sourceId).getStatus(request.sourceProcurementId);
        return ProcurementGetStatusResponse.parse(output);
      }),
  );

  server.registerTool(
    "procurement.get_lots",
    {
      description: "Fetch procurement lots and their positions.",
      inputSchema: ProcurementGetRequest,
      outputSchema: ProcurementGetLotsResponse,
      annotations: readOnlyOpenWorld,
    },
    async (input, extra) =>
      executeTool("procurement.get_lots", logger, correlationId(extra), async () => {
        const request = ProcurementGetRequest.parse(input);
        const output = await registry.get(request.sourceId).getLots(request.sourceProcurementId);
        return ProcurementGetLotsResponse.parse(output);
      }),
  );

  server.registerTool(
    "procurement.get_documents",
    {
      description: "List public documents advertised by a procurement source.",
      inputSchema: ProcurementGetRequest,
      outputSchema: ProcurementGetDocumentsResponse,
      annotations: readOnlyOpenWorld,
    },
    async (input, extra) =>
      executeTool("procurement.get_documents", logger, correlationId(extra), async () => {
        const request = ProcurementGetRequest.parse(input);
        const output = await registry
          .get(request.sourceId)
          .getDocuments(request.sourceProcurementId);
        return ProcurementGetDocumentsResponse.parse(output);
      }),
  );

  server.registerTool(
    "procurement.get_history",
    {
      description: "Fetch procurement clarifications and public history.",
      inputSchema: ProcurementGetRequest,
      outputSchema: ProcurementGetHistoryResponse,
      annotations: readOnlyOpenWorld,
    },
    async (input, extra) =>
      executeTool("procurement.get_history", logger, correlationId(extra), async () => {
        const request = ProcurementGetRequest.parse(input);
        const output = await registry.get(request.sourceId).getHistory(request.sourceProcurementId);
        return ProcurementGetHistoryResponse.parse(output);
      }),
  );

  server.registerTool(
    "procurement.get_changes",
    {
      description: "Fetch source changes detected after an optional timestamp.",
      inputSchema: ProcurementGetChangesRequest,
      outputSchema: ProcurementGetChangesResponse,
      annotations: readOnlyOpenWorld,
    },
    async (input, extra) =>
      executeTool("procurement.get_changes", logger, correlationId(extra), async () => {
        const request = ProcurementGetChangesRequest.parse(input);
        const output = await registry
          .get(request.sourceId)
          .getChanges(request.sourceProcurementId, request.since);
        return ProcurementGetChangesResponse.parse(output);
      }),
  );

  return server;
}

const readOnlyOpenWorld = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

async function executeTool<Output extends Record<string, unknown>>(
  toolName: string,
  logger: Logger,
  requestId: string,
  operation: () => Promise<Output>,
) {
  const toolLogger = logger.child({
    requestId,
    toolName,
    component: "procurement-mcp",
  });
  const startedAt = Date.now();
  try {
    const output = await operation();
    toolLogger.info("Procurement tool completed", { durationMs: Date.now() - startedAt });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output) }],
      structuredContent: output,
    };
  } catch (error) {
    toolLogger.error("Procurement tool failed", error, { durationMs: Date.now() - startedAt });
    return {
      content: [{ type: "text" as const, text: publicErrorMessage(error) }],
      isError: true,
      _meta: { errorKind: classifyError(error) },
    };
  }
}

function correlationId(extra: { _meta?: Record<string, unknown>; requestId: string | number }): string {
  const requestId = extra._meta?.["requestId"];
  return typeof requestId === "string" && requestId.length > 0
    ? requestId
    : String(extra.requestId);
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Procurement tool failed";
}

function classifyError(
  error: unknown,
): "not_found" | "source_unavailable" | "invalid_request" | "internal" {
  if (error instanceof SourceRecordNotFoundError) return "not_found";
  if (error instanceof SourceUnavailableError) return "source_unavailable";
  if (error instanceof ZodError) return "invalid_request";
  return "internal";
}
