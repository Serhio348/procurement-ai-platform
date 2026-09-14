import { createHash, randomUUID } from "node:crypto";
import {
  CommercialExtractorInput,
  CommercialExtractorOutput,
  RequestId,
  SourceId,
  SourceProcurementId,
  SpecialistCaseDocument,
  Sha256,
  type CommercialClaim,
  type SpecialistCaseDocument as SpecialistCaseDocumentValue,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
} from "@procurement/contracts";
import {
  applyParticipateDocuments,
  archiveMemberDisplayName,
  archiveMemberSourceUrl,
  ingestFileFinishState,
  isArchiveMemberSourceUrl,
  keepTrustedClaims,
  MAX_ARCHIVE_UNPACK_DEPTH,
  missingCommercialKeys,
  participateReadablePages,
  participateRuleClaims,
  rankCommercialPages,
} from "@procurement/domain";
import {
  McpToolCallError,
  ProcurementMcpClient,
  ToolPolicyGate,
  type McpToolCaller,
} from "@procurement/mcp-client";
import {
  archiveContainerExtraction,
  createDocumentScanEngine,
  recognizeSpecialistDocument,
  resolveDocumentFormat,
  RoutingDocumentExtractor,
  unpackZipArchive,
} from "@procurement/mcp-documents";
import { silentLogger, type Logger } from "@procurement/observability";
import { contentTypeForName, getBlob, putBlob } from "./blobs.js";
import type { CommercialReaderPort } from "./commercial-reader.js";
import type { IngestProgressHub } from "./ingest-progress.js";
import type { BlobStore } from "./object-store.js";

export interface SpecialistDocumentIngestPort {
  ingest: (card: SpecialistProcurementCardValue) => Promise<SpecialistProcurementCardValue>;
  /** Re-reads blobs already on the case. Does not call the platform. */
  reindex?: (card: SpecialistProcurementCardValue) => Promise<SpecialistProcurementCardValue>;
}

export interface ProcurementDocumentIngestOptions {
  caller: McpToolCaller;
  blobDirectory: string;
  blobStore?: BlobStore;
  logger?: Logger;
  timeoutMs?: number;
  progress?: IngestProgressHub;
  /** Absent: only regex reading, as before. */
  commercialReader?: CommercialReaderPort;
  /** Pages one case may send to the reader. Keeps a 300-page pack from costing a fortune. */
  commercialReaderPageLimit?: number;
}

/** Model pages are capped: payment wording sits on a handful of pages, not everywhere. */
export const DEFAULT_COMMERCIAL_READER_PAGE_LIMIT = 12;

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
        maxOcrPages: Number.parseInt(process.env["DOCUMENT_OCR_MAX_PAGES"] ?? "50", 10),
      });
      const documents: SpecialistCaseDocumentValue[] = [];
      try {
        for (const source of listed.documents) {
          documents.push(
            ...(await ingestOne({
              name: source.name,
              sourceUrl: source.sourceUrl,
              fetchUrl: source.downloadUrl ?? source.sourceUrl,
              ...(source.downloadUrl === undefined ? {} : { listedDownloadUrl: source.downloadUrl }),
              sourceId,
              requestId,
              client,
              blobDirectory: options.blobDirectory,
              ...(options.blobStore === undefined ? {} : { blobStore: options.blobStore }),
              nativeExtractor,
              scanExtractor,
              usesVision: scan.usesVision,
              logger,
              ...(options.progress === undefined ? {} : { progress: options.progress }),
              procurementId: card.id,
            })),
          );
        }
      } finally {
        await scan.close();
      }
      return finishCommercialRead(card, documents, options, logger);
    },
    async reindex(card: SpecialistProcurementCardValue): Promise<SpecialistProcurementCardValue> {
      const stored = card.documents.filter(
        (document) =>
          document.hash !== undefined &&
          document.status === "hashed" &&
          !isArchiveMemberSourceUrl(document.sourceUrl),
      );
      options.progress?.listed(
        card.id,
        stored.map((document) => ({ name: document.name, sourceUrl: document.sourceUrl })),
      );
      if (stored.length === 0) return card;
      const scan = createDocumentScanEngine();
      const nativeExtractor = new RoutingDocumentExtractor();
      const scanExtractor = new RoutingDocumentExtractor({
        ocr: scan.ocr,
        maxOcrPages: Number.parseInt(process.env["DOCUMENT_OCR_MAX_PAGES"] ?? "50", 10),
      });
      const documents: SpecialistCaseDocumentValue[] = [];
      try {
        for (const document of stored) {
          documents.push(
            ...(await reindexOne({
              document,
              blobDirectory: options.blobDirectory,
              ...(options.blobStore === undefined ? {} : { blobStore: options.blobStore }),
              nativeExtractor,
              scanExtractor,
              usesVision: scan.usesVision,
              logger,
              ...(options.progress === undefined ? {} : { progress: options.progress }),
              procurementId: card.id,
            })),
          );
        }
      } finally {
        await scan.close();
      }
      return finishCommercialRead(card, documents, options, logger);
    },
  };
}

