import {
  AgentRunInput,
  AgentRunOutput,
  DocumentIngestInput,
  DocumentIngestOutput,
  type AgentDefinition,
  type AgentRunInput as AgentRunInputValue,
  type AgentRunOutput as AgentRunOutputValue,
  type CapabilityId,
  type DocumentsExtractTextResponse,
  type IngestedDocument,
  type SourceDocument,
} from "@procurement/contracts";
import { ocrNeedsHuman, resolveContentVersion } from "@procurement/domain";
import {
  DocumentsMcpClient,
  McpToolCallError,
  ProcurementMcpClient,
  ToolPolicyDeniedError,
  ToolPolicyGate,
  type McpToolCaller,
} from "@procurement/mcp-client";
import { silentLogger, type Logger } from "@procurement/observability";
import { capabilityRegistry } from "../../registry/capabilities.js";

export interface DocumentAgentOptions {
  caller: McpToolCaller;
  registry?: Readonly<Record<CapabilityId, AgentDefinition>>;
  logger?: Logger;
  clock?: () => Date;
}

export class DocumentAgent {
  readonly #caller: McpToolCaller;
  readonly #registry: Readonly<Record<CapabilityId, AgentDefinition>>;
  readonly #logger: Logger;
  readonly #clock: () => Date;
  readonly #seen = new Map<string, { hash: string; version: number }>();

  constructor(options: DocumentAgentOptions) {
    this.#caller = options.caller;
    this.#registry = options.registry ?? capabilityRegistry;
    this.#logger = options.logger ?? silentLogger;
    this.#clock = options.clock ?? (() => new Date());
  }

  async run(rawInput: unknown): Promise<AgentRunOutputValue> {
    const input = AgentRunInput.parse(rawInput);
    const logger = this.#logger.child({
      requestId: input.requestId,
      runId: input.runId,
      agentId: "document_ingest",
      component: "document-agent",
    });
    if (input.capability !== "document_ingest") {
      throw new Error(`DocumentAgent cannot run capability ${input.capability}`);
    }
    const agent = this.#registry.document_ingest;
    const payload = DocumentIngestInput.parse(input.input ?? {});
    const sourceId = payload.sourceId ?? input.context.procurement?.sourceId;
    const sourceProcurementId =
      payload.sourceProcurementId ?? input.context.procurement?.sourceProcurementId;
    if (sourceId === undefined || sourceProcurementId === undefined) {
      return escalateRun(input, "Для загрузки документов нужна выбранная закупка.");
    }

    const gate = new ToolPolicyGate({ agentAllowedTools: input.context.allowedTools });
    const procurement = new ProcurementMcpClient({
      caller: this.#caller,
      policyGate: gate,
      timeoutMs: agent.timeoutMs,
      logger,
    });
    const documents = new DocumentsMcpClient({
      caller: this.#caller,
      policyGate: gate,
      timeoutMs: agent.timeoutMs,
      logger,
    });

    let sourceDocuments: SourceDocument[];
    try {
      sourceDocuments = (
        await procurement.getDocuments({ sourceId, sourceProcurementId }, input.requestId)
      ).documents;
    } catch (error) {
      logger.error("Document list MCP call failed", error);
      return failedRun(input, error);
    }

    const ingested: IngestedDocument[] = [];
    let needsHuman = false;
    let humanQuestion: string | undefined;

    for (const source of sourceDocuments) {
      const sourceUrl = source.downloadUrl ?? source.sourceUrl;
      try {
        const downloaded = await documents.download({ sourceUrl }, input.requestId);
        const previous = this.#seen.get(sourceUrl);
        const version = resolveContentVersion({
          newHash: downloaded.hash,
          ...(previous === undefined
            ? {}
            : { previousHash: previous.hash, previousVersion: previous.version }),
        });
        this.#seen.set(sourceUrl, { hash: downloaded.hash, version: version.version });
        if (version.status === "unchanged") {
          ingested.push({
            name: source.name,
            sourceUrl,
            hash: downloaded.hash,
            storageKey: downloaded.storageKey,
            version: version.version,
            unchanged: true,
            status: "extracted",
            ocrApplied: false,
            confidence: 1,
            pageCount: 0,
            tableCount: 0,
            textPreview: "Содержимое не изменилось, повторное извлечение не выполнялось.",
          });
          continue;
        }

        let text = await documents.extractText({ hash: downloaded.hash }, input.requestId);
        if (text.status === "ocr_required") {
          text = await documents.ocr({ hash: downloaded.hash }, input.requestId);
        }
        const tables = await documents.extractTables({ hash: downloaded.hash }, input.requestId);
        const lowOcr =
          text.status === "ocr_low_confidence" ||
          (text.ocrApplied && ocrNeedsHuman(text.confidence, agent.minConfidence));
        if (lowOcr) {
          needsHuman = true;
          humanQuestion =
            "Документ похож на скан и читается плохо. Проверьте условия вручную по оригиналу.";
        }
        ingested.push(toIngested(source.name, sourceUrl, downloaded, version.version, text, tables));
      } catch (error) {
        logger.error("Document ingest failed", error);
        return failedRun(input, error);
      }
    }

    const output = DocumentIngestOutput.parse({
      documents: ingested,
      extractedCount: ingested.filter((item) => !item.unchanged).length,
      unchangedCount: ingested.filter((item) => item.unchanged).length,
      ocrCount: ingested.filter((item) => item.ocrApplied).length,
      ingestedAt: this.#clock().toISOString(),
    });
    logger.info("Document ingest completed", {
      documentCount: ingested.length,
      extractedCount: output.extractedCount,
      ocrCount: output.ocrCount,
    });
    return AgentRunOutput.parse({
      runId: input.runId,
      status: needsHuman ? "needs_human" : "success",
      confidence: ingested.length === 0 ? 1 : Math.min(...ingested.map((item) => item.confidence)),
      payload: output,
      ...(humanQuestion === undefined ? {} : { humanQuestion }),
      ...(output.extractedCount > 0 && !needsHuman
        ? { nextRecommendedCapability: "commercial_terms" }
        : {}),
    });
  }
}

