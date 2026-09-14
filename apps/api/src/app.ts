import {
  InboxFixtureItem,
  ProcedureCard,
  type SearchQuery,
  SpecialistArchiveWrite,
  SpecialistDecisionWrite,
  SpecialistDiscoveryHealthResponse,
  SpecialistDiscoveryResponse,
  SpecialistIngestProgress,
  SpecialistInboxListResponse,
  SpecialistInboxResolveResponse,
  SpecialistInboxResolveWrite,
  SpecialistProcurementCard,
  SpecialistProcurementListQuery,
  SpecialistProcurementListResponse,
  SpecialistProfileListResponse,
  SpecialistProfileWrite,
  SpecialistSearchRequest,
  SpecialistSearchResponse,
  SpecialistWatchWrite,
  SpecialistWorkingProfile,
  type InboxFixtureItem as InboxFixtureItemValue,
  type SearchHit,
  type SpecialistCaseDocument,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
  type SpecialistWorkspaceState,
} from "@procurement/contracts";
import {
  applyInboxChangeToCard,
  applySourceCard,
  attachProfileToCard,
  caseMatchesListTab,
  diffCardSnapshots,
  discoveryPublishedFrom,
  inboxDocumentLinks,
  inboxItemFromFoundCard,
  inboxItemFromWatchChange,
  inboxTopic,
  isConsoleListedCase,
  partitionHitsByDecision,
  profileDisplayName,
  selectRelevantSearchCards,
  shouldRunDiscovery,
  SpecialistCatalog,
  SpecialistWorkspace,
  type ReviewOutcome,
} from "@procurement/domain";
import { McpToolCallError } from "@procurement/mcp-client";
import { silentLogger, type Logger } from "@procurement/observability";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  createMemoryAdminJournal,
  recordJournal,
  type AdminJournalPort,
} from "./admin/journal.js";
import type { AuthDirectory } from "./auth/directory.js";
import type { AuthMailPort } from "./auth/mail.js";
import { registerAuth } from "./auth/register.js";
import {
  contentDisposition,
  contentTypeForName,
  defaultBlobDirectory,
  getBlob,
  isSha256Hex,
} from "./blobs.js";
import {
  createDiscoveryController,
  type DiscoveryController,
  type DiscoveryResult,
} from "./discovery-control.js";
import type { SpecialistCardWatchPort } from "./card-watch.js";
import {
  discoveryDoneMessage,
  discoveryFailedMessage,
  watchDoneMessage,
} from "./discovery-transport.js";
import type { SpecialistDocumentIngestPort } from "./document-ingest.js";
import { createIngestProgressHub } from "./ingest-progress.js";
import { loadFixtureSearchHits } from "./load-fixture.js";
import type { BlobStore } from "./object-store.js";
import type { SpecialistReviewPort } from "./search-review.js";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createMemoryCabinetRegistry,
  TEST_WORKSPACE_ID,
  type CabinetRegistry,
  type SpecialistCabinet,
} from "./cabinets.js";

export const DEFAULT_CASE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Listing rows one background pass may take per profile. With the discovery
 * watermark the source returns only what was posted since the last pass, so
 * this is a ceiling for the first pass and for busy days, not a per-hour cap.
 */
export const DEFAULT_DISCOVERY_LIMIT = 100;
/**
 * Decided cases one background pass re-reads. Each one costs a procurement.get,
 * so the ceiling keeps a growing watch list from turning an hourly pass into a
 * crawl of the whole source.
 */
export const DEFAULT_WATCH_LIMIT = 40;

export interface SpecialistSearchHitsPort {
  search: (query: Omit<SearchQuery, "sourceId">) => Promise<readonly SearchHit[]>;
}

export interface SpecialistApi extends FastifyInstance {
  runDiscovery: (limit?: number) => Promise<ReturnType<typeof SpecialistDiscoveryResponse.parse>>;
}

export interface BuildApiOptions {
  catalog?: SpecialistCatalog;
  workspace?: SpecialistWorkspace;
  logger?: Logger;
  blobDirectory?: string;
  searchHits?: SpecialistSearchHitsPort;
  /** Second look at weak / keyword-less hits. Absent: they all wait in the inbox. */
  searchReview?: SpecialistReviewPort;
  /** Re-reads cases the specialist follows. Absent: monitoring stays off. */
  cardWatch?: SpecialistCardWatchPort;
  /** Decided cases one pass may re-read. */
  watchLimit?: number;
  documentIngest?: SpecialistDocumentIngestPort;
  liveProcurementsOnly?: boolean;
  persistWorkspace?: (state: SpecialistWorkspaceState, workspaceId?: string) => Promise<void>;
  persistCases?: (
    cards: readonly SpecialistProcurementCardValue[],
    workspaceId?: string,
  ) => Promise<void>;
  persistInbox?: (items: readonly InboxFixtureItemValue[], workspaceId?: string) => Promise<void>;
  removeCases?: (ids: readonly string[], workspaceId?: string) => Promise<void>;
  cabinets?: CabinetRegistry;
  /** How long an undecided live case survives without a search returning it. */
  caseMaxAgeMs?: number;
  blobStore?: BlobStore;
  clock?: () => string;
  ingestProgress?: ReturnType<typeof createIngestProgressHub>;
  authDirectory?: AuthDirectory;
  authMail?: AuthMailPort;
  authCookieSecure?: boolean;
  authPublicUrl?: string;
  internalApiToken?: string;
  journal?: AdminJournalPort;
  discoveryController?: DiscoveryController;
}