async function finishCommercialRead(
  card: SpecialistProcurementCardValue,
  documents: readonly SpecialistCaseDocumentValue[],
  options: ProcurementDocumentIngestOptions,
  logger: Logger,
): Promise<SpecialistProcurementCardValue> {
  const modelClaims = await readCommercialClaims({
    documents,
    ...(options.commercialReader === undefined ? {} : { reader: options.commercialReader }),
    pageLimit: options.commercialReaderPageLimit ?? DEFAULT_COMMERCIAL_READER_PAGE_LIMIT,
    logger,
    sourceProcurementId: card.sourceProcurementId,
  });
  return applyParticipateDocuments(card, documents, { modelClaims });
}

/**
 * Second pass over the same pages: the model proposes what the regexes missed,
 * then `keepTrustedClaims` throws away anything it cannot confirm against the
 * page it cited. Every rejection is logged — a silent drop hides a bad model.
 */
async function readCommercialClaims(input: {
  documents: readonly SpecialistCaseDocumentValue[];
  reader?: CommercialReaderPort;
  pageLimit: number;
  logger: Logger;
  sourceProcurementId: string;
}): Promise<CommercialClaim[]> {
  if (input.reader === undefined) return [];
  const readable = participateReadablePages(input.documents);
  if (readable.length === 0) return [];
  const gaps = missingCommercialKeys(participateRuleClaims(input.documents));
  if (gaps.length === 0) return [];
  const names = new Map(
    input.documents
      .filter((document) => document.hash !== undefined)
      .map((document) => [document.hash, document.name]),
  );
  const selected = rankCommercialPages(readable, input.pageLimit);
  if (selected.length === 0) return [];
  try {
    const raw = await input.reader.read(
      CommercialExtractorInput.parse({
        pages: selected.map((page) => ({
          hash: page.hash,
          name: names.get(page.hash) ?? "документ",
          page: page.page,
          text: page.text,
        })),
      }),
    );
    const parsed = CommercialExtractorOutput.safeParse(raw);
    if (!parsed.success) {
      input.logger.warn("Commercial reader returned an unusable answer", {
        sourceProcurementId: input.sourceProcurementId,
      });
      return [];
    }
    const trusted = keepTrustedClaims(parsed.data.claims, selected);
    if (trusted.rejected.length > 0) {
      input.logger.warn("Commercial reader claims dropped without proof on the page", {
        sourceProcurementId: input.sourceProcurementId,
        rejected: trusted.rejected.map((item) => `${item.claim.key}:${item.reason}`),
      });
    }
    input.logger.info("Commercial reader read the documents", {
      sourceProcurementId: input.sourceProcurementId,
      gaps,
      pageCount: selected.length,
      kept: trusted.kept.length,
      dropped: trusted.rejected.length,
    });
    return trusted.kept;
  } catch (error) {
    input.logger.error("Commercial reader failed", error, {
      sourceProcurementId: input.sourceProcurementId,
    });
    return [];
  }
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
  blobStore?: BlobStore;
  nativeExtractor: RoutingDocumentExtractor;
  scanExtractor: RoutingDocumentExtractor;
  usesVision: boolean;
  logger: Logger;
  progress?: IngestProgressHub;
  procurementId: string;
}): Promise<SpecialistCaseDocumentValue[]> {
  const listed = {
    name: input.name,
    sourceUrl: input.sourceUrl,
    ...(input.listedDownloadUrl === undefined ? {} : { downloadUrl: input.listedDownloadUrl }),
  };
  const finish = (document: SpecialistCaseDocumentValue): SpecialistCaseDocumentValue => {
    input.progress?.fileFinished(
      input.procurementId,
      input.sourceUrl,
      ingestFileFinishState(document),
      document.hash,
    );
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
      return [
        finish(
          SpecialistCaseDocument.parse({
            ...listed,
            hash: downloaded.hash,
            sizeBytes: downloaded.sizeBytes,
            status: "download_failed",
            note: "Файл скачан, но не найден в хранилище.",
          }),
        ),
      ];
    }
    if (input.blobStore !== undefined) {
      await input.blobStore.put(downloaded.hash, bytes);
    }
    input.progress?.fileIndexing(input.procurementId, input.sourceUrl, 0, downloaded.hash);
    return indexStoredFile({
      name: input.name,
      sourceUrl: input.sourceUrl,
      listed,
      hash: downloaded.hash,
      sizeBytes: downloaded.sizeBytes,
      bytes,
      contentType: downloaded.contentType,
      blobDirectory: input.blobDirectory,
      ...(input.blobStore === undefined ? {} : { blobStore: input.blobStore }),
      nativeExtractor: input.nativeExtractor,
      scanExtractor: input.scanExtractor,
      usesVision: input.usesVision,
      logger: input.logger,
      ...(input.progress === undefined ? {} : { progress: input.progress }),
      procurementId: input.procurementId,
      depth: 0,
    });
  } catch (error) {
    input.logger.error("Participate document download failed", error, {
      name: input.name,
    });
    return [
      finish(
        SpecialistCaseDocument.parse({
          ...listed,
          status: "download_failed",
          note: error instanceof McpToolCallError ? error.message : String(error),
        }),
      ),
    ];
  }
}

