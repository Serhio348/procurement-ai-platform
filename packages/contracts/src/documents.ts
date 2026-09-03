import { z } from "zod";
import { Confidence, IsoDateTime, Sha256 } from "./common.js";
import { SourceId, SourceProcurementId } from "./ids.js";

export const BlobStorageKey = z
  .string()
  .regex(/^blobs\/[a-f0-9]{64}$/, "storage key must be blobs/{sha256}");
export type BlobStorageKey = z.infer<typeof BlobStorageKey>;

export const ExtractionStatus = z.enum([
  "extracted",
  "ocr_required",
  "ocr_low_confidence",
  "failed",
]);
export type ExtractionStatus = z.infer<typeof ExtractionStatus>;

export const ExtractedPage = z.object({
  page: z.number().int().positive(),
  text: z.string(),
  ocrApplied: z.boolean(),
  confidence: Confidence,
});
export type ExtractedPage = z.infer<typeof ExtractedPage>;

export const ExtractedTable = z.object({
  page: z.number().int().positive(),
  rows: z.array(z.array(z.string())),
});
export type ExtractedTable = z.infer<typeof ExtractedTable>;

export const FilesPutRequest = z
  .object({
    bytesBase64: z.string().min(1).max(10_000_000),
    contentType: z.string().min(1).default("application/octet-stream"),
  })
  .strict();
export type FilesPutRequest = z.infer<typeof FilesPutRequest>;

export const FilesPutResponse = z.object({
  hash: Sha256,
  storageKey: BlobStorageKey,
  sizeBytes: z.number().int().nonnegative(),
});
export type FilesPutResponse = z.infer<typeof FilesPutResponse>;

export const FilesGetRequest = z
  .object({
    hash: Sha256,
  })
  .strict();
export type FilesGetRequest = z.infer<typeof FilesGetRequest>;

export const FilesGetResponse = FilesPutResponse.extend({
  contentType: z.string().min(1),
  bytesBase64: z.string().min(1),
});
export type FilesGetResponse = z.infer<typeof FilesGetResponse>;

export const FilesExistsRequest = FilesGetRequest;
export type FilesExistsRequest = FilesGetRequest;

export const FilesExistsResponse = z.object({
  exists: z.boolean(),
});
export type FilesExistsResponse = z.infer<typeof FilesExistsResponse>;

export const DocumentsDownloadRequest = z
  .object({
    sourceUrl: z.string().url(),
    maxBytes: z.number().int().positive().max(20_000_000).default(5_000_000),
  })
  .strict();
export type DocumentsDownloadRequest = z.infer<typeof DocumentsDownloadRequest>;

export const DocumentsDownloadResponse = FilesPutResponse.extend({
  contentType: z.string().min(1),
});
export type DocumentsDownloadResponse = z.infer<typeof DocumentsDownloadResponse>;

export const DocumentsHashRequest = z
  .object({
    hash: Sha256,
  })
  .strict();
export type DocumentsHashRequest = z.infer<typeof DocumentsHashRequest>;

export const DocumentsExtractTextResponse = z.object({
  hash: Sha256,
  status: ExtractionStatus,
  text: z.string(),
  pages: z.array(ExtractedPage).default([]),
  ocrApplied: z.boolean(),
  confidence: Confidence,
});
export type DocumentsExtractTextResponse = z.infer<typeof DocumentsExtractTextResponse>;

export const DocumentsExtractTablesResponse = z.object({
  hash: Sha256,
  tables: z.array(ExtractedTable).default([]),
});
export type DocumentsExtractTablesResponse = z.infer<typeof DocumentsExtractTablesResponse>;

export const DocumentsOcrResponse = DocumentsExtractTextResponse;
export type DocumentsOcrResponse = DocumentsExtractTextResponse;

export const DocumentsGetPageRequest = z
  .object({
    hash: Sha256,
    page: z.number().int().positive(),
  })
  .strict();
export type DocumentsGetPageRequest = z.infer<typeof DocumentsGetPageRequest>;

export const DocumentsGetPageResponse = ExtractedPage.extend({
  hash: Sha256,
});
export type DocumentsGetPageResponse = z.infer<typeof DocumentsGetPageResponse>;

export const DocumentsSearchRequest = z
  .object({
    hash: Sha256,
    query: z.string().min(1).max(500),
  })
  .strict();
export type DocumentsSearchRequest = z.infer<typeof DocumentsSearchRequest>;

export const DocumentsSearchHit = z.object({
  page: z.number().int().positive(),
  snippet: z.string().min(1),
});
export type DocumentsSearchHit = z.infer<typeof DocumentsSearchHit>;

export const DocumentsSearchResponse = z.object({
  hash: Sha256,
  hits: z.array(DocumentsSearchHit),
});
export type DocumentsSearchResponse = z.infer<typeof DocumentsSearchResponse>;

export const DocumentsListRequest = z.object({}).strict();
export type DocumentsListRequest = z.infer<typeof DocumentsListRequest>;

export const DocumentsListItem = z.object({
  hash: Sha256,
  storageKey: BlobStorageKey,
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  extracted: z.boolean(),
});
export type DocumentsListItem = z.infer<typeof DocumentsListItem>;

export const DocumentsListResponse = z.object({
  items: z.array(DocumentsListItem),
});
export type DocumentsListResponse = z.infer<typeof DocumentsListResponse>;

export const DocumentIngestInput = z.object({
  sourceId: SourceId.optional(),
  sourceProcurementId: SourceProcurementId.optional(),
});
export type DocumentIngestInput = z.infer<typeof DocumentIngestInput>;

export const IngestedDocument = z.object({
  name: z.string().min(1),
  sourceUrl: z.string().url(),
  hash: Sha256,
  storageKey: BlobStorageKey,
  version: z.number().int().positive(),
  unchanged: z.boolean(),
  status: ExtractionStatus,
  ocrApplied: z.boolean(),
  confidence: Confidence,
  pageCount: z.number().int().nonnegative(),
  tableCount: z.number().int().nonnegative(),
  textPreview: z.string(),
});
export type IngestedDocument = z.infer<typeof IngestedDocument>;

export const DocumentIngestOutput = z.object({
  documents: z.array(IngestedDocument),
  extractedCount: z.number().int().nonnegative(),
  unchangedCount: z.number().int().nonnegative(),
  ocrCount: z.number().int().nonnegative(),
  ingestedAt: IsoDateTime,
});
export type DocumentIngestOutput = z.infer<typeof DocumentIngestOutput>;
