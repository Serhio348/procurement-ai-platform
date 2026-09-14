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
import { listingMatchesAnyKeyword } from "@procurement/domain";
import { expandPublicDocumentation } from "./documentation-expand.js";
import type { ParsedGoszakupkiCard } from "./goszakupki-by-parser.js";
import {
  parseGoszakupkiCard,
  parseGoszakupkiSearchPage,
} from "./goszakupki-by-parser.js";
import type { GoszakupkiPageClient } from "./goszakupki-by-http.js";
import { downloadPublicDocumentation, type PublicDocumentationFetch } from "./public-download.js";
import { SourceAccessError, SourceRecordNotFoundError } from "./source-registry.js";

export interface GoszakupkiBySourceOptions {
  client: GoszakupkiPageClient;
  cacheTtlMs?: number;
  now?: () => Date;
  publicFetch?: PublicDocumentationFetch;
}

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
  readonly #cache = new Map<string, CacheEntry>();

  constructor(options: GoszakupkiBySourceOptions) {
    this.#client = options.client;
    this.#cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.#now = options.now ?? (() => new Date());
    this.#publicFetch = options.publicFetch ?? fetch;
  }

  async search(query: SearchQuery): Promise<ProcurementSearchResponse> {
    // Each profile line is its own platform query: the site's text filter
    // matches a substring, so joining several lines into one phrase returns
    // nothing.
    const terms = query.keywords.length === 0 ? [undefined] : query.keywords;
    const rows = new Map<
      string,
      ReturnType<typeof parseGoszakupkiSearchPage>["rows"][number]
    >();
    const pagesPerTerm = Math.min(
      30,
      Math.max(1, Math.ceil((query.offset + query.limit) / 20) + 1),
    );

    for (const term of terms) {
      for (let page = 1; page <= pagesPerTerm; page += 1) {
        const path = searchPath(query, term, page);
        const response = await this.#client.get(path);
        if (response.status < 200 || response.status >= 300) {
          throw new SourceAccessError(
            this.sourceId,
            `search returned unexpected HTTP ${response.status}`,
          );
        }
        const parsed = parseGoszakupkiSearchPage(response.body, response.url);
        for (const row of parsed.rows) {
          if (!matchesSearchRow(row, query)) continue;
          rows.set(row.hit.sourceProcurementId, row);
        }
        if (!parsed.hasNextPage) break;
        if (rows.size >= query.offset + query.limit) break;
      }
      if (rows.size >= query.offset + query.limit) break;
    }

    const hits = [...rows.values()]
      .sort((left, right) => sourceSequence(right.hit.sourceProcurementId) -
        sourceSequence(left.hit.sourceProcurementId))
      .map((row) => row.hit)
      .slice(query.offset, query.offset + query.limit);
    return ProcurementSearchResponse.parse({ hits });
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
  if (!/^(auction|marketing|request|etrade|single-source)\/\d+$/.test(id)) {
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

function matchesSearchRow(
  row: ReturnType<typeof parseGoszakupkiSearchPage>["rows"][number],
  query: SearchQuery,
): boolean {
  if (query.kinds.length > 0 && !query.kinds.includes(row.kind)) return false;
  const haystack = [
    row.hit.title,
    row.hit.buyerName,
    row.hit.sourceStatus,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  // The site's text filter is a substring. Drop rows where the keyword is
  // only letters inside another word («НКУ» in «конкурс»). Abbreviations and
  // inflected terms still match via termOccurs.
  if (query.keywords.length > 0 && !listingMatchesAnyKeyword(haystack, query.keywords)) {
    return false;
  }
  return true;
}

function sourceSequence(id: string): number {
  const value = Number(id.split("/").at(-1));
  return Number.isFinite(value) ? value : 0;
}