async function reindexOne(input: {
  document: SpecialistCaseDocumentValue;
  blobDirectory: string;
  blobStore?: BlobStore;
  nativeExtractor: RoutingDocumentExtractor;
  scanExtractor: RoutingDocumentExtractor;
  usesVision: boolean;
  logger: Logger;
  progress?: IngestProgressHub;
  procurementId: string;
}): Promise<SpecialistCaseDocumentValue[]> {
  const hash = input.document.hash;
  if (hash === undefined) return [input.document];
  input.progress?.fileIndexing(input.procurementId, input.document.sourceUrl, 0, hash);
  const bytes = await loadStoredBytes(hash, input.blobDirectory, input.blobStore);
  if (bytes === undefined) {
    input.progress?.fileFinished(input.procurementId, input.document.sourceUrl, "skipped", hash);
    return [input.document];
  }
  return indexStoredFile({
    name: input.document.name,
    sourceUrl: input.document.sourceUrl,
    listed: {
      name: input.document.name,
      sourceUrl: input.document.sourceUrl,
      ...(input.document.downloadUrl === undefined ? {} : { downloadUrl: input.document.downloadUrl }),
    },
    hash,
    ...(input.document.sizeBytes === undefined ? {} : { sizeBytes: input.document.sizeBytes }),
    bytes,
    contentType: contentTypeOf(input.document),
    blobDirectory: input.blobDirectory,
    ...(input.blobStore === undefined ? {} : { blobStore: input.blobStore }),
    nativeExtractor: input.nativeExtractor,
    scanExtractor: input.scanExtractor,
    usesVision: input.usesVision,
    logger: input.logger,
    ...(input.progress === undefined ? {} : { progress: input.progress }),
    procurementId: input.procurementId,
    depth: 0,
  });
}

