import {
  ProcurementGetChangesResponse,
  ProcurementGetDocumentsResponse,
  ProcurementGetHistoryResponse,
  ProcurementGetLotsResponse,
  ProcurementGetStatusResponse,
  ProcurementSearchResponse,
  SourceId,
  type ProcurementFileBytes,
  type IsoDateTime,
  type ProcurementSourcePort,
  type SearchQuery,
  type SourceProcurementId,
} from "@procurement/contracts";
import { silentLogger, type Logger } from "@procurement/observability";
import { expandPublicDocumentation } from "./documentation-expand.js";
import type { ParsedGoszakupkiCard } from "./goszakupki-by-parser.js";
import {
  parseGoszakupkiCard,
  parseGoszakupkiSearchPage,
} from "./goszakupki-by-parser.js";
import {
  FALLBACK_STATUS_OPTIONS,
  parseGoszakupkiSearchFilters,
  searchQueryStatusIds,
  type GoszakupkiStatusOption,
} from "./goszakupki-by-filters.js";
import type { GoszakupkiPageClient } from "./goszakupki-by-http.js";
import { downloadPublicDocumentation, type PublicDocumentationFetch } from "./public-download.js";
import { SourceAccessError, SourceRecordNotFoundError } from "./source-registry.js";

export interface GoszakupkiBySourceOptions {
  client: GoszakupkiPageClient;
  cacheTtlMs?: number;
  now?: () => Date;
  publicFetch?: PublicDocumentationFetch;
  logger?: Logger;
}

/** Smallest slice of the result budget a single profile phrase is owed. */
export const MIN_ROWS_PER_SEARCH_TERM = 20;

interface CacheEntry {
  expiresAt: number;
  parsed: ParsedGoszakupkiCard;
}

export class GoszakupkiBySource implements ProcurementSourcePort {
  readonly sourceId = SourceId.parse("goszakupki_by");
  readonly #client: GoszakupkiPageClient;
  readonly #cacheTtlMs: number;
  readonly #now: () => Date;
  readonly #publicFetch: PublicDocumentationFetch;
  readonly #logger: Logger;
  readonly #cache = new Map<string, CacheEntry>();
  #statusOptions: readonly GoszakupkiStatusOption[] | undefined;

  constructor(options: GoszakupkiBySourceOptions) {
    this.#client = options.client;
    this.#cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.#now = options.now ?? (() => new Date());
    this.#publicFetch = options.publicFetch ?? fetch;
    this.#logger = options.logger ?? silentLogger;
  }

