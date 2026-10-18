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
import { ButbViewExpiredError, type ButbPage, type ButbPageClient } from "./butb-http.js";
import {
  butbRegistryHit,
  butbRegistryPublishDate,
  butbTotalRecords,
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
  /**
   * Wall-clock budget for one search scan. Registry pages are postbacks on
   * a throttled session — the cap must fit the MCP call timeout even when
   * no watermark stops the scan early, or every deep query dies silently.
   */
  maxSearchMs?: number;
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

/** Rows per registry page — verified live and in fixtures. */
const PAGE_SIZE = 20;
/** Bound on remembered row positions so the map cannot grow forever. */
const POSITION_CACHE_LIMIT = 10_000;

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
  readonly #maxSearchMs: number;
  readonly #maxGetPages: number;
  readonly #cardCacheTtlMs: number;
  readonly #baseUrl: string;
  readonly #now: () => Date;
  readonly #publicFetch: PublicDocumentationFetch;
  readonly #logger: Logger;
  readonly #cache = new Map<string, CacheEntry>();
  /**
   * registryNumber → last seen absolute row index. New records only push
   * rows deeper, so a remembered index is a lower bound — card lookups
   * start next to it instead of page 1. Free to maintain: the row index is
   * already inside every link id the parser sees.
   */
  readonly #positions = new Map<string, number>();
  /**
   * registryNumber → until when "absent from the registry" may be trusted.
   * A vanished card costs a bounded probe per call otherwise — and one
   * monitoring read can chain get/getStatus/getDocuments on the same id.
   */
  readonly #missing = new Map<string, number>();

  constructor(options: ButbSourceOptions) {
    this.#client = options.client;
    this.#maxSearchPages = options.maxSearchPages ?? 60;
    // 180 s leaves headroom under the 300 s procurement.search tool budget
    // at the default 12 rpm pacing (~5 s per page postback → ~40 pages).
    this.#maxSearchMs = options.maxSearchMs ?? 180_000;
    this.#maxGetPages = options.maxGetPages ?? 60;
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
    const candidates = new Map<string, { row: ButbRegistryRow; terms: string[] }>();
    let page = 1;
    let scannedRows = 0;

    const watermark = dateFloor(query.publishedFrom);
    const deadline = this.#now().getTime() + this.#maxSearchMs;
    let hasMore = false;
    // Resume position left by a previous truncated scan — the caller persists
    // the token across restarts, so this call continues below the recorded
    // row instead of re-reading the whole registry head. While `tail` stays
    // false the loop is in the head phase: it collects posts newer than the
    // pass that wrote the token (they only ever sit at the top) and looks
    // for the cursor row or the first row older than its date band —
    // everything below that point is the unread tail either way.
    const parsed = parseButbScanCursor(query.scanCursor);
    // A token written under other terms or filters marks a window this
    // query never scanned — resuming it would skip rows unread for these
    // terms, so a fingerprint mismatch falls back to a fresh scan.
    const resume =
      parsed !== undefined && parsed.t === butbSearchFingerprint(query) ? parsed : undefined;
    if (query.scanCursor !== undefined && resume === undefined) {
      this.#logger.warn("butb scan cursor could not be parsed — fresh scan", {
        component: "butb-source",
      });
    }
    // A resumed window is a fresh range: the caller's offset counts rows of
    // the previous window and must not skip candidates inside this one —
    // the cursor itself is the position.
    const effectiveOffset = resume === undefined ? query.offset : 0;
    const budget = effectiveOffset + query.limit;
    let tail = resume === undefined;
    let deepestRead: ButbRegistryRow | undefined;
    // Last row of the page before the current one — needed so a truncation
    // that already collected more candidates than the page returns can
    // resume from a position that re-reads the overflow instead of losing it.
    let beforeDeepestPage: ButbRegistryRow | undefined;
    while (page <= this.#maxSearchPages) {
      if (this.#now().getTime() >= deadline) {
        // The scan ran out of wall clock, not out of registry — the tail
        // is genuinely unread, so the window must admit more may follow.
        hasMore = true;
        break;
      }
      const rendered = await this.#client.registryPage(page);
      if (rendered.status < 200 || rendered.status >= 300) {
        throw new SourceAccessError(
          this.sourceId,
          `registry page ${page} returned HTTP ${rendered.status}`,
        );
      }
      const rows = registryPageRows(page, rendered.body);
      if (rows.length === 0) break;
      scannedRows += rows.length;
      for (const row of rows) this.#rememberPosition(row);
      beforeDeepestPage = deepestRead;
      deepestRead = rows[rows.length - 1] ?? deepestRead;
      let pageBeforeWatermark = false;
      let belowCursor = false;
      for (const row of rows) {
        const rowDate = rowDateOf(row);
        if (watermark !== undefined && rowDate !== undefined && rowDate < watermark) {
          // Rows are published-desc: deeper rows cannot get newer again.
          pageBeforeWatermark = true;
          continue;
        }
        if (!tail && resume !== undefined) {
          if (row.registryNumber === resume.n) belowCursor = true;
          else if (
            resume.d !== undefined &&
            rowDate !== undefined &&
            rowDate < resume.d
          ) {
            // The cursor row left the registry — the date band is the
            // honest boundary: every row below it is unscanned.
            belowCursor = true;
          }
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
      if (!tail) {
        // Rows below the cursor row on this page were already collected
        // above; the rest of the registry is the tail — keep scanning.
        if (belowCursor) tail = true;
      } else if (candidates.size >= budget) {
        // Stopped while rows remained — a page cap or a full window is the
        // source's own "more may follow" signal, same as goszakupki's.
        hasMore = true;
        break;
      }
      if (page === this.#maxSearchPages) {
        hasMore = true;
        break;
      }
      page += 1;
    }

    const merged = [...candidates.values()]
      .map(({ row, terms: matched }) => ({ row, terms: matched }))
      .sort((left, right) => compareInstant(right.row.publishedAt, left.row.publishedAt));

    // A truncated scan hands back where it stopped. The token points at the
    // deepest row whose page was fully returned: when the stop page pushed
    // candidates past the slice, its overflow rows were read but not sent —
    // anchoring on the previous page's last row re-reads exactly that page.
    let scanCursor: string | undefined;
    if (hasMore) {
      const unreturned = merged.length > effectiveOffset + query.limit;
      const anchor =
        tail && unreturned && beforeDeepestPage !== undefined
          ? beforeDeepestPage
          : tail
            ? deepestRead
            : undefined;
      if (anchor !== undefined) {
        scanCursor = encodeButbScanCursor(anchor, query);
      } else {
        // The head phase never passed the old cursor — re-emitting a
        // shallower position would rewind the window.
        scanCursor = query.scanCursor;
        if (scanCursor === undefined && deepestRead !== undefined) {
          scanCursor = encodeButbScanCursor(deepestRead, query);
        }
      }
    }

    const hits = merged
      .slice(effectiveOffset, effectiveOffset + query.limit)
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
      resumed: resume !== undefined,
      tail,
    });
    return ProcurementSearchResponse.parse({
      hits,
      hasMore,
      ...(scanCursor === undefined ? {} : { scanCursor }),
    });
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
    const now = this.#now();
    const missingUntil = this.#missing.get(registryNumber);
    if (missingUntil !== undefined && missingUntil > now.getTime()) {
      throw new SourceRecordNotFoundError(this.sourceId, id);
    }
    const cached = this.#cache.get(registryNumber);
    if (cached !== undefined && cached.expiresAt > now.getTime()) return cached.parsed;

    const targetDate = butbRegistryPublishDate(registryNumber);
    // Locate → open is one session sequence: a row link id exists only while
    // the table shows its page, so no other call may interleave a pageChange.
    const locateAndOpen = (): Promise<ButbPage> =>
      this.#client.withSession(async () => {
        const row = await this.#locateRow(registryNumber, targetDate);
        if (row === undefined) {
          if (this.#missing.size >= POSITION_CACHE_LIMIT) this.#missing.clear();
          this.#missing.set(registryNumber, now.getTime() + this.#cardCacheTtlMs);
          throw new SourceRecordNotFoundError(this.sourceId, id);
        }
        this.#missing.delete(registryNumber);
        return this.#client.openCard(row.cardLinkId);
      });
    let cardPage: ButbPage;
    try {
      cardPage = await locateAndOpen();
    } catch (error) {
      // The transport retries a dead view by reposting the same stale link
      // id, which cannot resolve on a fresh session — the whole locate+open
      // sequence must run again instead.
      if (!(error instanceof ButbViewExpiredError)) throw error;
      cardPage = await locateAndOpen();
    }
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

  #rememberPosition(row: ButbRegistryRow): void {
    if (this.#positions.size >= POSITION_CACHE_LIMIT) this.#positions.clear();
    this.#positions.set(row.registryNumber, row.rowIndex);
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
      const rows = registryPageRows(page, rendered.body);
      for (const row of rows) this.#rememberPosition(row);
      return rows;
    };

    let boundaryLow = 1;
    let boundaryHigh: number | undefined;
    let high = 2;

    // A remembered index is a lower bound — the registry is ordered by a
    // publication timestamp we cannot see (the column shows only the date),
    // so publications only ever push the row deeper. The lookup therefore
    // starts on its page and trusts the index over the displayed date.
    const hint = this.#positions.get(registryNumber);
    if (hint !== undefined) {
      const hintPage = Math.floor(hint / PAGE_SIZE) + 1;
      const rows = await readPage(hintPage);
      const hit = rows.find((row) => row.registryNumber === registryNumber);
      if (hit !== undefined) return hit;
      const newestOnHint = dateOfFirstRow(rows);
      if (rows.length === 0) {
        // Registry is shorter than the hint — it shrank; search above.
        boundaryHigh = hintPage;
      } else if (
        targetDate !== undefined &&
        newestOnHint !== undefined &&
        newestOnHint <= targetDate
      ) {
        // Every row on the hinted page is at-or-older than the card's date —
        // removals above pushed the row UP, so bound the probe above.
        boundaryLow = 0;
        boundaryHigh = hintPage;
      } else {
        boundaryLow = hintPage;
        high = hintPage * 2;
      }
      if (targetDate === undefined) {
        // No ordering to exploit: bounded forward scan from the hint.
        for (let page = hintPage + 1; reads < this.#maxGetPages; page += 1) {
          const scan = await readPage(page);
          if (scan.length === 0) return undefined;
          const found = scan.find((row) => row.registryNumber === registryNumber);
          if (found !== undefined) return found;
        }
        return undefined;
      }
    } else {
      // Fast path: the row may sit on the first page (most lookups are fresh).
      const rows = await readPage(1);
      const direct = rows.find((row) => row.registryNumber === registryNumber);
      if (direct !== undefined) return direct;
      if (rows.length === 0 || targetDate === undefined) {
        // Without a publish date there is no ordering guarantee to exploit —
        // scan forward a bounded number of pages.
        for (let page = 2; page <= Math.min(this.#maxGetPages, 60); page += 1) {
          const scan = await readPage(page);
          if (scan.length === 0) return undefined;
          const found = scan.find((row) => row.registryNumber === registryNumber);
          if (found !== undefined) return found;
        }
        return undefined;
      }
    }

    // Exponential probe: jump outward until the page's newest row is already
    // older than the card's publish date — the boundary is inside the gap.
    while (boundaryHigh === undefined) {
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
      boundaryLow = high;
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
    // The column shows only the day — every same-date page is one stratum,
    // and the row may sit pages past the boundary. Walk forward while the
    // page still carries the target date; stop when its OLDEST row is older
    // (deeper pages can only get older) or the registry/run budget ends.
    for (let page = boundaryHigh + 1; reads < this.#maxGetPages; page += 1) {
      const scan = await readPage(page);
      if (scan.length === 0) return undefined;
      const hit = scan.find((row) => row.registryNumber === registryNumber);
      if (hit !== undefined) return hit;
      const dated = scan
        .map((row) => rowDateOf(row))
        .filter((d): d is string => d !== undefined);
      if (dated.length === 0) return undefined;
      if (dated.reduce((a, b) => (a < b ? a : b)) < targetDate) return undefined;
    }
    return undefined;
  }
}