async function indexStoredFile(input: {
  name: string;
  sourceUrl: string;
  listed: { name: string; sourceUrl: string; downloadUrl?: string };
  hash: string;
  sizeBytes?: number;
  bytes: Uint8Array;
  contentType: string;
  blobDirectory: string;
  blobStore?: BlobStore;
  nativeExtractor: RoutingDocumentExtractor;
  scanExtractor: RoutingDocumentExtractor;
  usesVision: boolean;
  logger: Logger;
  progress?: IngestProgressHub;
  procurementId: string;
  depth: number;
}): Promise<SpecialistCaseDocumentValue[]> {
  const format = resolveDocumentFormat(input.bytes, input.name, input.contentType);
  if (format === "zip" && input.depth < MAX_ARCHIVE_UNPACK_DEPTH) {
    const members = unpackZipArchive(input.bytes);
    const parent = finishIndexed(
      input,
      SpecialistCaseDocument.parse({
        ...input.listed,
        hash: input.hash,
        ...(input.sizeBytes === undefined ? {} : { sizeBytes: input.sizeBytes }),
        status: "hashed",
        note: input.contentType,
        extraction: archiveContainerExtraction(members.length),
      }),
    );
    const children: SpecialistCaseDocumentValue[] = [];
    for (const member of members) {
      const memberHash = Sha256.parse(createHash("sha256").update(member.bytes).digest("hex"));
      await putBlob(input.blobDirectory, memberHash, member.bytes);
      if (input.blobStore !== undefined) {
        await input.blobStore.put(memberHash, member.bytes);
      }
      children.push(
        ...(await indexStoredFile({
          name: archiveMemberDisplayName(input.name, member.path),
          sourceUrl: archiveMemberSourceUrl(input.sourceUrl, member.path),
          listed: {
            name: archiveMemberDisplayName(input.name, member.path),
            sourceUrl: archiveMemberSourceUrl(input.sourceUrl, member.path),
          },
          hash: memberHash,
          sizeBytes: member.bytes.byteLength,
          bytes: member.bytes,
          contentType: contentTypeForName(member.path),
          blobDirectory: input.blobDirectory,
          ...(input.blobStore === undefined ? {} : { blobStore: input.blobStore }),
          nativeExtractor: input.nativeExtractor,
          scanExtractor: input.scanExtractor,
          usesVision: input.usesVision,
          logger: input.logger,
          ...(input.progress === undefined ? {} : { progress: input.progress }),
          procurementId: input.procurementId,
          depth: input.depth + 1,
        })),
      );
    }
    return [parent, ...children];
  }

  let extraction;
  try {
    extraction = await recognizeSpecialistDocument({
      name: input.name,
      hash: input.hash,
      bytes: input.bytes,
      contentType: input.contentType,
      nativeExtractor: input.nativeExtractor,
      scanExtractor: input.scanExtractor,
      usesVision: input.usesVision,
    });
  } catch (error) {
    input.logger.error("Participate document recognition failed", error, {
      name: input.name,
      hash: input.hash,
    });
  }
  return [
    finishIndexed(
      input,
      SpecialistCaseDocument.parse({
        ...input.listed,
        hash: input.hash,
        ...(input.sizeBytes === undefined ? {} : { sizeBytes: input.sizeBytes }),
        status: "hashed",
        note: input.contentType,
        ...(extraction === undefined ? {} : { extraction }),
      }),
    ),
  ];
}

function finishIndexed(
  input: {
    progress?: IngestProgressHub;
    procurementId: string;
    sourceUrl: string;
  },
  document: SpecialistCaseDocumentValue,
): SpecialistCaseDocumentValue {
  input.progress?.fileFinished(
    input.procurementId,
    input.sourceUrl,
    ingestFileFinishState(document),
    document.hash,
  );
  return document;
}

async function loadStoredBytes(
  hash: string,
  blobDirectory: string,
  blobStore: BlobStore | undefined,
): Promise<Uint8Array | undefined> {
  const fromDisk = await getBlob(blobDirectory, hash);
  if (fromDisk !== undefined) return fromDisk;
  if (blobStore === undefined) return undefined;
  return blobStore.get(hash);
}

function contentTypeOf(document: SpecialistCaseDocumentValue): string {
  const note = document.note ?? "";
  if (note.includes("/")) return note;
  return contentTypeForName(document.name);
}

