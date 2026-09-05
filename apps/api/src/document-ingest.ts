import { randomUUID } from "node:crypto";
import {
  RequestId,
  SourceId,
  SourceProcurementId,
  SpecialistCaseDocument,
  type SpecialistCaseDocument as SpecialistCaseDocumentValue,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
} from "@procurement/contracts";
import { applyParticipateDocuments, ingestFileFinishState } from "@procurement/domain";
import {
  McpToolCallError,
  ProcurementMcpClient,
  ToolPolicyGate,
  type McpToolCaller,
} from "@procurement/mcp-client";
import {
  createDocumentScanEngine,
  recognizeSpecialistDocument,
  RoutingDocumentExtractor,
} from "@procurement/mcp-documents";
import { silentLogger, type Logger } from "@procurement/observability";
import { getBlob } from "./blobs.js";
import type { IngestProgressHub } from "./ingest-progress.js";

export interface SpecialistDocumentIngestPort {
  ingest: (card: SpecialistProcurementCardValue) => Promise<SpecialistProcurementCardValue>;
}

export interface ProcurementDocumentIngestOptions {
  caller: McpToolCaller;
  blobDirectory: string;
  logger?: Logger;
  timeoutMs?: number;
  progress?: IngestProgressHub;
}

export function createProcurementDocumentIngest(
  options: ProcurementDocumentIngestOptions,
): SpecialistDocumentIngestPort {
  const client = new ProcurementMcpClient({
    caller: options.caller,
    policyGate: new ToolPolicyGate({
      agentAllowedTools: ["procurement.get_documents", "procurement.download"],
    }),
    timeoutMs: options.timeoutMs ?? 180_000,
    logger: options.logger ?? silentLogger,
  });
  const logger = options.logger ?? silentLogger;

  return {
    async ingest(card: SpecialistProcurementCardValue): Promise<SpecialistProcurementCardValue> {
      const requestId = RequestId.parse(randomUUID());
      const sourceId = SourceId.parse(card.live ? "goszakupki_by" : "fixture");
      const listed = await client.getDocuments(
        {
          sourceId,
          sourceProcurementId: SourceProcurementId.parse(card.sourceProcurementId),
        },
        requestId,
      );
      options.progress?.listed(card.id, listed.documents);
      const scan = createDocumentScanEngine();
      const nativeExtractor = new RoutingDocumentExtractor();
      const scanExtractor = new RoutingDocumentExtractor({
        ocr: scan.ocr,
        maxOcrPages: Number.parseInt(process.env["DOCUMENT_OCR_MAX_PAGES"] ?? "20", 10),
      });
      const documents: SpecialistCaseDocumentValue[] = [];
      try {
        for (const source of listed.documents) {
          documents.push(
            await ingestOne({
              name: source.name,
              sourceUrl: source.sourceUrl,
              fetchUrl: source.downloadUrl ?? source.sourceUrl,
              ...(source.downloadUrl === undefined ? {} : { listedDownloadUrl: source.downloadUrl }),
              sourceId,
              requestId,
              client,
              blobDirectory: options.blobDirectory,
              nativeExtractor,
              scanExtractor,
              usesVision: scan.usesVision,
              logger,
              progress: options.progress,
              procurementId: card.id,
            }),
          );
        }
      } finally {
        await scan.close();
      }
      return applyParticipateDocuments(card, documents);
    },
  };
}

async function ingestOne(input: {
  name: string;
  sourceUrl: string;
  fetchUrl: string;
  listedDownloadUrl?: string;
  sourceId: ReturnType<typeof SourceId.parse>;
  requestId: ReturnType<typeof RequestId.parse>;
  client: ProcurementMcpClient;
  blobDirectory: string;
  nativeExtractor: RoutingDocumentExtractor;
  scanExtractor: RoutingDocumentExtractor;
  usesVision: boolean;
  logger: Logger;
  progress?: IngestProgressHub;
  procurementId: string;
}): Promise<SpecialistCaseDocumentValue> {
  const listed = {
    name: input.name,
    sourceUrl: input.sourceUrl,
    ...(input.listedDownloadUrl === undefined ? {} : { downloadUrl: input.listedDownloadUrl }),
  };
  const finish = (document: SpecialistCaseDocumentValue): SpecialistCaseDocumentValue => {
    input.progress?.fileFinished(input.procurementId, input.sourceUrl, ingestFileFinishState(document));
    return document;
  };
  try {
    input.progress?.fileDownloading(input.procurementId, input.sourceUrl);
    const downloaded = await input.client.download(
      { sourceId: input.sourceId, downloadUrl: input.fetchUrl },
      input.requestId,
    );
    const bytes = await getBlob(input.blobDirectory, downloaded.hash);
    if (bytes === undefined) {
      input.logger.error(
        "Participate download hash is missing from the blob directory",
        new Error("blob_missing"),
        {
          name: input.name,
          hash: downloaded.hash,
          blobDirectory: input.blobDirectory,
        },
      );
      return finish(
        SpecialistCaseDocument.parse({
          ...listed,
          hash: downloaded.hash,
          sizeBytes: downloaded.sizeBytes,
          status: "download_failed",
          note: "Файл скачан, но не найден в хранилище.",
        }),
      );
    }
    input.progress?.fileIndexing(input.procurementId, input.sourceUrl, 0);
    let extraction;
    try {
      extraction = await recognizeSpecialistDocument({
        name: input.name,
        hash: downloaded.hash,
        bytes,
        contentType: downloaded.contentType,
        nativeExtractor: input.nativeExtractor,
        scanExtractor: input.scanExtractor,
        usesVision: input.usesVision,
      });
    } catch (error) {
      input.logger.error("Participate document recognition failed", error, {
        name: input.name,
        hash: downloaded.hash,
      });
    }
    return finish(
      SpecialistCaseDocument.parse({
        ...listed,
        hash: downloaded.hash,
        sizeBytes: downloaded.sizeBytes,
        status: "hashed",
        note: downloaded.contentType,
        ...(extraction === undefined ? {} : { extraction }),
      }),
    );
  } catch (error) {
    input.logger.error("Participate document download failed", error, {
      name: input.name,
    });
    return finish(
      SpecialistCaseDocument.parse({
        ...listed,
        status: "download_failed",
        note: error instanceof McpToolCallError ? error.message : String(error),
      }),
    );
  }
}