/**
 * Parses a registry page and refuses silently-degraded markup: when the
 * paginator advertises records the page index is inside, but no rows — or
 * fewer than a full page on a non-final page — parsed, the table markup
 * regressed. A loud error beats a quiet partial read: rows skipped mid-scan
 * are rows nobody ever sees.
 */
function registryPageRows(page: number, body: string): ButbRegistryRow[] {
  const rows = parseButbRegistryRows(body);
  const total = butbTotalRecords(body);
  if (total === undefined || total === 0) return rows;
  const lastPage = Math.ceil(total / PAGE_SIZE);
  if (rows.length === 0 && page <= lastPage) {
    throw new SourceAccessError(
      "butb",
      `registry page ${page} parsed to zero rows while the paginator reports ${String(total)} records`,
    );
  }
  if (rows.length > 0 && rows.length < PAGE_SIZE && page < lastPage) {
    throw new SourceAccessError(
      "butb",
      `registry page ${page} parsed ${String(rows.length)} of ${String(PAGE_SIZE)} rows — incomplete markup, refusing a partial read`,
    );
  }
  return rows;
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

/**
 * Resume token a truncated scan hands back: the deepest registry row it
 * actually read, opaque to the caller but durable across restarts. `n`
 * (registry number) finds the row wherever new posts pushed it; `d` is the
 * fallback boundary when the row left the registry; `i` records the index
 * it was seen at. The index is deliberately never trusted for a position
 * comparison — inserts shift every absolute index, so only the row's
 * identity and its date band can bound the resume.
 */
interface ButbScanCursor {
  v: 1;
  /** Query fingerprint — a token written for other terms/filters cannot bound this window. */
  t: string;
  n?: string;
  i?: number;
  d?: string;
}

const BUTB_SCAN_CURSOR_VERSION = 1;

/**
 * The fields that decide which registry rows this query collects — terms,
 * filters and the watermark bound. Paging fields (limit/offset/scanCursor)
 * are deliberately outside: they change per call inside one window.
 */
function butbSearchFingerprint(query: SearchQuery): string {
  return JSON.stringify([
    query.keywords,
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

function encodeButbScanCursor(row: ButbRegistryRow, query: SearchQuery): string {
  const cursor: ButbScanCursor = {
    v: BUTB_SCAN_CURSOR_VERSION,
    t: butbSearchFingerprint(query),
    n: row.registryNumber,
    i: row.rowIndex,
  };
  const date = rowDateOf(row);
  if (date !== undefined) cursor.d = date;
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function parseButbScanCursor(token: string | undefined): ButbScanCursor | undefined {
  if (token === undefined || token.length === 0) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null) return undefined;
    const cursor = decoded as ButbScanCursor;
    if (cursor.v !== BUTB_SCAN_CURSOR_VERSION) return undefined;
    if (typeof cursor.t !== "string" || cursor.t.length === 0) return undefined;
    if (typeof cursor.n !== "string" || cursor.n.length === 0) return undefined;
    return cursor;
  } catch {
    return undefined;
  }
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
