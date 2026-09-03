import {
  DocumentsDownloadRequest,
  DocumentsDownloadResponse,
  DocumentsExtractTablesResponse,
  DocumentsExtractTextResponse,
  DocumentsGetPageRequest,
  DocumentsGetPageResponse,
  DocumentsListRequest,
  DocumentsListResponse,
  DocumentsSearchRequest,
  DocumentsSearchResponse,
  FilesExistsRequest,
  FilesExistsResponse,
  FilesGetRequest,
  FilesGetResponse,
  FilesPutRequest,
  FilesPutResponse,
  type McpToolName,
  type RequestId,
  type DocumentsDownloadResponse as DocumentsDownloadResponseValue,
  type DocumentsExtractTablesResponse as DocumentsExtractTablesResponseValue,
  type DocumentsExtractTextResponse as DocumentsExtractTextResponseValue,
  type DocumentsGetPageRequest as DocumentsGetPageRequestValue,
  type DocumentsGetPageResponse as DocumentsGetPageResponseValue,
  type DocumentsListResponse as DocumentsListResponseValue,
  type DocumentsSearchRequest as DocumentsSearchRequestValue,
  type DocumentsSearchResponse as DocumentsSearchResponseValue,
  type FilesExistsRequest as FilesExistsRequestValue,
  type FilesExistsResponse as FilesExistsResponseValue,
  type FilesGetRequest as FilesGetRequestValue,
  type FilesGetResponse as FilesGetResponseValue,
  type FilesPutResponse as FilesPutResponseValue,
} from "@procurement/contracts";
import type { z } from "zod";
import type { Logger } from "@procurement/observability";
import { silentLogger } from "@procurement/observability";
import { callValidatedTool, type McpToolCaller } from "./call-tool.js";
import type { ToolPolicyGate } from "./tool-policy.js";

export interface DocumentsMcpClientOptions {
  caller: McpToolCaller;
  policyGate: ToolPolicyGate;
  timeoutMs?: number;
  logger?: Logger;
}

export class DocumentsMcpClient {
  readonly #caller: McpToolCaller;
  readonly #policyGate: ToolPolicyGate;
  readonly #timeoutMs: number;
  readonly #logger: Logger;

  constructor(options: DocumentsMcpClientOptions) {
    this.#caller = options.caller;
    this.#policyGate = options.policyGate;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#logger = options.logger ?? silentLogger;
  }

  putFile(
    input: z.input<typeof FilesPutRequest>,
    requestId: RequestId,
  ): Promise<FilesPutResponseValue> {
    return this.#call("files.put", input, FilesPutRequest, FilesPutResponse, requestId);
  }

  getFile(input: FilesGetRequestValue, requestId: RequestId): Promise<FilesGetResponseValue> {
    return this.#call("files.get", input, FilesGetRequest, FilesGetResponse, requestId);
  }

  exists(input: FilesExistsRequestValue, requestId: RequestId): Promise<FilesExistsResponseValue> {
    return this.#call("files.exists", input, FilesExistsRequest, FilesExistsResponse, requestId);
  }

  download(
    input: z.input<typeof DocumentsDownloadRequest>,
    requestId: RequestId,
  ): Promise<DocumentsDownloadResponseValue> {
    return this.#call(
      "documents.download",
      input,
      DocumentsDownloadRequest,
      DocumentsDownloadResponse,
      requestId,
    );
  }

  extractText(
    input: FilesGetRequestValue,
    requestId: RequestId,
  ): Promise<DocumentsExtractTextResponseValue> {
    return this.#call(
      "documents.extract_text",
      input,
      FilesGetRequest,
      DocumentsExtractTextResponse,
      requestId,
    );
  }

  extractTables(
    input: FilesGetRequestValue,
    requestId: RequestId,
  ): Promise<DocumentsExtractTablesResponseValue> {
    return this.#call(
      "documents.extract_tables",
      input,
      FilesGetRequest,
      DocumentsExtractTablesResponse,
      requestId,
    );
  }

  ocr(
    input: FilesGetRequestValue,
    requestId: RequestId,
  ): Promise<DocumentsExtractTextResponseValue> {
    return this.#call("documents.ocr", input, FilesGetRequest, DocumentsExtractTextResponse, requestId);
  }

  getPage(
    input: DocumentsGetPageRequestValue,
    requestId: RequestId,
  ): Promise<DocumentsGetPageResponseValue> {
    return this.#call(
      "documents.get_page",
      input,
      DocumentsGetPageRequest,
      DocumentsGetPageResponse,
      requestId,
    );
  }

  search(
    input: DocumentsSearchRequestValue,
    requestId: RequestId,
  ): Promise<DocumentsSearchResponseValue> {
    return this.#call(
      "documents.search",
      input,
      DocumentsSearchRequest,
      DocumentsSearchResponse,
      requestId,
    );
  }

  list(requestId: RequestId): Promise<DocumentsListResponseValue> {
    return this.#call("documents.list", {}, DocumentsListRequest, DocumentsListResponse, requestId);
  }

  #call<Input extends Record<string, unknown>, Output>(
    toolName: McpToolName,
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
