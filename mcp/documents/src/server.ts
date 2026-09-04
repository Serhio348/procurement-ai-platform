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
} from "@procurement/contracts";
import type { Logger } from "@procurement/observability";
import { silentLogger } from "@procurement/observability";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZodError } from "zod";
import { MemoryBlobStore } from "./blob-store.js";
import type { DocumentExtractorPort } from "./extractor-port.js";
import {
  DocumentSourceNotFoundError,
  DocumentTooLargeError,
  type FixtureDocumentCatalog,
} from "./fixture-catalog.js";

export interface DocumentsMcpServerOptions {
  store?: MemoryBlobStore;
  catalog: FixtureDocumentCatalog;
  extractor?: DocumentExtractorPort;
  logger?: Logger;
}

const readOnlyOpenWorld = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const writeIdempotent = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function createDocumentsMcpServer(options: DocumentsMcpServerOptions): McpServer {
  const store = options.store ?? new MemoryBlobStore();
  const catalog = options.catalog;
  const extractor = options.extractor ?? catalog;
  const logger = options.logger ?? silentLogger;
  const extractions = new Map<
    string,
    {
      text: DocumentsExtractTextResponse;
      tables: DocumentsExtractTablesResponse;
    }
  >();
  const server = new McpServer({
    name: "documents",
    version: "0.1.0",
  });

  server.registerTool(
    "files.put",
    {
      description: "Store a document blob by sha256. Identical bytes are not duplicated.",
      inputSchema: FilesPutRequest,
      outputSchema: FilesPutResponse,
      annotations: writeIdempotent,
    },
    async (input, extra) =>
      executeTool("files.put", logger, correlationId(extra), () => {
        const request = FilesPutRequest.parse(input);
        const bytes = decodeBase64(request.bytesBase64);
        const stored = store.put(bytes, request.contentType);
        return FilesPutResponse.parse({
          hash: stored.hash,
          storageKey: stored.storageKey,
          sizeBytes: stored.bytes.byteLength,
        });
      }),
  );

  server.registerTool(
    "files.get",
    {
      description: "Read a previously stored document blob.",
      inputSchema: FilesGetRequest,
      outputSchema: FilesGetResponse,
      annotations: readOnlyOpenWorld,
    },
    async (input, extra) =>
      executeTool("files.get", logger, correlationId(extra), () => {
        const request = FilesGetRequest.parse(input);
        const stored = requireBlob(store, request.hash);
        return FilesGetResponse.parse({
          hash: stored.hash,
          storageKey: stored.storageKey,
          sizeBytes: stored.bytes.byteLength,
          contentType: stored.contentType,
          bytesBase64: Buffer.from(stored.bytes).toString("base64"),
        });
      }),
  );

  server.registerTool(
    "files.exists",
    {
      description: "Check whether a sha256 blob is already stored.",
      inputSchema: FilesExistsRequest,
      outputSchema: FilesExistsResponse,
      annotations: readOnlyOpenWorld,
    },
    async (input, extra) =>
      executeTool("files.exists", logger, correlationId(extra), () => {
        const request = FilesExistsRequest.parse(input);
        return FilesExistsResponse.parse({ exists: store.exists(request.hash) });
      }),
  );

  server.registerTool(
    "documents.download",
    {
      description: "Download a source document into content-addressed storage.",
      inputSchema: DocumentsDownloadRequest,
      outputSchema: DocumentsDownloadResponse,
      annotations: writeIdempotent,
    },
    async (input, extra) =>
      executeTool("documents.download", logger, correlationId(extra), () => {
        const request = DocumentsDownloadRequest.parse(input);
        const item = catalog.download(request.sourceUrl);
        if (item.bytes.byteLength > request.maxBytes) {
          throw new DocumentTooLargeError(item.bytes.byteLength, request.maxBytes);
        }
        const stored = store.put(item.bytes, item.contentType);
        return DocumentsDownloadResponse.parse({
          hash: stored.hash,
          storageKey: stored.storageKey,
          sizeBytes: stored.bytes.byteLength,
          contentType: stored.contentType,
        });
      }),
  );

  server.registerTool(
    "documents.extract_text",
    {
      description: "Extract text from a stored blob without inventing missing OCR.",
      inputSchema: FilesGetRequest,
      outputSchema: DocumentsExtractTextResponse,
      annotations: readOnlyOpenWorld,
    },
    async (input, extra) =>
      executeTool("documents.extract_text", logger, correlationId(extra), async () => {
        const request = FilesGetRequest.parse(input);
        const stored = requireBlob(store, request.hash);
        const text = await safeExtract(extractor, "extractText", stored);
        const tables = await safeExtract(extractor, "extractTables", stored);
        extractions.set(stored.hash, { text, tables });
        return text;
      }),
  );

  server.registerTool(
    "documents.extract_tables",
    {
      description: "Extract tables from a stored blob.",
      inputSchema: FilesGetRequest,
      outputSchema: DocumentsExtractTablesResponse,
      annotations: readOnlyOpenWorld,
    },
    async (input, extra) =>
      executeTool("documents.extract_tables", logger, correlationId(extra), async () => {
        const request = FilesGetRequest.parse(input);
        const stored = requireBlob(store, request.hash);
        const tables = await safeExtract(extractor, "extractTables", stored);
        const current = extractions.get(stored.hash);
        extractions.set(stored.hash, {
          text:
            current?.text ??
            DocumentsExtractTextResponse.parse({
              hash: stored.hash,
              status: "extracted",
              text: "",
              pages: [],
              ocrApplied: false,
              confidence: 0,
            }),
          tables,
        });
        return tables;
      }),
  );

  server.registerTool(
    "documents.ocr",
    {
      description: "Run OCR on a stored blob. Low confidence is reported, not repaired.",
      inputSchema: FilesGetRequest,
      outputSchema: DocumentsExtractTextResponse,
      annotations: readOnlyOpenWorld,
    },
    async (input, extra) =>
      executeTool("documents.ocr", logger, correlationId(extra), async () => {
        const request = FilesGetRequest.parse(input);
        const stored = requireBlob(store, request.hash);
        const text = await safeExtract(extractor, "ocr", stored);
        const tables = extractions.get(stored.hash)?.tables ??
          DocumentsExtractTablesResponse.parse({ hash: stored.hash, tables: [] });
        extractions.set(stored.hash, { text, tables });
        return text;
      }),
  );

  server.registerTool(
    "documents.get_page",
    {
      description: "Return one extracted page. Extract or OCR the blob first.",
      inputSchema: DocumentsGetPageRequest,
      outputSchema: DocumentsGetPageResponse,
      annotations: readOnlyOpenWorld,
    },
    async (input, extra) =>
      executeTool("documents.get_page", logger, correlationId(extra), () => {
        const request = DocumentsGetPageRequest.parse(input);
        const extraction = extractions.get(request.hash);
        const page = extraction?.text.pages.find((item) => item.page === request.page);
        if (page === undefined) {
          throw new DocumentSourceNotFoundError(`${request.hash} page ${request.page}`);
        }
        return DocumentsGetPageResponse.parse({ hash: request.hash, ...page });
      }),
  );

  server.registerTool(
    "documents.search",
    {
      description: "Search already extracted text of one stored blob.",
      inputSchema: DocumentsSearchRequest,
      outputSchema: DocumentsSearchResponse,
      annotations: readOnlyOpenWorld,
    },
    async (input, extra) =>
      executeTool("documents.search", logger, correlationId(extra), () => {
        const request = DocumentsSearchRequest.parse(input);
        const extraction = extractions.get(request.hash);
        if (extraction === undefined) {
          throw new DocumentSourceNotFoundError(request.hash);
        }
        const needle = request.query.toLocaleLowerCase("ru-BY");
        const hits = extraction.text.pages.flatMap((page) => {
          const index = page.text.toLocaleLowerCase("ru-BY").indexOf(needle);
          if (index < 0) return [];
          const start = Math.max(0, index - 40);
          return [
            {
              page: page.page,
              snippet: page.text.slice(start, start + 120).trim(),
            },
          ];
        });
        return DocumentsSearchResponse.parse({ hash: request.hash, hits });
      }),
  );

  server.registerTool(
    "documents.list",
    {
      description: "List stored document blobs.",
      inputSchema: DocumentsListRequest,
      outputSchema: DocumentsListResponse,
      annotations: readOnlyOpenWorld,
    },
    async (input, extra) =>
      executeTool("documents.list", logger, correlationId(extra), () => {
        DocumentsListRequest.parse(input);
        return DocumentsListResponse.parse({
          items: store.list().map((blob) => ({
            hash: blob.hash,
            storageKey: blob.storageKey,
            contentType: blob.contentType,
            sizeBytes: blob.bytes.byteLength,
            extracted: extractions.has(blob.hash),
          })),
        });
      }),
  );

  return server;
}