function toIngested(
  name: string,
  sourceUrl: string,
  downloaded: { hash: string; storageKey: string },
  version: number,
  text: DocumentsExtractTextResponse,
  tables: { tables: unknown[] },
): IngestedDocument {
  return {
    name,
    sourceUrl,
    hash: downloaded.hash,
    storageKey: downloaded.storageKey as IngestedDocument["storageKey"],
    version,
    unchanged: false,
    status: text.status,
    ocrApplied: text.ocrApplied,
    confidence: text.confidence,
    pageCount: text.pages.length,
    tableCount: tables.tables.length,
    textPreview: text.text.slice(0, 240),
  };
}

function escalateRun(input: AgentRunInputValue, humanQuestion: string): AgentRunOutputValue {
  return AgentRunOutput.parse({
    runId: input.runId,
    status: "needs_human",
    confidence: 0,
    payload: {},
    humanQuestion,
  });
}

function failedRun(input: AgentRunInputValue, error: unknown): AgentRunOutputValue {
  if (error instanceof ToolPolicyDeniedError) {
    return AgentRunOutput.parse({
      runId: input.runId,
      status: "failed",
      confidence: 0,
      payload: {},
      error: {
        kind: "permission_denied",
        message: error.message,
        toolName: error.toolName,
      },
    });
  }
  const toolError = error instanceof McpToolCallError ? error : undefined;
  const kind =
    toolError?.kind === "timeout"
      ? "timeout"
      : toolError?.kind === "invalid_output"
        ? "invalid_output"
        : "retryable";
  return AgentRunOutput.parse({
    runId: input.runId,
    status: "failed",
    confidence: 0,
    payload: {},
    error: {
      kind,
      message: error instanceof Error ? error.message : String(error),
      ...(toolError === undefined ? {} : { toolName: toolError.toolName }),
    },
  });
}