  /**
   * Retrieval only. Each profile phrase is its own platform query (the site
   * filters by substring, so a joined phrase returns nothing) and owns its
   * own slice of the result budget: a broad first phrase cannot starve the
   * rest. Rows are merged round-robin and de-duplicated by procedure id,
   * keeping every phrase that found them. Nothing here decides relevance.
   */
  async search(query: SearchQuery): Promise<ProcurementSearchResponse> {
    const statusIds = await this.#resolvedStatusIds(query);
    const filteredQuery = { ...query, statusIds };
    const terms = filteredQuery.keywords.length === 0 ? [undefined] : filteredQuery.keywords;
    const buckets: SearchBucket[] = [];
    const rowsPerTerm = Math.max(
      MIN_ROWS_PER_SEARCH_TERM,
      Math.ceil((filteredQuery.offset + filteredQuery.limit) / terms.length),
    );
    const pagesPerTerm = Math.min(30, Math.ceil(rowsPerTerm / 20) + 1);

    for (const term of terms) {
      const termRows = new Map<string, SearchRow>();
      let seenRows = 0;
      let pages = 0;
      for (let page = 1; page <= pagesPerTerm; page += 1) {
        const path = searchPath(filteredQuery, term, page);
        const response = await this.#client.get(path);
        pages += 1;
        if (response.status < 200 || response.status >= 300) {
          throw new SourceAccessError(
            this.sourceId,
            `search returned unexpected HTTP ${response.status}`,
          );
        }
        const parsed = parseGoszakupkiSearchPage(response.body, response.url);
        this.#logger.info("goszakupki.by search GET", {
          component: "goszakupki-by-source",
          decoded: decodeURIComponent(path),
          parsed: parsed.rows.map(
            (row) => `${row.hit.sourceProcurementId} ${row.hit.sourceStatus ?? "—"}`,
          ),
        });
        seenRows += parsed.rows.length;
        for (const row of parsed.rows) {
          if (query.kinds.length > 0 && !query.kinds.includes(row.kind)) continue;
          termRows.set(row.hit.sourceProcurementId, row);
        }
        if (!parsed.hasNextPage) break;
        if (termRows.size >= rowsPerTerm) break;
      }
      this.#logger.info("goszakupki.by search term", {
        component: "goszakupki-by-source",
        term: term ?? "",
        pages,
        rows: seenRows,
        kept: termRows.size,
      });
      buckets.push({
        term,
        rows: [...termRows.values()].sort(
          (left, right) =>
            sourceSequence(right.hit.sourceProcurementId) -
            sourceSequence(left.hit.sourceProcurementId),
        ),
      });
    }

    const merged = interleaveSearchBuckets(buckets);
    const hits = merged
      .slice(filteredQuery.offset, filteredQuery.offset + filteredQuery.limit)
      .map(({ row, terms: found }) =>
        found.length === 0 ? row.hit : { ...row.hit, matchedSearchTerms: found },
      );
    this.#logger.info("goszakupki.by search merged", {
      component: "goszakupki-by-source",
      terms: terms.map((term) => term ?? ""),
      candidates: merged.length,
      returned: hits.length,
    });
    return ProcurementSearchResponse.parse({ hits });
  }

  async #resolvedStatusIds(query: SearchQuery): Promise<string[]> {
    if (query.statuses.length === 0 && query.statusIds.length === 0) {
      return query.statusIds;
    }
    const options = await this.#loadStatusOptions();
    return searchQueryStatusIds(query, options);
  }

  async #loadStatusOptions(): Promise<readonly GoszakupkiStatusOption[]> {
    if (this.#statusOptions !== undefined) return this.#statusOptions;
    const response = await this.#client.get("/tenders/posted");
    if (response.status < 200 || response.status >= 300) {
      this.#statusOptions = FALLBACK_STATUS_OPTIONS;
      return this.#statusOptions;
    }
    const parsed = parseGoszakupkiSearchFilters(response.body).statuses;
    this.#statusOptions = parsed.length > 0 ? parsed : FALLBACK_STATUS_OPTIONS;
    return this.#statusOptions;
  }

  async get(id: SourceProcurementId) {
    return (await this.#load(id)).card;
  }

  async getStatus(id: SourceProcurementId): Promise<ProcurementGetStatusResponse> {
    const card = (await this.#load(id)).card;
    return ProcurementGetStatusResponse.parse({
      status: card.status,
      sourceStatus: card.sourceStatus,
      bidsDeadline: card.bidsDeadline,
      fetchedAt: card.fetchedAt,
    });
  }

  async getLots(id: SourceProcurementId): Promise<ProcurementGetLotsResponse> {
    return ProcurementGetLotsResponse.parse({ lots: (await this.#load(id)).card.lots });
  }

  async getDocuments(id: SourceProcurementId): Promise<ProcurementGetDocumentsResponse> {
    const parsed = await this.#load(id);
    const documents = await expandPublicDocumentation(
      parsed.documents,
      this.#publicFetch,
      () => parsed.card.fetchedAt,
    );
    return ProcurementGetDocumentsResponse.parse({ documents });
  }

  async getHistory(id: SourceProcurementId): Promise<ProcurementGetHistoryResponse> {
    return ProcurementGetHistoryResponse.parse({
      clarifications: (await this.#load(id)).history,
    });
  }

  async getChanges(
    id: SourceProcurementId,
    _since?: IsoDateTime,
  ): Promise<ProcurementGetChangesResponse> {
    await this.#load(id);
    return ProcurementGetChangesResponse.parse({ changes: [] });
  }

  async download(downloadUrl: string): Promise<ProcurementFileBytes> {
    let parsed: URL;
    try {
      parsed = new URL(downloadUrl);
    } catch {
      throw new SourceAccessError(this.sourceId, "document URL is not valid");
    }
    const host = parsed.hostname.toLocaleLowerCase("en-US");
    if (host === "goszakupki.by" || host.endsWith(".goszakupki.by")) {
      if (this.#client.download === undefined) {
        throw new SourceAccessError(this.sourceId, "this client cannot download files");
      }
      const file = await this.#client.download(`${parsed.pathname}${parsed.search}`);
      if (file.status < 200 || file.status >= 300) {
        throw new SourceAccessError(
          this.sourceId,
          `document download returned unexpected HTTP ${String(file.status)}`,
        );
      }
      return {
        bytes: file.bytes,
        contentType: file.contentType ?? "application/octet-stream",
      };
    }
    return downloadPublicDocumentation(downloadUrl, this.#publicFetch);
  }

  async #load(id: SourceProcurementId): Promise<ParsedGoszakupkiCard> {
    const path = sourcePath(id);
    const cached = this.#cache.get(path);
    const now = this.#now();
    if (cached !== undefined && cached.expiresAt > now.getTime()) return cached.parsed;

    const response = await this.#client.get(`/${path.replace("/", "/view/")}`);
    if (response.status === 404) {
      throw new SourceRecordNotFoundError(this.sourceId, id);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new SourceAccessError(
        this.sourceId,
        `card returned unexpected HTTP ${response.status}`,
      );
    }
    const parsed = parseGoszakupkiCard({
      html: response.body,
      url: response.url,
      fetchedAt: now.toISOString(),
    });
    if (parsed.card.sourceProcurementId !== id) {
      throw new SourceAccessError(
        this.sourceId,
        `card identity mismatch: expected ${id}, received ${parsed.card.sourceProcurementId}`,
      );
    }
    this.#cache.set(path, {
      expiresAt: now.getTime() + this.#cacheTtlMs,
      parsed,
    });
    return parsed;
  }
}

function sourcePath(id: SourceProcurementId): string {
  if (!/^(auction|marketing|request|etrade|single-source|limited)\/\d+$/.test(id)) {
    throw new SourceRecordNotFoundError("goszakupki_by", id);
  }
  return id;
}

function searchPath(query: SearchQuery, term: string | undefined, page: number): string {
  const parameters = new URLSearchParams();
  if (term !== undefined) parameters.set("TendersSearch[text]", term);
  setText(parameters, "num", query.procurementNumber);
  setText(parameters, "unp", query.buyerUnp);
  setText(parameters, "customer_text", query.buyerText);
  setNumber(parameters, "price_from", query.priceFrom);
  setNumber(parameters, "price_to", query.priceTo);
  setDate(parameters, "created_from", query.publishedFrom);
  setDate(parameters, "created_to", query.publishedTo);
  setDate(parameters, "request_end_from", query.requestEndFrom);
  setDate(parameters, "request_end_to", query.requestEndTo);
  setDate(parameters, "auction_date_from", query.auctionFrom);
  setDate(parameters, "auction_date_to", query.auctionTo);
  setList(parameters, "type", query.typeIds);
  setList(parameters, "status", query.statusIds);
  setList(parameters, "region", query.regionIds);
  if (page > 1) parameters.set("page", String(page));
  const encoded = parameters.toString();
  return encoded.length === 0 ? "/tenders/posted" : `/tenders/posted?${encoded}`;
}

function setText(parameters: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined && value.trim().length > 0) parameters.set(`TendersSearch[${key}]`, value.trim());
}

function setNumber(parameters: URLSearchParams, key: string, value: number | undefined): void {
  if (value !== undefined) parameters.set(`TendersSearch[${key}]`, String(value));
}

function setDate(parameters: URLSearchParams, key: string, value: string | undefined): void {
  const formatted = sourceDate(value);
  if (formatted !== undefined) parameters.set(`TendersSearch[${key}]`, formatted);
}

function setList(parameters: URLSearchParams, key: string, values: readonly string[]): void {
  for (const value of values) {
    if (value.trim().length > 0) parameters.append(`TendersSearch[${key}][]`, value.trim());
  }
}

function sourceDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const [year, month, day] = value.slice(0, 10).split("-");
  return year === undefined || month === undefined || day === undefined
    ? undefined
    : `${day}.${month}.${year}`;
}

type SearchRow = ReturnType<typeof parseGoszakupkiSearchPage>["rows"][number];

interface SearchBucket {
  term: string | undefined;
  rows: readonly SearchRow[];
}

function interleaveSearchBuckets(
  buckets: readonly SearchBucket[],
): Array<{ row: SearchRow; terms: string[] }> {
  const merged: Array<{ row: SearchRow; terms: string[] }> = [];
  const byId = new Map<string, { row: SearchRow; terms: string[] }>();
  const size = Math.max(0, ...buckets.map((bucket) => bucket.rows.length));
  for (let index = 0; index < size; index += 1) {
    for (const bucket of buckets) {
      const row = bucket.rows[index];
      if (row === undefined) continue;
      const id = row.hit.sourceProcurementId;
      let entry = byId.get(id);
      if (entry === undefined) {
        entry = { row, terms: [] };
        byId.set(id, entry);
        merged.push(entry);
      }
      if (bucket.term !== undefined && !entry.terms.includes(bucket.term)) {
        entry.terms.push(bucket.term);
      }
    }
  }
  return merged;
}

function sourceSequence(id: string): number {
  const value = Number(id.split("/").at(-1));
  return Number.isFinite(value) ? value : 0;
}
