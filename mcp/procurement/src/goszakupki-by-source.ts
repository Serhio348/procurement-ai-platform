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
  type ProcurementCallContext,
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
import {
  createSafePublicFetch,
  downloadPublicDocumentation,
  type PublicDocumentationFetch,
} from "./public-download.js";
import {
  SourceAccessError,
  SourceRecordNotFoundError,
  throwIfAborted,
} from "./source-registry.js";

export interface GoszakupkiBySourceOptions {
  client: GoszakupkiPageClient;
  cacheTtlMs?: number;
  /** Bound on cached card entries — expired keys are swept, then oldest (R37). */
  cacheMaxEntries?: number;
  now?: () => Date;
  publicFetch?: PublicDocumentationFetch;
  logger?: Logger;
}

/** Safety bound on pages one phrase may consume during a single search. */
export const MAX_SEARCH_PAGES_PER_TERM = 30;

interface CacheEntry {
  expiresAt: number;
  parsed: ParsedGoszakupkiCard;
}

export class GoszakupkiBySource implements ProcurementSourcePort {
  readonly sourceId = SourceId.parse("goszakupki_by");
  readonly #client: GoszakupkiPageClient;
  readonly #cacheTtlMs: number;
  readonly #cacheMaxEntries: number;
  readonly #now: () => Date;
  readonly #publicFetch: PublicDocumentationFetch;
  readonly #logger: Logger;
  readonly #cache = new Map<string, CacheEntry>();
  #statusOptions: readonly GoszakupkiStatusOption[] | undefined;

  constructor(options: GoszakupkiBySourceOptions) {
    this.#client = options.client;
    this.#cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.#cacheMaxEntries = options.cacheMaxEntries ?? 512;
    this.#now = options.now ?? (() => new Date());
    this.#publicFetch = options.publicFetch ?? createSafePublicFetch();
    this.#logger = options.logger ?? silentLogger;
  }