export async function buildSpecialistApi(options: BuildApiOptions = {}): Promise<SpecialistApi> {
  const defaultCabinet: SpecialistCabinet = {
    workspaceId: TEST_WORKSPACE_ID,
    catalog: options.catalog ?? new SpecialistCatalog(),
    workspace: options.workspace ?? new SpecialistWorkspace(),
  };
  defaultCabinet.catalog.dismissMany(defaultCabinet.workspace.dismissedInboxIds());
  const singleton = options.cabinets === undefined && options.authDirectory === undefined;
  const cabinets =
    options.cabinets ??
    createMemoryCabinetRegistry({
      defaultCabinet,
      singleton: singleton || options.catalog !== undefined || options.workspace !== undefined,
    });
  const cabinetAls = new AsyncLocalStorage<SpecialistCabinet>();
  const currentCabinet = (): SpecialistCabinet => cabinetAls.getStore() ?? defaultCabinet;
  const catalog = (): SpecialistCatalog => currentCabinet().catalog;
  const workspace = (): SpecialistWorkspace => currentCabinet().workspace;
  const logger = options.logger ?? silentLogger;
  const blobDirectory = options.blobDirectory ?? defaultBlobDirectory();
  const searchHits = options.searchHits ?? { search: loadDefaultSearchHits };
  const searchReview = options.searchReview;
  const cardWatch = options.cardWatch;
  const watchLimit = options.watchLimit ?? DEFAULT_WATCH_LIMIT;
  const documentIngest = options.documentIngest;
  const ingestProgress = options.ingestProgress ?? createIngestProgressHub();
  const liveProcurementsOnly = options.liveProcurementsOnly === true;
  const clock = options.clock ?? (() => new Date().toISOString());
  const journal = options.journal ?? createMemoryAdminJournal();
  const caseMaxAgeMs = options.caseMaxAgeMs ?? DEFAULT_CASE_MAX_AGE_MS;
  const discoveryController = options.discoveryController ?? createDiscoveryController();
  const persist = async (): Promise<void> => {
    const cabinet = currentCabinet();
    await cabinets.persist(cabinet);
    if (options.persistWorkspace !== undefined) {
      await options.persistWorkspace(cabinet.workspace.snapshot(), cabinet.workspaceId);
    }
    if (options.persistCases !== undefined) {
      await options.persistCases(cabinet.catalog.storedCases(), cabinet.workspaceId);
    }
    if (options.persistInbox !== undefined) {
      await options.persistInbox(cabinet.catalog.inboxItems(), cabinet.workspaceId);
    }
  };

  // Cases the specialist never touched do not pile up: once a search stops
  // returning them for caseMaxAgeMs they leave the catalog and the database.
  const pruneStaleCases = async (): Promise<void> => {
    const removed = catalog().prune({
      now: clock(),
      maxAgeMs: caseMaxAgeMs,
      keepSourceIds: workspace().decidedSourceIds(),
    });
    const cutoff = new Date(Date.parse(clock()) - caseMaxAgeMs).toISOString();
    const staleIds = await cabinets.listStaleUndecidedIds(
      currentCabinet().workspaceId,
      cutoff,
      [...workspace().decidedSourceIds()],
    );
    const ids = [...new Set([...removed, ...staleIds])];
    if (ids.length === 0) return;
    workspace().setDismissedInboxIds(catalog().dismissedIds());
    logger.info("Specialist stale cases pruned", { count: ids.length });
    if (options.removeCases !== undefined) {
      await options.removeCases(ids, currentCabinet().workspaceId);
    }
    await cabinets.removeCases(currentCabinet().workspaceId, ids);
  };

  async function hydrateSourceCard(
    card: SpecialistProcurementCardValue,
  ): Promise<SpecialistProcurementCardValue> {
    if (cardWatch === undefined) return card;
    try {
      const live = await cardWatch.read(card.sourceProcurementId);
      if (live === undefined) return card;
      return withTriage(applySourceCard(card, live, clock()), workspace());
    } catch (error) {
      logger.error("Specialist source card hydrate failed", error, {
        sourceProcurementId: card.sourceProcurementId,
      });
      return card;
    }
  }

  const listPage = async (
    query: {
      tab?: "listed" | "all" | "monitor" | "participate" | "archive" | "trash";
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const tab = query.tab ?? "listed";
    const offset = query.offset ?? 0;
    const liveOnly = liveProcurementsOnly && tab === "listed";
    const page = await cabinets.listCases(currentCabinet().workspaceId, {
      tab,
      limit: query.limit ?? 100,
      offset,
      liveOnly,
      ...(tab === "trash" ? {} : { rejectedSourceIds: workspace().rejectedSourceIds() }),
    });
    const rejectedSourceIds = workspace().rejectedSourceIds();
    const items = page.items
      .map((item) => withTriage(item, workspace()))
      .filter((item) =>
        tab === "trash"
          ? item.triage === "reject"
          : isConsoleListedCase(item, {
              ...(liveOnly ? { liveOnly: true } : {}),
              rejectedSourceIds,
            }) && caseMatchesListTab(item, tab),
      );
    return SpecialistProcurementListResponse.parse({
      items,
      total: page.total,
      tab,
      hasMore: offset + page.items.length < page.total,
    });
  };

  const resolveCase = async (
    id: string,
  ): Promise<SpecialistProcurementCardValue | undefined> => {
    const fromStore = await cabinets.getCase(currentCabinet().workspaceId, id);
    if (fromStore !== undefined) return withTriage(fromStore, workspace());
    const fromCatalog = catalog().procurement(id);
    if (fromCatalog === undefined) return undefined;
    return withTriage(fromCatalog, workspace());
  };

  const app = Fastify({ logger: false });
  // Fastify's own logger is off; without this a throwing route answers 500
  // and leaves nothing in the journal to debug from.
  app.setErrorHandler((error: unknown, request, reply) => {
    const failure = error as { statusCode?: unknown; code?: unknown };
    const statusCode = typeof failure.statusCode === "number" ? failure.statusCode : 500;
    if (statusCode >= 500) {
      logger.error("Specialist API request failed", error, {
        method: request.method,
        url: request.url,
      });
    }
    return reply.code(statusCode).send({
      error:
        statusCode >= 500
          ? "internal_error"
          : typeof failure.code === "string"
            ? failure.code
            : "request_failed",
    });
  });
  registerAuth(app, {
    ...(options.authDirectory === undefined ? {} : { directory: options.authDirectory }),
    ...(options.authMail === undefined ? {} : { mail: options.authMail }),
    ...(options.authCookieSecure === undefined ? {} : { cookieSecure: options.authCookieSecure }),
    ...(options.authPublicUrl === undefined ? {} : { publicUrl: options.authPublicUrl }),
    ...(options.internalApiToken === undefined ? {} : { internalApiToken: options.internalApiToken }),
    journal,
    provisionWorkspace: (user) => cabinets.ensurePersonalWorkspace(user.id, user.name),
    workspaceIdFor: (userId) => cabinets.workspaceIdFor(userId),
  });
  app.addHook("onRequest", async (request) => {
    const workspaceId = request.principal?.workspaceId ?? TEST_WORKSPACE_ID;
    request.cabinet = await cabinets.open(workspaceId);
  });
  app.addHook("preHandler", (request, _reply, done) => {
    cabinetAls.run(request.cabinet ?? defaultCabinet, () => {
      done();
    });
  });

  /**
   * `publishedFrom` narrows the site query for background discovery: the
   * later of the profile's own filter and the discovery watermark wins.
   */
  function buildSearchQuery(
    profile: SpecialistWorkingProfile,
    limit: number,
    offset: number,
    publishedFrom?: string,
  ): Omit<SearchQuery, "sourceId"> {
    const { filters } = profile;
    const fromDate = [filters.publishedFrom, publishedFrom]
      .filter((value): value is string => value !== undefined)
      .sort()
      .at(-1);
    return {
      keywords: [...profile.keywords],
      excludeKeywords: [...profile.excludeKeywords],
      buyerUnp: filters.buyerUnp ?? "",
      buyerText: filters.buyerText ?? "",
      procurementNumber: filters.procurementNumber ?? "",
      priceFrom: filters.priceFrom,
      priceTo: filters.priceTo,
      publishedFrom: fromDate === undefined ? undefined : toIsoDateTime(fromDate),
      publishedTo: filters.publishedTo ? toIsoDateTime(filters.publishedTo) : undefined,
      requestEndFrom: filters.requestEndFrom ? toIsoDateTime(filters.requestEndFrom) : undefined,
      requestEndTo: filters.requestEndTo ? toIsoDateTime(filters.requestEndTo) : undefined,
      auctionFrom: filters.auctionFrom ? toIsoDateTime(filters.auctionFrom) : undefined,
      auctionTo: filters.auctionTo ? toIsoDateTime(filters.auctionTo) : undefined,
      typeIds: [...(filters.typeIds ?? [])],
      statusIds: [...(filters.statusIds ?? [])],
      regionIds: [...(filters.regionIds ?? [])],
      kinds: [],
      limit,
      offset,
    };
  }

  /**
   * Puts a found card into the catalog. A case seen before keeps its
   * documents and facts; only the listing fields, lastSeenAt and the profile
   * link are refreshed. A review case that a later search matches exactly is
   * promoted to "match"; the reverse never happens.
   */
  async function rememberFound(
    card: SpecialistProcurementCardValue,
    profileId: string,
    now: string,
  ): Promise<{ card: SpecialistProcurementCardValue; isNew: boolean }> {
    const existing =
      catalog()
        .procurements()
        .find((item) => item.sourceProcurementId === card.sourceProcurementId) ??
      (await cabinets.findCaseBySource(
        currentCabinet().workspaceId,
        card.sourceProcurementId,
      ));
    const foundAs = card.foundAs === "match" || existing?.foundAs === "match" ? "match" : card.foundAs;
    const merged: SpecialistProcurementCardValue =
      existing === undefined
        ? { ...card, lastSeenAt: now }
        : {
            ...existing,
            title: card.title,
            statusLabel: card.statusLabel,
            live: existing.live === true || card.live === true,
            ...(card.buyerName === undefined ? {} : { buyerName: card.buyerName }),
            ...(card.amountLabel === undefined ? {} : { amountLabel: card.amountLabel }),
            ...(foundAs === undefined ? {} : { foundAs }),
            lastSeenAt: now,
          };
    const owned = withTriage(attachProfileToCard(merged, profileId), workspace());
    catalog().upsertCase(owned);
    return { card: owned, isNew: existing === undefined };
  }

  /**
   * Weak and keyword-less hits get a second look when a review port is
   * configured: the card first, then the model. A confident "relevant" joins
   * the list as a match; a confident "irrelevant" is discarded and remembered
   * for the profile; everything else waits in the inbox with the reason
   * attached to the card. A hit already remembered as irrelevant, or already
   * waiting in the inbox as a review case, is not looked at again: the source
   * returning it once more is not new information.
   */
  async function reviewAmbiguous(
    selected: ReturnType<typeof selectRelevantSearchCards>,
    profile: SpecialistWorkingProfile,
    now: string,
    options: { inboxForMatches: boolean },
  ): Promise<{ matched: SpecialistProcurementCardValue[]; discarded: number; ambiguousCount: number }> {
    const rejected = workspace().rejectedSourceIds();
    const sourceIds = selected.ambiguousCards.map((item) => item.sourceProcurementId);
    const stored = await cabinets.loadCasesBySources(currentCabinet().workspaceId, sourceIds);
    const known = new Map(
      catalog().procurements().map((item) => [item.sourceProcurementId, item] as const),
    );
    for (const [sourceId, card] of stored) {
      if (!known.has(sourceId)) known.set(sourceId, card);
    }
    let discarded = 0;
    let ambiguousCount = 0;
    const pending: Array<{ card: SpecialistProcurementCardValue; hit: SearchHit }> = [];
    for (const [index, card] of selected.ambiguousCards.entries()) {
      const hit = selected.ambiguousHits[index];
      if (hit === undefined || rejected.has(card.sourceProcurementId)) continue;
      if (workspace().isReviewedIrrelevant(profile.id, card.sourceProcurementId)) {
        discarded += 1;
        continue;
      }
      if (known.get(card.sourceProcurementId)?.foundAs === "review") {
        await rememberFound(card, profile.id, now);
        ambiguousCount += 1;
        continue;
      }
      pending.push({ card, hit });
    }
    const outcomes =
      searchReview === undefined || pending.length === 0
        ? undefined
        : await searchReview.review(
            pending.map((item) => item.hit),
            {
              name: profileDisplayName(profile),
              ...(profile.purpose === undefined ? {} : { purpose: profile.purpose }),
              ...(profile.description === undefined ? {} : { description: profile.description }),
              keywords: profile.keywords,
              excludeKeywords: profile.excludeKeywords,
            },
          );
    const matched: SpecialistProcurementCardValue[] = [];
    for (const [index, { card }] of pending.entries()) {
      const outcome = outcomes?.[index];
      if (outcome?.verdict === "irrelevant") {
        discarded += 1;
        workspace().rememberIrrelevant(profile.id, card.sourceProcurementId, now);
        continue;
      }
      const reviewedCard: SpecialistProcurementCardValue =
        outcome === undefined
          ? card
          : {
              ...card,
              ...(outcome.verdict === "relevant" ? { foundAs: "match" as const } : {}),
              actions: [
                ...card.actions,
                {
                  step: card.actions.length + 1,
                  actor: "DomainSearchAgent",
                  status: "done",
                  detail: `${reviewActor(outcome.decidedBy)}: ${outcome.reason}`,
                },
              ],
            };
      const remembered = await rememberFound(reviewedCard, profile.id, now);
      if (outcome?.verdict === "relevant") {
        matched.push(remembered.card);
        if (options.inboxForMatches && remembered.isNew) {
          catalog().record(inboxItemFromFoundCard(remembered.card, now));
        }
        continue;
      }
      ambiguousCount += 1;
      if (remembered.isNew) catalog().record(inboxItemFromFoundCard(remembered.card, now));
    }
    return { matched, discarded, ambiguousCount };
  }

  /**
   * Re-reads the cases the specialist chose to follow and reports what moved.
   * The first reading of a case only stores a snapshot: without a previous one
   * there is no change, and announcing "found" again would be noise. Cases are
   * taken oldest-snapshot-first so a watch list longer than the per-pass
   * ceiling still gets round-robin coverage instead of starving its tail.
   */
  async function monitorDecidedCases(now: string): Promise<{
    monitoredCount: number;
    changedCount: number;
  }> {
    if (cardWatch === undefined || watchLimit <= 0) {
      return { monitoredCount: 0, changedCount: 0 };
    }
    const followed = (await cabinets.listWatchedCases(currentCabinet().workspaceId, watchLimit)).map(
      (item) => withTriage(item, workspace()),
    );
    let monitoredCount = 0;
    let changedCount = 0;
    for (const card of followed) {
      await discoveryController.beforeRequest(new Date());
      const fresh = await cardWatch.read(card.sourceProcurementId);
      if (fresh === undefined) continue;
      monitoredCount += 1;
      const previous = card.watchSnapshot;
      let next: SpecialistProcurementCardValue;
      try {
        next = applySourceCard(card, fresh, now);
      } catch (error) {
        logger.error("Specialist watched case could not store the source card", error, {
          sourceProcurementId: card.sourceProcurementId,
        });
        continue;
      }
      if (previous === undefined) {
        catalog().upsertCase(next);
        continue;
      }
      const snapshot = next.watchSnapshot;
      if (snapshot === undefined) {
        catalog().upsertCase(next);
        continue;
      }
      const changes = diffCardSnapshots(previous, snapshot);
      if (changes.length === 0) {
        catalog().upsertCase(next);
        continue;
      }
      changedCount += 1;
      for (const change of changes) {
        const item = catalog().record(inboxItemFromWatchChange(next, change, now));
        next = withTriage(applyInboxChangeToCard(next, item.item.change), workspace());
        next = applySourceCard(next, fresh, now);
      }
      catalog().upsertCase(next);
      logger.info("Specialist watched case changed", {
        sourceProcurementId: card.sourceProcurementId,
        kinds: changes.map((item) => item.kind),
      });
    }
    return { monitoredCount, changedCount };
  }

  /**
   * A pass that only monitored (profile watch is off) must still keep what it
   * found: the snapshots and the new inbox rows are saved and journalled here,
   * because the discovery path below returns before reaching persist().
   */
  async function finishMonitoringOnly(monitored: {
    monitoredCount: number;
    changedCount: number;
  }): Promise<void> {
    if (monitored.monitoredCount === 0) return;
    await persist();
    await recordJournal(journal, {
      kind: "discovery",
      level: "info",
      message: watchDoneMessage(monitored),
    });
  }

  async function runManualSearch(
    limit: number,
    offset: number,
  ): Promise<ReturnType<typeof SpecialistSearchResponse.parse>> {
    const profile = workspace().profile();
    const hits = await searchHits.search(buildSearchQuery(profile, limit, offset));
    const selected = selectRelevantSearchCards(
      hits,
      {
        keywords: profile.keywords,
        excludeKeywords: profile.excludeKeywords,
        statuses: profile.statuses,
        excludeSingleSource: profile.excludeSingleSource,
      },
      limit,
    );
    const now = clock();
    let skippedRejected = 0;
    const resultItems: SpecialistProcurementCardValue[] = [];
    for (const card of selected.cards) {
      if (workspace().rejectedSourceIds().has(card.sourceProcurementId)) {
        skippedRejected += 1;
        continue;
      }
      resultItems.push((await rememberFound(card, profile.id, now)).card);
    }
    const reviewed = await reviewAmbiguous(selected, profile, now, { inboxForMatches: false });
    resultItems.push(...reviewed.matched);
    const relevantCount = resultItems.length;
    const discardedCount =
      selected.discardedCount + skippedRejected + reviewed.discarded;
    logger.info("Specialist profile search recorded", {
      profileName: profile.name,
      relevantCount,
      discardedCount,
      ambiguousCount: reviewed.ambiguousCount,
    });
    await pruneStaleCases();
    await persist();
    return SpecialistSearchResponse.parse({
      profileName: profileDisplayName(profile),
      relevantCount,
      discardedCount,
      ambiguousCount: reviewed.ambiguousCount,
      hasMore: hits.length >= limit,
      items: resultItems,
    });
  }

  async function discoveryPass(limit: number) {
      // Following a decided case is not the same promise as looking for new
      // ones: a specialist who turned "watch new" off still expects to hear
      // that the procedure he entered was cancelled.
      const monitored = await monitorDecidedCases(clock());
      const watched = workspace().profiles().filter((item) =>
        shouldRunDiscovery(item.watchNewProcurements),
      );
      if (watched.length === 0) {
        const result: DiscoveryResult = {
          ran: false,
          reason: "watch_off",
          addedCount: 0,
          skippedDecidedCount: 0,
        };
        await finishMonitoringOnly(monitored);
        return SpecialistDiscoveryResponse.parse({
          ...result,
          ...monitored,
          items: (await listPage()).items,
        });
      }
      const ready = watched.filter((item) => item.keywords.length > 0);
      if (ready.length === 0) {
        const result: DiscoveryResult = {
          ran: false,
          reason: "no_keywords",
          addedCount: 0,
          skippedDecidedCount: 0,
        };
        await finishMonitoringOnly(monitored);
        return SpecialistDiscoveryResponse.parse({
          ...result,
          ...monitored,
          items: (await listPage()).items,
        });
      }
      let addedCount = 0;
      let skippedDecidedCount = 0;
      const known = new Set(catalog().procurements().map((item) => item.sourceProcurementId));
      const failed: Array<{ profile: SpecialistWorkingProfile; error: unknown }> = [];
      const succeeded: SpecialistWorkingProfile[] = [];
      for (const profile of ready) {
        // One profile's failure must not cost the others their pass, nor lose
        // what earlier profiles already found: the loop goes on and persists.
        let hits: readonly SearchHit[];
        const startedAt = clock();
        try {
          await discoveryController.beforeRequest(new Date());
          hits = await searchHits.search(
            buildSearchQuery(profile, limit, 0, discoveryPublishedFrom(profile)),
          );
        } catch (error) {
          logger.error("Specialist discovery search failed", error, {
            profileName: profileDisplayName(profile),
          });
          failed.push({ profile, error });
          continue;
        }
        succeeded.push(profile);
        const storedKnown = await cabinets.loadCasesBySources(
          currentCabinet().workspaceId,
          hits.map((item) => item.sourceProcurementId),
        );
        for (const sourceId of storedKnown.keys()) known.add(sourceId);
        const partitioned = partitionHitsByDecision(hits, workspace().decidedSourceIds());
        skippedDecidedCount += partitioned.skippedDecidedCount;
        const selected = selectRelevantSearchCards(
          partitioned.undecided,
          {
            keywords: profile.keywords,
            excludeKeywords: profile.excludeKeywords,
            statuses: profile.statuses,
            excludeSingleSource: profile.excludeSingleSource,
          },
          limit,
        );
        const now = clock();
        for (const card of selected.cards) {
          const remembered = await rememberFound(card, profile.id, now);
          if (!remembered.isNew) continue;
          catalog().record(inboxItemFromFoundCard(remembered.card, now));
          known.add(card.sourceProcurementId);
          addedCount += 1;
        }
        const reviewed = await reviewAmbiguous(selected, profile, now, { inboxForMatches: true });
        for (const card of reviewed.matched) {
          if (known.has(card.sourceProcurementId)) continue;
          known.add(card.sourceProcurementId);
          addedCount += 1;
        }
        // The watermark is the pass start, not its end: a procedure posted while
        // the pass ran must fall into the next window.
        workspace().markDiscovered(profile.id, startedAt);
        logger.info("Specialist discovery recorded", {
          profileName: profileDisplayName(profile),
          addedCount,
          skippedDecidedCount,
        });
      }
      workspace().forgetStaleVerdicts(clock());
      await pruneStaleCases();
      await persist();
      for (const item of failed) {
        await recordJournal(journal, {
          kind: "discovery",
          level: "error",
          message: discoveryFailedMessage(profileDisplayName(item.profile), item.error),
        });
      }
      if (succeeded.length === 0) {
        throw failed[0]?.error ?? new Error("discovery found no profile to search");
      }
      await recordJournal(journal, {
        kind: "discovery",
        level: "info",
        message: discoveryDoneMessage({
          profileNames: succeeded.map((item) => profileDisplayName(item)),
          addedCount,
          skippedDecidedCount,
          ...monitored,
        }),
      });
      const result: DiscoveryResult = {
        ran: true,
        reason: "ok",
        addedCount,
        skippedDecidedCount,
      };
      return SpecialistDiscoveryResponse.parse({
        ...result,
        ...monitored,
        items: (await listPage()).items,
      });
  }

  async function runDiscovery(limit = DEFAULT_DISCOVERY_LIMIT) {
    const start = discoveryController.tryStart(new Date());
    if (start.kind !== "started") {
      return SpecialistDiscoveryResponse.parse({
        ran: false,
        reason: start.kind === "busy" ? "already_running" : "cooldown",
        addedCount: 0,
        skippedDecidedCount: 0,
        items: (await listPage()).items,
      });
    }
    try {
      const scoped = cabinetAls.getStore();
      const ids =
        scoped !== undefined ? [scoped.workspaceId] : await cabinets.listIds();
      const targets = ids.length > 0 ? ids : [defaultCabinet.workspaceId];
      let addedCount = 0;
      let skippedDecidedCount = 0;
      let monitoredCount = 0;
      let changedCount = 0;
      let ran = false;
      let reason: ReturnType<typeof SpecialistDiscoveryResponse.parse>["reason"] = "watch_off";
      let items: SpecialistProcurementCardValue[] = [];
      for (const id of targets) {
        const cabinet = await cabinets.open(id);
        const part = await cabinetAls.run(cabinet, () => discoveryPass(limit));
        addedCount += part.addedCount;
        skippedDecidedCount += part.skippedDecidedCount;
        monitoredCount += part.monitoredCount;
        changedCount += part.changedCount;
        ran = ran || part.ran;
        if (part.ran) reason = "ok";
        else if (reason === "watch_off") reason = part.reason;
        items = part.items;
      }
      const result: DiscoveryResult = { ran, reason, addedCount, skippedDecidedCount };
      discoveryController.finish(result, new Date());
      return SpecialistDiscoveryResponse.parse({
        ...result,
        monitoredCount,
        changedCount,
        items,
      });
    } catch (error) {
      discoveryController.recordFailure(error, new Date());
      throw error;
    }
  }

  app.get("/api/health", async () => ({ ok: true as const }));

  app.get("/api/admin/discovery", async () => {
    const ids = await cabinets.listIds();
    let watchingCount = 0;
    for (const id of ids.length > 0 ? ids : [defaultCabinet.workspaceId]) {
      const cabinet = await cabinets.open(id);
      watchingCount += cabinet.workspace
        .profiles()
        .filter((item) => shouldRunDiscovery(item.watchNewProcurements)).length;
    }
    return SpecialistDiscoveryHealthResponse.parse({
      health: discoveryController.health(watchingCount),
    });
  });

  function profileList() {
    return SpecialistProfileListResponse.parse({
      items: workspace().profiles(),
      activeProfileId: workspace().profile().id,
    });
  }

  app.get("/api/profiles", async () => profileList());

  app.post("/api/profiles", async () => {
    const created = workspace().addProfile();
    await persist();
    logger.info("Specialist working profile created", { id: created.id });
    return SpecialistWorkingProfile.parse(created);
  });

  app.post("/api/profiles/:id/activate", async (request, reply) => {
    const params = request.params as { id: string };
    if (workspace().findProfile(params.id) === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    workspace().activate(params.id);
    await persist();
    return SpecialistWorkingProfile.parse(workspace().profile());
  });

  app.put("/api/profiles/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const parsed = SpecialistProfileWrite.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (workspace().findProfile(params.id) === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    const saved = workspace().replaceProfileById(params.id, parsed.data);
    await persist();
    logger.info("Specialist working profile saved", {
      id: saved.id,
      name: profileDisplayName(saved),
      keywordCount: saved.keywords.length,
    });
    return SpecialistWorkingProfile.parse(saved);
  });

  app.delete("/api/profiles/:id", async (request, reply) => {
    const params = request.params as { id: string };
    if (workspace().findProfile(params.id) === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (workspace().profiles().length === 1) {
      return reply.code(409).send({ error: "last_profile" });
    }
    workspace().removeProfile(params.id);
    await persist();
    logger.info("Specialist working profile removed", { id: params.id });
    return profileList();
  });

  app.post("/api/profiles/:id/watch", async (request, reply) => {
    const params = request.params as { id: string };
    const parsed = SpecialistWatchWrite.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (workspace().findProfile(params.id) === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    const saved = workspace().setWatchById(params.id, parsed.data.watchNewProcurements);
    await persist();
    logger.info("Specialist profile watch updated", {
      id: saved.id,
      watchNewProcurements: saved.watchNewProcurements,
    });
    return SpecialistWorkingProfile.parse(saved);
  });

  app.get("/api/profile", async () => SpecialistWorkingProfile.parse(workspace().profile()));

  app.put("/api/profile", async (request, reply) => {
    const parsed = SpecialistProfileWrite.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    workspace().replaceProfile(parsed.data);
    await persist();
    const saved = workspace().profile();
    logger.info("Specialist working profile saved", {
      name: profileDisplayName(saved),
      keywordCount: saved.keywords.length,
    });
    return SpecialistWorkingProfile.parse(saved);
  });

  app.post("/api/profile/watch", async (request, reply) => {
    const parsed = SpecialistWatchWrite.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    workspace().setWatch(parsed.data.watchNewProcurements);
    await persist();
    logger.info("Specialist profile watch updated", {
      watchNewProcurements: parsed.data.watchNewProcurements,
    });
    return SpecialistWorkingProfile.parse(workspace().profile());
  });

  app.post("/api/profile/discovery", async (request, reply) => {
    const parsed = SpecialistSearchRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    try {
      return await runDiscovery(parsed.data.limit);
    } catch (error) {
      await noteSearchFailure(journal, error);
      return mapSearchError(reply, error);
    }
  });

  app.get("/api/inbox", async () =>
    SpecialistInboxListResponse.parse({ items: catalog().urgentInbox() }),
  );

  app.post("/api/inbox/events", async (request, reply) => {
    const parsed = InboxFixtureItem.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const recorded = catalog().record(parsed.data);
    logger.info("Specialist inbox event recorded", {
      duplicate: recorded.duplicate,
      changeId: recorded.item.change.id,
    });
    return reply.code(recorded.duplicate ? 200 : 201).send(
      SpecialistInboxListResponse.parse({ items: catalog().urgentInbox() }),
    );
  });

  app.delete("/api/inbox/:id", async (request, reply) => {
    const params = request.params as { id: string };
    if (!catalog().dismiss(params.id)) {
      return reply.code(404).send({ error: "not_found" });
    }
    workspace().setDismissedInboxIds(catalog().dismissedIds());
    await persist();
    return SpecialistInboxListResponse.parse({ items: catalog().urgentInbox() });
  });

  app.post("/api/inbox/:id/resolve", async (request, reply) => {
    const params = request.params as { id: string };
    const parsed = SpecialistInboxResolveWrite.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const item = catalog().inboxItem(params.id);
    if (item === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    const topic = inboxTopic(item.change.kind);
    const action = parsed.data.action;
    if (action === "refresh" && topic !== "card_update") {
      return reply.code(400).send({ error: "invalid_action" });
    }
    if (action === "documents" && topic !== "documents") {
      return reply.code(400).send({ error: "invalid_action" });
    }

    let card = await resolveCase(item.change.procurementId);
    // Opening from the inbox takes the case onto the procurements list,
    // including a review hit that had been waiting only in the inbox.
    if (action !== "dismiss" && card !== undefined) {
      const listed =
        action === "open" || card.foundAs === "review"
          ? { ...card, foundAs: "match" as const }
          : card;
      card = withTriage(attachProfileToCard(listed, workspace().profile().id), workspace());
      catalog().upsertCase(card);
    }
    if (action === "refresh" && card !== undefined) {
      card = withTriage(applyInboxChangeToCard(card, item.change), workspace());
      catalog().upsertCase(card);
    }
    if (action === "documents" && card !== undefined && documentIngest !== undefined) {
      ingestProgress.begin(card.id);
      try {
        card = withTriage(await documentIngest.ingest(card), workspace());
        ingestProgress.done(card.id);
        catalog().upsertCase(card);
      } catch (error) {
        ingestProgress.fail(card.id);
        logger.error("Specialist inbox document ingest failed", error, {
          sourceProcurementId: card.sourceProcurementId,
        });
        await recordJournal(journal, {
          kind: "documents",
          level: "error",
          message: `Не удалось скачать документы: ${card.sourceProcurementId}`,
          sourceProcurementId: card.sourceProcurementId,
        });
      }
    }

    catalog().dismiss(params.id);
    workspace().setDismissedInboxIds(catalog().dismissedIds());
    await persist();
    logger.info("Specialist inbox resolved", {
      changeId: params.id,
      action,
      topic,
    });
    return SpecialistInboxResolveResponse.parse({
      items: catalog().urgentInbox(),
      documents: action === "documents" ? inboxDocumentLinks(card) : [],
      ...(card === undefined ? {} : { card }),
    });
  });

  app.get("/api/procurements", async (request, reply) => {
    const parsed = SpecialistProcurementListQuery.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    return listPage(parsed.data);
  });

  app.post("/api/procurements/search", async (request, reply) => {
    const parsed = SpecialistSearchRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (workspace().profile().keywords.length === 0) {
      return reply.code(400).send({ error: "no_keywords" });
    }
    try {
      return await runManualSearch(parsed.data.limit, parsed.data.offset);
    } catch (error) {
      logger.error("Specialist profile search failed", error);
      await noteSearchFailure(journal, error);
      return mapSearchError(reply, error);
    }
  });

  app.post("/api/procurements/:id/decision", async (request, reply) => {
    const params = request.params as { id: string };
    const parsed = SpecialistDecisionWrite.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const card = await resolveCase(params.id);
    if (card === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    workspace().recordDecision(card.sourceProcurementId, parsed.data.kind, clock());
    let next = withTriage(card, workspace());
    // One stdio MCP process cannot run get + get_documents at once: the
    // responses cross and the platform card is lost while files still arrive.
    if (parsed.data.kind === "monitor" || parsed.data.kind === "participate") {
      next = await hydrateSourceCard(next);
      if (next.live !== true) {
        next = SpecialistProcurementCard.parse({ ...next, live: true });
      }
    }
    if (parsed.data.kind === "participate" && documentIngest !== undefined) {
      ingestProgress.begin(card.id);
      try {
        next = withTriage(await documentIngest.ingest(next), workspace());
        ingestProgress.done(card.id);
      } catch (error) {
        ingestProgress.fail(card.id);
        logger.error("Specialist participate document ingest failed", error, {
          sourceProcurementId: card.sourceProcurementId,
        });
        await recordJournal(journal, {
          kind: "documents",
          level: "error",
          message: `Не удалось скачать документы: ${card.sourceProcurementId}`,
          sourceProcurementId: card.sourceProcurementId,
        });
      }
    }
    catalog().upsertCase(next);
    catalog().dismissByProcurementId(next.id);
    workspace().setDismissedInboxIds(catalog().dismissedIds());
    await persist();
    logger.info("Specialist triage recorded", {
      sourceProcurementId: card.sourceProcurementId,
      kind: parsed.data.kind,
      documentCount: next.documents.length,
    });
    return SpecialistProcurementListResponse.parse({ items: [next] });
  });

  /**
   * Archive is reversible and keeps the triage kind: a returned case goes back
   * to "Слежу" or "Участвую", and monitoring resumes for it on the next pass.
   */
  app.post("/api/procurements/:id/archive", async (request, reply) => {
    const params = request.params as { id: string };
    const parsed = SpecialistArchiveWrite.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const card = await resolveCase(params.id);
    if (card === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    workspace().setArchived(card.sourceProcurementId, parsed.data.archived);
    const next = withTriage(card, workspace());
    catalog().upsertCase(next);
    await persist();
    logger.info("Specialist archive flag recorded", {
      sourceProcurementId: card.sourceProcurementId,
      archived: parsed.data.archived,
    });
    return SpecialistProcurementListResponse.parse({ items: [next] });
  });

  app.post("/api/procurements/:id/restore", async (request, reply) => {
    const params = request.params as { id: string };
    const card = await resolveCase(params.id);
    if (card === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (card.triage !== "reject") {
      return reply.code(400).send({ error: "not_in_trash" });
    }
    const kind = workspace().lastWorkingKind(card.sourceProcurementId);
    workspace().recordDecision(card.sourceProcurementId, kind, clock());
    workspace().setArchived(card.sourceProcurementId, false);
    const next = withTriage(card, workspace());
    catalog().upsertCase(next);
    await persist();
    logger.info("Specialist case restored from trash", {
      sourceProcurementId: card.sourceProcurementId,
      kind,
    });
    return SpecialistProcurementListResponse.parse({ items: [next] });
  });

  app.delete("/api/procurements/trash", async (_request, reply) => {
    const ids = await cabinets.listTrashIds(currentCabinet().workspaceId);
    for (const id of ids) {
      catalog().dropCase(id);
      catalog().dismissByProcurementId(id);
    }
    workspace().setDismissedInboxIds(catalog().dismissedIds());
    await persist();
    await cabinets.removeCases(currentCabinet().workspaceId, ids);
    if (options.removeCases !== undefined) {
      await options.removeCases(ids, currentCabinet().workspaceId);
    }
    logger.info("Specialist trash emptied", { count: ids.length });
    return reply.code(204).send();
  });

  app.delete("/api/procurements/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const card = await resolveCase(params.id);
    if (card === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (card.triage !== "reject") {
      return reply.code(400).send({ error: "not_in_trash" });
    }
    catalog().dropCase(card.id);
    catalog().dismissByProcurementId(card.id);
    workspace().setDismissedInboxIds(catalog().dismissedIds());
    await persist();
    await cabinets.removeCases(currentCabinet().workspaceId, [card.id]);
    if (options.removeCases !== undefined) {
      await options.removeCases([card.id], currentCabinet().workspaceId);
    }
    logger.info("Specialist case purged from trash", {
      sourceProcurementId: card.sourceProcurementId,
    });
    return reply.code(204).send();
  });

  app.get("/api/procurements/:id/ingest-progress", async (request, reply) => {
    const params = request.params as { id: string };
    const card = await resolveCase(params.id);
    if (card === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    return SpecialistIngestProgress.parse(ingestProgress.snapshot(card.id));
  });

  app.get("/api/procurements/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const card = await resolveCase(params.id);
    if (card === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    return card;
  });

  app.get("/api/procurements/:id/card", async (request, reply) => {
    if (cardWatch === undefined) {
      return reply.code(503).send({ error: "card_read_unavailable" });
    }
    const params = request.params as { id: string };
    const card = await resolveCase(params.id);
    if (card === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    const live = await cardWatch.read(card.sourceProcurementId);
    if (live === undefined) {
      logger.warn("Specialist source card unavailable", {
        sourceProcurementId: card.sourceProcurementId,
      });
      return reply.code(404).send({ error: "card_unavailable" });
    }
    try {
      catalog().upsertCase(withTriage(applySourceCard(card, live, clock()), workspace()));
      await persist();
    } catch (error) {
      // The page was read fine; only the console copy failed. Still show it.
      logger.error("Specialist source card store failed", error, {
        sourceProcurementId: card.sourceProcurementId,
      });
    }
    return ProcedureCard.parse(live);
  });

  app.get("/api/documents/:hash", async (request, reply) => {
    const params = request.params as { hash: string };
    if (!isSha256Hex(params.hash)) {
      return reply.code(400).send({ error: "invalid_hash" });
    }
    const document =
      findCatalogDocument(catalog(), params.hash) ??
      (await cabinets.findDocument(currentCabinet().workspaceId, params.hash));
    if (document === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (cabinets.hasDocumentHash !== undefined) {
      const allowed = await cabinets.hasDocumentHash(currentCabinet().workspaceId, params.hash);
      if (!allowed) {
        return reply.code(404).send({ error: "not_found" });
      }
    }
    const bytes =
      options.blobStore === undefined
        ? await getBlob(blobDirectory, params.hash)
        : await options.blobStore.get(params.hash);
    if (bytes === undefined) {
      return reply.code(404).send({ error: "blob_missing" });
    }
    return reply
      .header("content-type", contentTypeForName(document.name))
      .header("content-disposition", contentDisposition(document.name))
      .send(Buffer.from(bytes));
  });

  const api = Object.assign(app, { runDiscovery }) as SpecialistApi;
  return api;
}

function reviewActor(decidedBy: ReviewOutcome["decidedBy"]): string {
  switch (decidedBy) {
    case "card":
      return "procurement.get";
    case "model":
      return "Модель";
    case "quota":
      return "Проверка";
    case "none":
      return "Проверка";
  }
}

function withTriage(
  card: SpecialistProcurementCardValue,
  workspace: SpecialistWorkspace,
): SpecialistProcurementCardValue {
  const triage = workspace.latestKind(card.sourceProcurementId);
  const archived = workspace.isArchived(card.sourceProcurementId);
  if (triage === undefined) return SpecialistProcurementCard.parse({ ...card, archived });
  return SpecialistProcurementCard.parse({ ...card, triage, archived });
}

async function noteSearchFailure(journal: AdminJournalPort, error: unknown): Promise<void> {
  const message =
    error instanceof McpToolCallError && error.kind === "source_unavailable"
      ? "Площадка goszakupki.by недоступна"
      : error instanceof McpToolCallError && error.kind === "timeout"
        ? "Поиск на площадке занял слишком много времени"
        : "Поиск по профилю не выполнен";
  await recordJournal(journal, { kind: "search", level: "error", message });
}

function mapSearchError(reply: FastifyReply, error: unknown) {
  if (error instanceof McpToolCallError && error.kind === "source_unavailable") {
    return reply.code(503).send({ error: "source_unavailable" });
  }
  if (error instanceof McpToolCallError && error.kind === "timeout") {
    return reply.code(504).send({ error: "search_timeout" });
  }
  return reply.code(502).send({ error: "search_failed" });
}

async function loadDefaultSearchHits(_query: Omit<SearchQuery, "sourceId">): Promise<readonly SearchHit[]> {
  return loadFixtureSearchHits();
}

function findCatalogDocument(
  catalog: SpecialistCatalog,
  hash: string,
): SpecialistCaseDocument | undefined {
  for (const card of catalog.procurements()) {
    const document = card.documents.find((item) => item.hash === hash);
    if (document !== undefined) return document;
  }
  return undefined;
}

function toIsoDateTime(value: string): string {
  return `${value}T00:00:00+03:00`;
}
