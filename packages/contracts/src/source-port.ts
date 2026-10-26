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
  /**
   * Resume token for the unread tail, present only together with `hasMore`.
   * The caller persists it and hands it back as `scanCursor` on the next
   * call — the source continues below the recorded position. Absent once
   * the window is fully read.
   */
  scanCursor: z.string().optional(),
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

/**
 * The raw card page as the source renders it in-session. Only sources whose
 * cards are session-bound (no public URL) implement `getCardHtml`; callers
 * serve the snapshot with the source's base URL so assets and document
 * links keep working.
 */
export const ProcurementGetCardHtmlResponse = z.object({
  html: z.string().min(1),
  url: z.string().url(),
  fetchedAt: IsoDateTime,
});
export type ProcurementGetCardHtmlResponse = z.infer<typeof ProcurementGetCardHtmlResponse>;

/**
 * Introspection: which sources the MCP child actually registered. Health
 * uses it so a flag reaching the API but not the child cannot fake health.
 */
export const ProcurementSourcesRequest = z.object({}).strict();
export type ProcurementSourcesRequest = z.infer<typeof ProcurementSourcesRequest>;

export const ProcurementSourcesResponse = z.object({
  sources: z.array(SourceId),
});
export type ProcurementSourcesResponse = z.infer<typeof ProcurementSourcesResponse>;

export interface ProcurementFileBytes {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Per-call context. `signal` carries the MCP client cancellation — adapters
 * check it between page iterations and pass it into site fetches so a
 * timed-out call stops mutating session state instead of running to the end.
 */
export interface ProcurementCallContext {
  signal?: AbortSignal;
}

/**
 * Neutral source adapter. Implementations must not import database packages
 * or `DomainProfile`. Filtering by profile keywords happens in application code
 * after `search` returns.
 */
export interface ProcurementSourcePort {
  readonly sourceId: SourceId;
  search(query: SearchQuery, ctx?: ProcurementCallContext): Promise<ProcurementSearchResponse>;
  get(id: SourceProcurementId, ctx?: ProcurementCallContext): Promise<ProcedureCard>;
  getStatus(
    id: SourceProcurementId,
    ctx?: ProcurementCallContext,
  ): Promise<ProcurementGetStatusResponse>;
  getLots(
    id: SourceProcurementId,
    ctx?: ProcurementCallContext,
  ): Promise<ProcurementGetLotsResponse>;
  getDocuments(
    id: SourceProcurementId,
    ctx?: ProcurementCallContext,
  ): Promise<ProcurementGetDocumentsResponse>;
  getHistory(
    id: SourceProcurementId,
    ctx?: ProcurementCallContext,
  ): Promise<ProcurementGetHistoryResponse>;
  getChanges(
    id: SourceProcurementId,
    since?: IsoDateTime,
    ctx?: ProcurementCallContext,
  ): Promise<ProcurementGetChangesResponse>;
  getCardHtml?(
    id: SourceProcurementId,
    ctx?: ProcurementCallContext,
  ): Promise<ProcurementGetCardHtmlResponse>;
  download(downloadUrl: string, ctx?: ProcurementCallContext): Promise<ProcurementFileBytes>;
}