  /**
   * Retrieval only. Each profile phrase is its own platform query (the site
   * filters by substring, so a joined phrase returns nothing) and always
   * gets its first page: a broad phrase cannot starve the rest. After that
   * the scan keeps reading whichever phrase still has pages until the
   * unique-candidate window (offset + limit) is filled — otherwise phrases
   * whose results overlap would hide later pages entirely after dedup.
   * Rows are merged round-robin and de-duplicated by procedure id, keeping
   * every phrase that found them. Nothing here decides relevance.
   */
  async search(
    query: SearchQuery,
    ctx?: ProcurementCallContext,
  ): Promise<ProcurementSearchResponse> {
    const statusIds = await this.#resolvedStatusIds(query, ctx?.signal);
    const filteredQuery = { ...query, statusIds };
    const terms = filteredQuery.keywords.length === 0 ? [undefined] : filteredQuery.keywords;
    // Resume token from a truncated scan: per-term next page positions plus
    // the terms already read to their end. `offset` counts results of the
    // previous window — inside a resumed window it would skip the very rows
    // the resume exists to return, so it rebases to 0.
    const parsed = parseGoszakupkiScanCursor(query.scanCursor);
    // Filters change the result set behind every saved term position —
    // a fingerprint mismatch must rescan from page 1 instead of trusting
    // pages read for another query.
    const resume =
      parsed !== undefined && parsed.t === goszakupkiSearchFingerprint(filteredQuery)
        ? parsed
        : undefined;
    if (query.scanCursor !== undefined && resume === undefined) {
      this.#logger.warn("goszakupki scan cursor could not be parsed — fresh scan", {
        component: "goszakupki-by-source",
      });
    }
    const effectiveOffset = resume === undefined ? filteredQuery.offset : 0;
    const budget = effectiveOffset + filteredQuery.limit;
    const unique = new Set<string>();
    const scans: TermScan[] = terms.map((term) => {
      const key = term ?? "";
      const done = resume !== undefined && resume.e.includes(key);
      return {
        term,
        rows: [],
        seen: new Set<string>(),
        nextPage: done ? 1 : (resume?.p[key] ?? 1),
        hasNext: !done,
        pages: 0,
        seenRows: 0,
      };
    });

    const fetchNextPage = async (scan: TermScan): Promise<void> => {
      throwIfAborted(this.sourceId, ctx?.signal);
      const path = searchPath(filteredQuery, scan.term, scan.nextPage);
      const response = await this.#client.get(path, ctx?.signal);
      scan.pages += 1;
      scan.nextPage += 1;
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
      scan.seenRows += parsed.rows.length;
      for (const row of parsed.rows) {
        if (filteredQuery.kinds.length > 0 && !filteredQuery.kinds.includes(row.kind)) {
          continue;
        }
        const id = row.hit.sourceProcurementId;
        if (scan.seen.has(id)) continue;
        scan.seen.add(id);
        unique.add(id);
        scan.rows.push(row);
      }
      scan.hasNext = parsed.hasNextPage;
    };

    for (const scan of scans) {
      // A term the previous pass already read to its end is skipped — its
      // page 1 would only re-report rows the caller already saw.
      if (!scan.hasNext) continue;
      await fetchNextPage(scan);
    }
    const alive = (): TermScan[] =>
      scans.filter((scan) => scan.hasNext && scan.pages < MAX_SEARCH_PAGES_PER_TERM);
    let remaining = alive();
    while (unique.size < budget && remaining.length > 0) {
      for (const scan of remaining) {
        if (unique.size >= budget) break;
        await fetchNextPage(scan);
      }
      remaining = alive();
    }
    for (const scan of scans) {
      this.#logger.info("goszakupki.by search term", {
        component: "goszakupki-by-source",
        term: scan.term ?? "",
        pages: scan.pages,
        rows: scan.seenRows,
        kept: scan.rows.length,
        hasNext: scan.hasNext,
      });
    }

    const buckets: SearchBucket[] = scans.map((scan) => ({
      term: scan.term,
      rows: [...scan.rows].sort(
        (left, right) =>
          sourceSequence(right.hit.sourceProcurementId) -
          sourceSequence(left.hit.sourceProcurementId),
      ),
    }));
    const merged = interleaveSearchBuckets(buckets);
    const hits = merged
      .slice(effectiveOffset, effectiveOffset + filteredQuery.limit)
      .map(({ row, terms: found }) =>
        found.length === 0 ? row.hit : { ...row.hit, matchedSearchTerms: found },
      );
    // An unread phrase page is the source's own "more may follow" signal —
    // including a phrase that stopped at the page cap.
    const hasMore = scans.some((scan) => scan.hasNext);
    const scanCursor = hasMore
      ? encodeGoszakupkiScanCursor(
          scans.map((scan) => ({
            key: scan.term ?? "",
            nextPage: scan.nextPage,
            done: !scan.hasNext,
          })),
          filteredQuery,
        )
      : undefined;
    this.#logger.info("goszakupki.by search merged", {
      component: "goszakupki-by-source",
      terms: terms.map((term) => term ?? ""),
      candidates: merged.length,
      returned: hits.length,
      hasMore,
      resumed: resume !== undefined,
    });
    return ProcurementSearchResponse.parse({
      hits,
      hasMore,
      ...(scanCursor === undefined ? {} : { scanCursor }),
    });
  }

  async #resolvedStatusIds(query: SearchQuery, signal?: AbortSignal): Promise<string[]> {
    if (query.statuses.length === 0 && query.statusIds.length === 0) {
      return query.statusIds;
    }
    const options = await this.#loadStatusOptions(signal);
    return searchQueryStatusIds(query, options);
  }

  async #loadStatusOptions(signal?: AbortSignal): Promise<readonly GoszakupkiStatusOption[]> {
    if (this.#statusOptions !== undefined) return this.#statusOptions;
    const response = await this.#client.get("/tenders/posted", signal);
    if (response.status < 200 || response.status >= 300) {
      this.#statusOptions = FALLBACK_STATUS_OPTIONS;
      return this.#statusOptions;
    }
    const parsed = parseGoszakupkiSearchFilters(response.body).statuses;
    this.#statusOptions = parsed.length > 0 ? parsed : FALLBACK_STATUS_OPTIONS;
    return this.#statusOptions;
  }

  async get(id: SourceProcurementId, ctx?: ProcurementCallContext) {
    return (await this.#load(id, ctx)).card;
  }

  async getStatus(
    id: SourceProcurementId,
    ctx?: ProcurementCallContext,
  ): Promise<ProcurementGetStatusResponse> {
    const card = (await this.#load(id, ctx)).card;
    return ProcurementGetStatusResponse.parse({
      status: card.status,
      sourceStatus: card.sourceStatus,
      bidsDeadline: card.bidsDeadline,
      fetchedAt: card.fetchedAt,
    });
  }

  async getLots(
    id: SourceProcurementId,
    ctx?: ProcurementCallContext,
  ): Promise<ProcurementGetLotsResponse> {
    return ProcurementGetLotsResponse.parse({
      lots: (await this.#load(id, ctx)).card.lots,
    });
  }

  async getDocuments(
    id: SourceProcurementId,
    ctx?: ProcurementCallContext,
  ): Promise<ProcurementGetDocumentsResponse> {
    const parsed = await this.#load(id, ctx);
    const documents = await expandPublicDocumentation(
      parsed.documents,
      this.#publicFetch,
      () => parsed.card.fetchedAt,
    );
    return ProcurementGetDocumentsResponse.parse({ documents });
  }

  async getHistory(
    id: SourceProcurementId,
    ctx?: ProcurementCallContext,
  ): Promise<ProcurementGetHistoryResponse> {
    return ProcurementGetHistoryResponse.parse({
      clarifications: (await this.#load(id, ctx)).history,
    });
  }

  async getChanges(
    id: SourceProcurementId,
    _since?: IsoDateTime,
    ctx?: ProcurementCallContext,
  ): Promise<ProcurementGetChangesResponse> {
    await this.#load(id, ctx);
    return ProcurementGetChangesResponse.parse({ changes: [] });
  }

  async download(
    downloadUrl: string,
    ctx?: ProcurementCallContext,
  ): Promise<ProcurementFileBytes> {
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
      const file = await this.#client.download(
        `${parsed.pathname}${parsed.search}`,
        ctx?.signal,
      );
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

  async #load(
    id: SourceProcurementId,
    ctx?: ProcurementCallContext,
  ): Promise<ParsedGoszakupkiCard> {
    const path = sourcePath(id);
    const cached = this.#cache.get(path);
    const now = this.#now();
    if (cached !== undefined && cached.expiresAt > now.getTime()) return cached.parsed;

    const response = await this.#client.get(
      `/${path.replace("/", "/view/")}`,
      ctx?.signal,
    );
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
    this.#evictCache(now.getTime());
    return parsed;
  }

  /** Expired entries never left the map — memory grew with uptime (R37). */
  #evictCache(nowMs: number): void {
    if (this.#cache.size <= this.#cacheMaxEntries) return;
    for (const [key, entry] of this.#cache) {
      if (this.#cache.size <= this.#cacheMaxEntries) return;
      if (entry.expiresAt <= nowMs) this.#cache.delete(key);
    }
    // Still over the bound: Map iterates in insertion order — drop oldest.
    for (const key of this.#cache.keys()) {
      if (this.#cache.size <= this.#cacheMaxEntries) return;
      this.#cache.delete(key);
    }
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

interface TermScan {
  term: string | undefined;
  rows: SearchRow[];
  seen: Set<string>;
  nextPage: number;
  hasNext: boolean;
  pages: number;
  seenRows: number;
}

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

/**
 * Resume token for a truncated scan: per-term next page positions plus the
 * terms already read to their last page. Unlike the BUTB registry — which
 * is one shared ordered list — each phrase here is its own server-side
 * result set, so the position is per term. New posts shift page contents
 * between calls; a resumed page may overlap or skip a row — downstream
 * dedup absorbs the overlap, and the window watermark bounds the risk.
 */
interface GoszakupkiScanCursor {
  v: 1;
  /**
   * Query fingerprint minus keywords — per-term `p` keys already handle a
   * changed term set (an unseen term simply starts at page 1), while a
   * changed filter must rescan every term because the site returns
   * different result sets for it.
   */
  t: string;
  /** term ("" for the term-less scan) → next unread page. */
  p: Record<string, number>;
  /** terms read to their end — their next unread page does not exist. */
  e: string[];
}

const GOSZAKUPKI_SCAN_CURSOR_VERSION = 1;

function goszakupkiSearchFingerprint(query: SearchQuery): string {
  return JSON.stringify([
    query.excludeKeywords,
    query.buyerUnp,
    query.buyerText,
    query.procurementNumber,
    query.priceFrom ?? null,
    query.priceTo ?? null,
    query.publishedFrom ?? "",
    query.publishedTo ?? "",
    query.requestEndFrom ?? "",
    query.requestEndTo ?? "",
    query.auctionFrom ?? "",
    query.auctionTo ?? "",
    query.regionIds,
    query.typeIds,
    query.statusIds,
    query.statuses,
    query.kinds,
  ]);
}

function encodeGoszakupkiScanCursor(
  terms: ReadonlyArray<{ key: string; nextPage: number; done: boolean }>,
  query: SearchQuery,
): string {
  const cursor: GoszakupkiScanCursor = {
    v: GOSZAKUPKI_SCAN_CURSOR_VERSION,
    t: goszakupkiSearchFingerprint(query),
    p: {},
    e: [],
  };
  for (const term of terms) {
    if (term.done) cursor.e.push(term.key);
    else cursor.p[term.key] = term.nextPage;
  }
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function parseGoszakupkiScanCursor(token: string | undefined): GoszakupkiScanCursor | undefined {
  if (token === undefined || token.length === 0) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null) return undefined;
    const cursor = decoded as GoszakupkiScanCursor;
    if (cursor.v !== GOSZAKUPKI_SCAN_CURSOR_VERSION) return undefined;
    if (typeof cursor.t !== "string" || cursor.t.length === 0) return undefined;
    if (typeof cursor.p !== "object" || cursor.p === null) return undefined;
    if (!Array.isArray(cursor.e)) return undefined;
    for (const page of Object.values(cursor.p)) {
      if (typeof page !== "number" || !Number.isInteger(page) || page < 1) return undefined;
    }
    if (cursor.e.some((term) => typeof term !== "string")) return undefined;
    return cursor;
  } catch {
    return undefined;
  }
}
