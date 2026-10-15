import {
  ProcurementGetChangesResponse,
  ProcurementGetDocumentsResponse,
  ProcurementGetHistoryResponse,
  ProcurementGetLotsResponse,
  ProcurementGetStatusResponse,
  ProcurementSearchResponse,
  SourceId,
  type IsoDateTime,
  type ProcurementFileBytes,
  type ProcurementSourcePort,
  type SearchQuery,
  type SourceProcurementId,
} from "@procurement/contracts";
import { silentLogger, type Logger } from "@procurement/observability";
import type { ButbPageClient } from "./butb-http.js";
import {
  butbRegistryHit,
  butbRegistryPublishDate,
  parseButbCard,
  parseButbRegistryRows,
  butbKind,
  butbStatus,
  type ButbRegistryRow,
  type ParsedButbCard,
} from "./butb-parser.js";
import {
  downloadPublicDocumentation,
  createSafePublicFetch,
  type PublicDocumentationFetch,
} from "./public-download.js";
import { SourceAccessError, SourceRecordNotFoundError } from "./source-registry.js";

export interface ButbSourceOptions {
  client: ButbPageClient;
  /** Registry pages a single search scan may read. */
  maxSearchPages?: number;
  /** Page reads a single card lookup may spend locating the row. */
  maxGetPages?: number;
  cardCacheTtlMs?: number;
  baseUrl?: string;
  now?: () => Date;
  publicFetch?: PublicDocumentationFetch;
  logger?: Logger;
}

interface CacheEntry {
  expiresAt: number;
  parsed: ParsedButbCard;
}

/**
 * BUTB adapter. The site has no usable server-side subject search for an
 * anonymous reader — expanding the registry's search panel degrades the
 * session's table to a single «Вид закупки» column (verified live). Instead
 * the adapter walks the registry pages newest-first — the table is sorted
 * by publish date — and applies the profile terms as a local title filter.
 * The watermark (`publishedFrom`) bounds the scan exactly like the goszakupki
 * source's own page bound: reading stops as soon as a page falls behind it.
 */
