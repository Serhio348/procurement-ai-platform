import { z } from "zod";
import { IsoDateTime, PlatformInstant, Sha256 } from "./common.js";
import { BlobStorageKey } from "./documents.js";
import { SourceId, SourceProcurementId } from "./ids.js";
import {
  ProcedureCard,
  ProcedureStatus,
  SearchHit,
  SearchQuery,
  SourceChange,
  SourceClarification,
  SourceDocument,
  SourceLot,
} from "./procurement.js";

/**
 * Request/response envelopes for Procurement MCP. The adapter implements
 * `ProcurementSourcePort`; it never receives a domain profile.
 */

export const ProcurementSearchRequest = SearchQuery.strict();
export type ProcurementSearchRequest = z.infer<typeof ProcurementSearchRequest>;

export const ProcurementSearchResponse = z.object({
  hits: z.array(SearchHit),
  /**
   * True when the source still had unread rows beyond the returned window —
   * overlapping search terms may have hidden later pages after dedup, or a
   * safety page cap stopped the scan early.
   */
  hasMore: z.boolean().optional(),
});
export type ProcurementSearchResponse = z.infer<typeof ProcurementSearchResponse>;

export const ProcurementGetRequest = z.object({
  sourceId: SourceId,
  sourceProcurementId: SourceProcurementId,
}).strict();
export type ProcurementGetRequest = z.infer<typeof ProcurementGetRequest>;

export const ProcurementGetStatusRequest = ProcurementGetRequest;
export type ProcurementGetStatusRequest = ProcurementGetRequest;

export const ProcurementGetLotsRequest = ProcurementGetRequest;
export type ProcurementGetLotsRequest = ProcurementGetRequest;

export const ProcurementGetDocumentsRequest = ProcurementGetRequest;
export type ProcurementGetDocumentsRequest = ProcurementGetRequest;

export const ProcurementGetHistoryRequest = ProcurementGetRequest;
export type ProcurementGetHistoryRequest = ProcurementGetRequest;

export const ProcurementGetResponse = ProcedureCard;
export type ProcurementGetResponse = z.infer<typeof ProcurementGetResponse>;

export const ProcurementGetStatusResponse = z.object({
  status: ProcedureStatus,
  sourceStatus: z.string().optional(),
  bidsDeadline: PlatformInstant.optional(),
  fetchedAt: IsoDateTime,
});
export type ProcurementGetStatusResponse = z.infer<typeof ProcurementGetStatusResponse>;

export const ProcurementGetLotsResponse = z.object({
  lots: z.array(SourceLot),
});
export type ProcurementGetLotsResponse = z.infer<typeof ProcurementGetLotsResponse>;

export const ProcurementGetDocumentsResponse = z.object({
  documents: z.array(SourceDocument),
});
export type ProcurementGetDocumentsResponse = z.infer<typeof ProcurementGetDocumentsResponse>;

export const ProcurementGetHistoryResponse = z.object({
  clarifications: z.array(SourceClarification).default([]),
});
export type ProcurementGetHistoryResponse = z.infer<typeof ProcurementGetHistoryResponse>;

export const ProcurementGetChangesRequest = ProcurementGetRequest.extend({
  since: IsoDateTime.optional(),
}).strict();
export type ProcurementGetChangesRequest = z.infer<typeof ProcurementGetChangesRequest>;

export const ProcurementGetChangesResponse = z.object({
  changes: z.array(SourceChange),
});
export type ProcurementGetChangesResponse = z.infer<typeof ProcurementGetChangesResponse>;

export const ProcurementDownloadRequest = z
  .object({
    sourceId: SourceId,
    downloadUrl: z.string().url(),
  })
  .strict();
export type ProcurementDownloadRequest = z.infer<typeof ProcurementDownloadRequest>;

export const ProcurementDownloadResponse = z.object({
  hash: Sha256,
  storageKey: BlobStorageKey,
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string().min(1),
});
export type ProcurementDownloadResponse = z.infer<typeof ProcurementDownloadResponse>;

export interface ProcurementFileBytes {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Neutral source adapter. Implementations must not import database packages
 * or `DomainProfile`. Filtering by profile keywords happens in application code
 * after `search` returns.
 */
export interface ProcurementSourcePort {
  readonly sourceId: SourceId;
  search(query: SearchQuery): Promise<ProcurementSearchResponse>;
  get(id: SourceProcurementId): Promise<ProcedureCard>;
  getStatus(id: SourceProcurementId): Promise<ProcurementGetStatusResponse>;
  getLots(id: SourceProcurementId): Promise<ProcurementGetLotsResponse>;
  getDocuments(id: SourceProcurementId): Promise<ProcurementGetDocumentsResponse>;
  getHistory(id: SourceProcurementId): Promise<ProcurementGetHistoryResponse>;
  getChanges(id: SourceProcurementId, since?: IsoDateTime): Promise<ProcurementGetChangesResponse>;
  download(downloadUrl: string): Promise<ProcurementFileBytes>;
}
