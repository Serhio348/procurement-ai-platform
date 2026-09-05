import {
  ProcurementDownloadRequest,
  ProcurementDownloadResponse,
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
  type RequestId,
  type ProcurementDownloadRequest as ProcurementDownloadRequestValue,
  type ProcurementDownloadResponse as ProcurementDownloadResponseValue,
  type ProcurementGetChangesRequest as ProcurementGetChangesRequestValue,
  type ProcurementGetChangesResponse as ProcurementGetChangesResponseValue,
  type ProcurementGetDocumentsResponse as ProcurementGetDocumentsResponseValue,
  type ProcurementGetHistoryResponse as ProcurementGetHistoryResponseValue,
  type ProcurementGetLotsResponse as ProcurementGetLotsResponseValue,
  type ProcurementGetRequest as ProcurementGetRequestValue,
  type ProcurementGetResponse as ProcurementGetResponseValue,
  type ProcurementGetStatusResponse as ProcurementGetStatusResponseValue,
  type ProcurementSearchRequest as ProcurementSearchRequestValue,
  type ProcurementSearchResponse as ProcurementSearchResponseValue,
} from "@procurement/contracts";
import type { Logger } from "@procurement/observability";
import { silentLogger } from "@procurement/observability";
import { callValidatedTool, type McpToolCaller } from "./call-tool.js";
import type { ToolPolicyGate } from "./tool-policy.js";

export interface ProcurementMcpClientOptions {
  caller: McpToolCaller;
  policyGate: ToolPolicyGate;
  timeoutMs?: number;
  logger?: Logger;
}

export class ProcurementMcpClient {
  readonly #caller: McpToolCaller;
  readonly #policyGate: ToolPolicyGate;
  readonly #timeoutMs: number;
  readonly #logger: Logger;

  constructor(options: ProcurementMcpClientOptions) {
    this.#caller = options.caller;
    this.#policyGate = options.policyGate;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#logger = options.logger ?? silentLogger;
  }

  search(
    input: ProcurementSearchRequestValue,
    requestId: RequestId,
  ): Promise<ProcurementSearchResponseValue> {
    return this.#call(
      "procurement.search",
      input,
      ProcurementSearchRequest,
      ProcurementSearchResponse,
      requestId,
    );
  }

  get(
    input: ProcurementGetRequestValue,
    requestId: RequestId,
  ): Promise<ProcurementGetResponseValue> {
    return this.#call(
      "procurement.get",
      input,
      ProcurementGetRequest,
      ProcurementGetResponse,
      requestId,
    );
  }

  getStatus(
    input: ProcurementGetRequestValue,
    requestId: RequestId,
  ): Promise<ProcurementGetStatusResponseValue> {
    return this.#call(
      "procurement.get_status",
      input,
      ProcurementGetRequest,
      ProcurementGetStatusResponse,
      requestId,
    );
  }

  getLots(
    input: ProcurementGetRequestValue,
    requestId: RequestId,
  ): Promise<ProcurementGetLotsResponseValue> {
    return this.#call(
      "procurement.get_lots",
      input,
      ProcurementGetRequest,
      ProcurementGetLotsResponse,
      requestId,
    );
  }

  getDocuments(
    input: ProcurementGetRequestValue,
    requestId: RequestId,
  ): Promise<ProcurementGetDocumentsResponseValue> {
    return this.#call(
      "procurement.get_documents",
      input,
      ProcurementGetRequest,
      ProcurementGetDocumentsResponse,
      requestId,
    );
  }

  getHistory(
    input: ProcurementGetRequestValue,
    requestId: RequestId,
  ): Promise<ProcurementGetHistoryResponseValue> {
    return this.#call(
      "procurement.get_history",
      input,
      ProcurementGetRequest,
      ProcurementGetHistoryResponse,
      requestId,
    );
  }

  getChanges(
    input: ProcurementGetChangesRequestValue,
    requestId: RequestId,
  ): Promise<ProcurementGetChangesResponseValue> {
    return this.#call(
      "procurement.get_changes",
      input,
      ProcurementGetChangesRequest,
      ProcurementGetChangesResponse,
      requestId,
    );
  }

  download(
    input: ProcurementDownloadRequestValue,
    requestId: RequestId,
  ): Promise<ProcurementDownloadResponseValue> {
    return this.#call(
      "procurement.download",
      input,
      ProcurementDownloadRequest,
      ProcurementDownloadResponse,
      requestId,
    );
  }

  #call<Input extends Record<string, unknown>, Output>(
    toolName:
      | "procurement.search"
      | "procurement.get"
      | "procurement.get_status"
      | "procurement.get_lots"
      | "procurement.get_documents"
      | "procurement.get_history"
      | "procurement.get_changes"
      | "procurement.download",
    input: Input,
    inputSchema: Parameters<typeof callValidatedTool<Input, Output>>[0]["inputSchema"],
    outputSchema: Parameters<typeof callValidatedTool<Input, Output>>[0]["outputSchema"],
    requestId: RequestId,
  ): Promise<Output> {
    return callValidatedTool({
      toolName,
      input,
      inputSchema,
      outputSchema,
      caller: this.#caller,
      policyGate: this.#policyGate,
      requestId,
      timeoutMs: this.#timeoutMs,
      logger: this.#logger,
    });
  }
}