export class ButbSource implements ProcurementSourcePort {
  readonly sourceId = SourceId.parse("butb");
  readonly #client: ButbPageClient;
  readonly #maxSearchPages: number;
  readonly #maxGetPages: number;
  readonly #cardCacheTtlMs: number;
  readonly #baseUrl: string;
  readonly #now: () => Date;
  readonly #publicFetch: PublicDocumentationFetch;
  readonly #logger: Logger;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(options: ButbSourceOptions) {
    this.#client = options.client;
    this.#maxSearchPages = options.maxSearchPages ?? 30;
    this.#maxGetPages = options.maxGetPages ?? 40;
    this.#cardCacheTtlMs = options.cardCacheTtlMs ?? 60_000;
    this.#baseUrl = options.baseUrl ?? "https://zakupki.butb.by";
    this.#now = options.now ?? (() => new Date());
    this.#publicFetch = options.publicFetch ?? createSafePublicFetch();
    this.#logger = options.logger ?? silentLogger;
  }

  async search(query: SearchQuery): Promise<ProcurementSearchResponse> {
    const terms = query.keywords.map((term) => term.trim()).filter((term) => term.length > 0);
    const excluded = query.excludeKeywords
      .map((term) => normalize(term))
      .filter((term) => term.length > 0);
    const budget = query.offset + query.limit;
    const candidates = new Map<string, { row: ButbRegistryRow; terms: string[] }>();
    let page = 1;
    let scannedRows = 0;

    const watermark = dateFloor(query.publishedFrom);
    let hasMore = false;
    while (page <= this.#maxSearchPages) {
      const rendered = await this.#client.registryPage(page);
      if (rendered.status < 200 || rendered.status >= 300) {
        throw new SourceAccessError(
          this.sourceId,
          `registry page ${page} returned HTTP ${rendered.status}`,
        );
      }
      const rows = parseButbRegistryRows(rendered.body);
      if (rows.length === 0) break;
      scannedRows += rows.length;
      let pageBeforeWatermark = false;
      for (const row of rows) {
        const rowDate = rowDateOf(row);
        if (watermark !== undefined && rowDate !== undefined && rowDate < watermark) {
          // Rows are published-desc: deeper rows cannot get newer again.
          pageBeforeWatermark = true;
          continue;
        }
        if (!this.#rowMatches(row, query)) continue;
        const matched = terms.filter((term) => matchesTerm(row.title, term));
        if (terms.length > 0 && matched.length === 0) continue;
        if (excluded.length > 0 && excluded.some((term) => normalize(row.title).includes(term))) {
          continue;
        }
        const key = row.registryNumber;
        const entry = candidates.get(key);
        if (entry === undefined) candidates.set(key, { row, terms: matched });
        else for (const term of matched) if (!entry.terms.includes(term)) entry.terms.push(term);
      }
      if (pageBeforeWatermark) break;
      if (candidates.size >= budget || page === this.#maxSearchPages) {
        // Stopped while rows remained — a page cap or a full window is the
        // source's own "more may follow" signal, same as goszakupki's.
        hasMore = true;
        break;
      }
      page += 1;
    }

    const merged = [...candidates.values()]
      .map(({ row, terms: matched }) => ({ row, terms: matched }))
      .sort((left, right) => compareInstant(right.row.publishedAt, left.row.publishedAt));
    const hits = merged
      .slice(query.offset, query.offset + query.limit)
      .map(({ row, terms: matched }) => {
        const hit = butbRegistryHit(row, this.#baseUrl);
        return matched.length === 0 ? hit : { ...hit, matchedSearchTerms: matched };
      });
    this.#logger.info("butb registry scan", {
      component: "butb-source",
      pages: page,
      scannedRows,
      terms,
      candidates: merged.length,
      returned: hits.length,
      hasMore,
    });
    return ProcurementSearchResponse.parse({ hits, hasMore });
  }

  #rowMatches(row: ButbRegistryRow, query: SearchQuery): boolean {
    if (query.procurementNumber.length > 0) {
      const wanted = query.procurementNumber.trim().toLocaleLowerCase("en-US");
      if (!row.registryNumber.toLocaleLowerCase("en-US").includes(wanted)) return false;
    }
    if (query.buyerText.length > 0 && row.buyerName !== undefined) {
      if (!normalize(row.buyerName).includes(normalize(query.buyerText))) return false;
    }
    if (query.kinds.length > 0 && !query.kinds.includes(butbKind(row.kindLabel))) return false;
    if (query.statuses.length > 0 && !query.statuses.includes(butbStatus(row.sourceStatus))) {
      return false;
    }
    const published = rowDateOf(row);
    // publishedFrom is the scan's early-stop watermark, handled by the page
    // loop; publishedTo only filters rows that are too new.
    const to = dateFloor(query.publishedTo);
    if (published !== undefined && to !== undefined && published > to) return false;
    const deadline = rowDateOf(row, "deadline");
    const endFrom = dateFloor(query.requestEndFrom);
    const endTo = dateFloor(query.requestEndTo);
    if (deadline !== undefined && endFrom !== undefined && deadline < endFrom) return false;
    if (deadline !== undefined && endTo !== undefined && deadline > endTo) return false;
    const price = row.amount?.amount ?? undefined;
    if (query.priceFrom !== undefined && price !== undefined && price < query.priceFrom) {
      return false;
    }
    if (query.priceTo !== undefined && price !== undefined && price > query.priceTo) {
      return false;
    }
    return true;
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

  /** The public card carries no chronology table — verified on live markup. */
  async getHistory(id: SourceProcurementId): Promise<ProcurementGetHistoryResponse> {
    await this.#load(id);
    return ProcurementGetHistoryResponse.parse({ clarifications: [] });
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
    if (host === "zakupki.butb.by" || host.endsWith(".butb.by")) {
      const file = await this.#client.download(`${parsed.pathname}${parsed.search}`);
      if (file.status < 200 || file.status >= 300) {
        throw new SourceAccessError(
          this.sourceId,
          `document download returned HTTP ${String(file.status)}`,
        );
      }
      return {
        bytes: file.bytes,
        contentType: file.contentType ?? "application/octet-stream",
      };
    }
    return downloadPublicDocumentation(downloadUrl, this.#publicFetch);
  }

  /**
   * Locates a registry row by number and opens its card. Registry numbers
   * embed the publish date (AU**2026-10-15**…) and the table is sorted
   * newest-first, so the lookup probes pages exponentially (1, 2, 4, 8, …)
   * until a page's newest row is already older than the card's date, then
   * binary-searches the gap. A card that vanished from the registry answers
   * not-found instead of failing the whole pass.
   */
  async #load(id: SourceProcurementId): Promise<ParsedButbCard> {
    const registryNumber = registryNumberOf(id);
    const cached = this.#cache.get(registryNumber);
    const now = this.#now();
    if (cached !== undefined && cached.expiresAt > now.getTime()) return cached.parsed;

    const targetDate = butbRegistryPublishDate(registryNumber);
    // Locate → open is one session sequence: a row link id exists only while
    // the table shows its page, so no other call may interleave a pageChange.
    const cardPage = await this.#client.withSession(async () => {
      const row = await this.#locateRow(registryNumber, targetDate);
      if (row === undefined) throw new SourceRecordNotFoundError(this.sourceId, id);
      return this.#client.openCard(row.cardLinkId);
    });
    if (cardPage.status < 200 || cardPage.status >= 300) {
      throw new SourceAccessError(
        this.sourceId,
        `card page returned HTTP ${cardPage.status}`,
      );
    }
    const parsed = parseButbCard({
      html: cardPage.body,
      url: cardPage.url,
      fetchedAt: this.#now().toISOString(),
      registryNumber,
    });
    if (parsed.card.sourceProcurementId !== id) {
      throw new SourceAccessError(
        this.sourceId,
        `card identity mismatch: expected ${id}, received ${parsed.card.sourceProcurementId}`,
      );
    }
    this.#cache.set(registryNumber, {
      expiresAt: now.getTime() + this.#cardCacheTtlMs,
      parsed,
    });
    return parsed;
  }

  async #locateRow(
    registryNumber: string,
    targetDate: string | undefined,
  ): Promise<ButbRegistryRow | undefined> {
    let reads = 0;
    const readPage = async (page: number): Promise<ButbRegistryRow[]> => {
      reads += 1;
      if (reads > this.#maxGetPages) {
        throw new SourceAccessError(
          this.sourceId,
          `card lookup exceeded the page bound (${String(this.#maxGetPages)} pages)`,
        );
      }
      const rendered = await this.#client.registryPage(page);
      if (rendered.status < 200 || rendered.status >= 300) {
        throw new SourceAccessError(
          this.sourceId,
          `registry page ${page} returned HTTP ${rendered.status}`,
        );
      }
      return parseButbRegistryRows(rendered.body);
    };

    // Fast path: the row may sit on the first page (most lookups are fresh).
    let low = 1;
    let rows = await readPage(1);
    const direct = rows.find((row) => row.registryNumber === registryNumber);
    if (direct !== undefined) return direct;
    if (rows.length === 0 || targetDate === undefined) {
      // Without a publish date there is no ordering guarantee to exploit —
      // scan forward a bounded number of pages.
      for (let page = 2; page <= Math.min(this.#maxGetPages, 60); page += 1) {
        rows = await readPage(page);
        if (rows.length === 0) return undefined;
        const found = rows.find((row) => row.registryNumber === registryNumber);
        if (found !== undefined) return found;
      }
      return undefined;
    }

    // Exponential probe: jump 2,4,8,… until the page's newest row is already
    // older than the card's publish date — the boundary is inside the gap.
    let high = 2;
    let boundaryLow = low;
    let boundaryHigh: number | undefined;
    for (;;) {
      const probe = await readPage(high);
      if (probe.length === 0) {
        boundaryHigh = high;
        break;
      }
      const hit = probe.find((row) => row.registryNumber === registryNumber);
      if (hit !== undefined) return hit;
      const newest = dateOfFirstRow(probe);
      if (newest === undefined || newest <= targetDate) {
        boundaryHigh = high;
        break;
      }
      low = high;
      boundaryLow = low;
      high = Math.min(high * 2, 20_000);
    }

    // Binary search the gap for the page holding the publish date.
    while (boundaryHigh - boundaryLow > 1) {
      const mid = Math.floor((boundaryLow + boundaryHigh) / 2);
      const probe = await readPage(mid);
      const hit = probe.find((row) => row.registryNumber === registryNumber);
      if (hit !== undefined) return hit;
      const newest = dateOfFirstRow(probe);
      if (newest === undefined || newest <= targetDate) boundaryHigh = mid;
      else boundaryLow = mid;
    }
    // boundaryHigh is the first page whose newest row is already ≤ the
    // publish date — every probed page was hit-checked, but equal dates can
    // straddle the boundary onto the next page, so check it as well.
    const tail = await readPage(boundaryHigh + 1);
    return tail.find((row) => row.registryNumber === registryNumber);
  }
}

