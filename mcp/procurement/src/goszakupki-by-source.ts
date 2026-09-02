import {
  ProcurementGetChangesResponse,
  ProcurementGetDocumentsResponse,
  ProcurementGetHistoryResponse,
  ProcurementGetLotsResponse,
  ProcurementGetStatusResponse,
  ProcurementSearchResponse,
  SourceId,
  type IsoDateTime,
  type ProcurementSourcePort,
  type SearchQuery,
  type SourceProcurementId,
} from "@procurement/contracts";
import type { ParsedGoszakupkiCard } from "./goszakupki-by-parser.js";
import {
  parseGoszakupkiCard,
  parseGoszakupkiSearchPage,
} from "./goszakupki-by-parser.js";
import type { GoszakupkiPageClient } from "./goszakupki-by-http.js";
import { SourceAccessError, SourceRecordNotFoundError } from "./source-registry.js";

export interface GoszakupkiBySourceOptions {
  client: GoszakupkiPageClient;
  cacheTtlMs?: number;
  now?: () => Date;
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
  readonly #cache = new Map<string, CacheEntry>();

  constructor(options: GoszakupkiBySourceOptions) {
    this.#client = options.client;
    this.#cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.#now = options.now ?? (() => new Date());
  }

  async search(query: SearchQuery): Promise<ProcurementSearchResponse> {
    const terms = query.keywords.length === 0 ? [undefined] : query.keywords;
    const rows = new Map<
      string,
      ReturnType<typeof parseGoszakupkiSearchPage>["rows"][number]
    >();
    const pagesPerTerm = Math.min(
      10,
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
      }
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
    return ProcurementGetDocumentsResponse.parse({
      documents: (await this.#load(id)).documents,
    });
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
  const publishedFrom = sourceDate(query.publishedFrom);
  const publishedTo = sourceDate(query.publishedTo);
  if (publishedFrom !== undefined) parameters.set("TendersSearch[created_from]", publishedFrom);
  if (publishedTo !== undefined) parameters.set("TendersSearch[created_to]", publishedTo);
  if (page > 1) parameters.set("page", String(page));
  const encoded = parameters.toString();
  return encoded.length === 0 ? "/tenders/posted" : `/tenders/posted?${encoded}`;
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
  const haystack = normalise(
    [row.hit.title, row.hit.buyerName, row.hit.sourceStatus]
      .filter((value): value is string => value !== undefined)
      .join(" "),
  );
  if (
    query.keywords.length > 0 &&
    !query.keywords.some((keyword) => haystack.includes(normalise(keyword)))
  ) {
    return false;
  }
  return !query.excludeKeywords.some((keyword) => haystack.includes(normalise(keyword)));
}

function sourceSequence(id: string): number {
  const value = Number(id.split("/").at(-1));
  return Number.isFinite(value) ? value : 0;
}

function normalise(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-BY").replace(/\s+/g, " ").trim();
}
