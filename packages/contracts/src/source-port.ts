import { z } from "zod";
import { IsoDateTime } from "./common.js";
import { SourceId, SourceProcurementId } from "./ids.js";
import {
  ChangeEvent,
  Clarification,
  Lot,
  ProcedureCard,
  ProcurementDocument,
  SearchHit,
  SearchQuery,
} from "./procurement.js";

/**
 * Request/response envelopes for Procurement MCP. The adapter implements
 * `ProcurementSourcePort`; it never receives a domain profile.
 */

export const ProcurementSearchRequest = SearchQuery;
export type ProcurementSearchRequest = z.infer<typeof ProcurementSearchRequest>;

export const ProcurementSearchResponse = z.object({
  hits: z.array(SearchHit),
});
export type ProcurementSearchResponse = z.infer<typeof ProcurementSearchResponse>;

export const ProcurementGetRequest = z.object({
  sourceId: SourceId,
  sourceProcurementId: SourceProcurementId,
});
export type ProcurementGetRequest = z.infer<typeof ProcurementGetRequest>;

export const ProcurementGetResponse = ProcedureCard;
export type ProcurementGetResponse = z.infer<typeof ProcurementGetResponse>;

export const ProcurementGetLotsResponse = z.object({
  lots: z.array(Lot),
});
export type ProcurementGetLotsResponse = z.infer<typeof ProcurementGetLotsResponse>;

export const ProcurementGetDocumentsResponse = z.object({
  documents: z.array(ProcurementDocument),
});
export type ProcurementGetDocumentsResponse = z.infer<typeof ProcurementGetDocumentsResponse>;

export const ProcurementGetHistoryResponse = z.object({
  clarifications: z.array(Clarification).default([]),
});
export type ProcurementGetHistoryResponse = z.infer<typeof ProcurementGetHistoryResponse>;

export const ProcurementGetChangesRequest = ProcurementGetRequest.extend({
  since: IsoDateTime.optional(),
});
export type ProcurementGetChangesRequest = z.infer<typeof ProcurementGetChangesRequest>;

export const ProcurementGetChangesResponse = z.object({
  changes: z.array(ChangeEvent),
});
export type ProcurementGetChangesResponse = z.infer<typeof ProcurementGetChangesResponse>;

/**
 * Neutral source adapter. Implementations must not import database packages
 * or `DomainProfile`. Filtering by profile keywords happens in application code
 * after `search` returns.
 */
export interface ProcurementSourcePort {
  readonly sourceId: SourceId;
  search(query: SearchQuery): Promise<ProcurementSearchResponse>;
  get(id: SourceProcurementId): Promise<ProcedureCard>;
  getLots(id: SourceProcurementId): Promise<ProcurementGetLotsResponse>;
  getDocuments(id: SourceProcurementId): Promise<ProcurementGetDocumentsResponse>;
  getHistory(id: SourceProcurementId): Promise<ProcurementGetHistoryResponse>;
  getChanges(id: SourceProcurementId, since?: IsoDateTime): Promise<ProcurementGetChangesResponse>;
}