async function safeExtract<K extends keyof DocumentExtractorPort>(
  extractor: DocumentExtractorPort,
  method: K,
  stored: { hash: string; bytes: Uint8Array; contentType: string },
): Promise<Awaited<ReturnType<DocumentExtractorPort[K]>>> {
  try {
    return (await extractor[method](stored.hash, stored.bytes, stored.contentType)) as Awaited<
      ReturnType<DocumentExtractorPort[K]>
    >;
  } catch (error) {
    if (error instanceof DocumentSourceNotFoundError && method !== "extractTables") {
      return DocumentsExtractTextResponse.parse({
        hash: stored.hash,
        status: "ocr_required",
        text: "",
        pages: [],
        ocrApplied: false,
        confidence: 0,
      }) as Awaited<ReturnType<DocumentExtractorPort[K]>>;
    }
    if (error instanceof DocumentSourceNotFoundError) {
      return DocumentsExtractTablesResponse.parse({
        hash: stored.hash,
        tables: [],
      }) as Awaited<ReturnType<DocumentExtractorPort[K]>>;
    }
    throw error;
  }
}

function requireBlob(store: MemoryBlobStore, hash: string) {
  const stored = store.get(hash);
  if (stored === undefined) throw new DocumentSourceNotFoundError(hash);
  return stored;
}

function decodeBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength === 0) throw new Error("Document bytes were empty");
  return bytes;
}

const executeTool = async <Output extends Record<string, unknown>>(
  toolName: string,
  logger: Logger,
  requestId: string,
  operation: () => Output | Promise<Output>,
) => {
  const toolLogger = logger.child({
    requestId,
    toolName,
    component: "documents-mcp",
  });
  const startedAt = Date.now();
  try {
    const output = await operation();
    toolLogger.info("Documents tool completed", { durationMs: Date.now() - startedAt });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output) }],
      structuredContent: output,
    };
  } catch (error) {
    toolLogger.error("Documents tool failed", error, { durationMs: Date.now() - startedAt });
    return {
      content: [{ type: "text" as const, text: publicErrorMessage(error) }],
      isError: true,
      _meta: { errorKind: classifyError(error) },
    };
  }
};

function correlationId(extra: { _meta?: Record<string, unknown>; requestId: string | number }): string {
  const requestId = extra._meta?.["requestId"];
  return typeof requestId === "string" && requestId.length > 0
    ? requestId
    : String(extra.requestId);
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Documents tool failed";
}

function classifyError(
  error: unknown,
): "not_found" | "source_unavailable" | "invalid_request" | "internal" {
  if (error instanceof DocumentSourceNotFoundError) return "not_found";
  if (error instanceof DocumentTooLargeError || error instanceof ZodError) return "invalid_request";
  return "internal";
}