function registryNumberOf(id: SourceProcurementId): string {
  const match = /^butb\/([A-Z]{2}\d{10,})$/.exec(id);
  if (match?.[1] === undefined) throw new SourceRecordNotFoundError("butb", id);
  return match[1];
}

function rowDateOf(row: ButbRegistryRow, kind: "published" | "deadline" = "published"): string | undefined {
  const instant = kind === "published" ? row.publishedAt : row.bidsDeadline;
  if (instant === undefined) return undefined;
  return instant.precision === "date" ? instant.date : instant.at.slice(0, 10);
}

function dateOfFirstRow(rows: readonly ButbRegistryRow[]): string | undefined {
  for (const row of rows) {
    const date = rowDateOf(row);
    if (date !== undefined) return date;
  }
  return undefined;
}

function dateFloor(instant: IsoDateTime | undefined): string | undefined {
  return instant?.slice(0, 10);
}

function compareInstant(
  left: ButbRegistryRow["publishedAt"],
  right: ButbRegistryRow["publishedAt"],
): number {
  const leftValue = left === undefined ? "" : left.precision === "date" ? left.date : left.at;
  const rightValue = right === undefined ? "" : right.precision === "date" ? right.date : right.at;
  return leftValue.localeCompare(rightValue);
}

/** Case/ё-insensitive substring match for the local term filter. */
function matchesTerm(title: string, term: string): boolean {
  return normalize(title).includes(normalize(term));
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("ru-BY").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}
