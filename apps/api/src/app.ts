import {
  AdminCabinetListResponse,
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
  SpecialistProfileSearchRequest,
  SpecialistProfileWrite,
  SpecialistSearchProgressQuery,
  SpecialistSearchRequest,
  SpecialistSearchResponse,
  SpecialistSearchRun,
  SpecialistWatchWrite,
  SpecialistWorkingProfile,
  type InboxFixtureItem as InboxFixtureItemValue,
  type SearchHit,
  type SpecialistCaseDocument,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
  type SpecialistWorkingProfile as SpecialistWorkingProfileValue,
  type SpecialistWorkspaceState,
  type SearchIntentPlan,
} from "@procurement/contracts";
import {
  applyInboxChangeToCard,
  applySourceCard,
  attachProfileToCard,
  caseMatchesListTab,
  slimListedCard,
  bidsDeadlinePassed,
  deadlineWithin,
  diffCardSnapshots,
  discoveryPublishedFrom,
  inboxDocumentLinks,
  inboxItemFromFoundCard,
  inboxItemFromWatchChange,
  inboxTopic,
  watchTransitionKey,
  extraPlatformSearchTerms,
  inferSearchIntentPlan,
  mergeSearchIntentPlans,
  isClosedProcedureStatus,
  isPersistableCabinetCase,
  isConsoleListedCase,
  partitionHitsByDecision,
  platformSearchTerms,
  isRejectedTriage,
  isScoredSearchMatch,
  isWatchedTriage,
  profileDisplayName,
  scoreIntentCard,
  selectRelevantSearchCards,
  shouldRunDiscovery,
  type WatchChange,
  statusLabel,
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
import { profileToSiteSearchQuery } from "./profile-search-query.js";
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
import { createSearchProgressHub } from "./search-progress.js";
import { loadFixtureSearchHits } from "./load-fixture.js";
import type { BlobStore } from "./object-store.js";
import type { ReviewBudget, SpecialistReviewPort } from "./search-review.js";
import type { SearchIntentPort } from "./search-intent.js";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createMemoryCabinetRegistry,
  EMPTY_CABINET_COUNTS,
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
export const DEFAULT_DISCOVERY_LIMIT = 200;
/**
 * Decided cases one background pass re-reads. Each one costs a procurement.get,
 * so the ceiling keeps a growing watch list from turning an hourly pass into a
 * crawl of the whole source.
 */
export const DEFAULT_WATCH_LIMIT = 40;

/** «За день» до дедлайна — окно предупреждения «истекает завтра». */
const DEADLINE_SOON_MS = 36 * 60 * 60 * 1000;

export interface SpecialistSearchHitsPort {
  search: (query: Omit<SearchQuery, "sourceId">) => Promise<readonly SearchHit[]>;
  /**
   * Same search plus the source's own truncation flag when the adapter
   * reports one. Optional so simple test doubles can return plain hits.
   */
  searchDetailed?: (
    query: Omit<SearchQuery, "sourceId">,
  ) => Promise<{ hits: readonly SearchHit[]; hasMore?: boolean }>;
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
  /**
   * Turns a profile phrase into objects/actions. Absent: a cheap parser in
   * domain still builds a plan so scoring does not wait on the model.
   */
  searchIntent?: SearchIntentPort;
  /** Re-reads cases the specialist follows. Absent: monitoring stays off. */
  cardWatch?: SpecialistCardWatchPort;
  /**
   * Background re-reads for the watch pass. Same contract as cardWatch but on
   * the background MCP lane so the hourly pass cannot slow card opens.
   * Defaults to cardWatch (single-process tests and fixture mode).
   */
  monitorWatch?: SpecialistCardWatchPort;
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
  searchProgress?: ReturnType<typeof createSearchProgressHub>;
  authDirectory?: AuthDirectory;
  authMail?: AuthMailPort;
  authCookieSecure?: boolean;
  authPublicUrl?: string;
  internalApiToken?: string;
  journal?: AdminJournalPort;
  discoveryController?: DiscoveryController;
  /** PostgreSQL is the live system of record (reported by /api/health). */
  postgres?: boolean;
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
  const searchIntent = options.searchIntent;
  const cardWatch = options.cardWatch;
  const watchLimit = options.watchLimit ?? DEFAULT_WATCH_LIMIT;
  const documentIngest = options.documentIngest;
  const ingestProgress = options.ingestProgress ?? createIngestProgressHub();
  const searchProgress = options.searchProgress ?? createSearchProgressHub();
  const liveProcurementsOnly = options.liveProcurementsOnly === true;
  const clock = options.clock ?? (() => new Date().toISOString());
  const journal = options.journal ?? createMemoryAdminJournal();
  const caseMaxAgeMs = options.caseMaxAgeMs ?? DEFAULT_CASE_MAX_AGE_MS;
  const discoveryController = options.discoveryController ?? createDiscoveryController();
  const persist = async (cabinet = currentCabinet()): Promise<void> => {
    await cabinets.persist(cabinet);
    if (options.persistWorkspace !== undefined) {
      await options.persistWorkspace(cabinet.workspace.snapshot(), cabinet.workspaceId);
    }
    if (options.persistCases !== undefined) {
      const keep = new Set(
        cabinet.workspace.profiles().flatMap((profile) => [...cabinet.workspace.searchIds(profile.id)]),
      );
      await options.persistCases(
        cabinet.catalog.storedCases().filter((card) => isPersistableCabinetCase(card, keep)),
        cabinet.workspaceId,
      );
    }
    if (options.persistInbox !== undefined) {
      await options.persistInbox(cabinet.catalog.inboxItems(), cabinet.workspaceId);
    }
  };

  const persistProgress = async (
    caseIds: readonly string[],
    cabinet = currentCabinet(),
  ): Promise<void> => {
    await cabinets.persistProgress(cabinet, caseIds);
    if (options.persistWorkspace !== undefined) {
      await options.persistWorkspace(cabinet.workspace.snapshot(), cabinet.workspaceId);
    }
    if (options.persistCases !== undefined) {
      const keep = new Set(
        cabinet.workspace.profiles().flatMap((profile) => [...cabinet.workspace.searchIds(profile.id)]),
      );
      const wanted = new Set(caseIds);
      await options.persistCases(
        cabinet.catalog
          .storedCases()
          .filter((card) => wanted.has(card.id) && isPersistableCabinetCase(card, keep)),
        cabinet.workspaceId,
      );
    }
    if (options.persistInbox !== undefined) {
      await options.persistInbox(cabinet.catalog.inboxItems(), cabinet.workspaceId);
    }
  };

  async function persistWorkspaceOnly(): Promise<void> {
    const cabinet = currentCabinet();
    await cabinets.persistWorkspaceOnly(cabinet);
    if (options.persistWorkspace !== undefined) {
      await options.persistWorkspace(cabinet.workspace.snapshot(), cabinet.workspaceId);
    }
  }

  // Unused finished procedures are transient search results: an explicit
  // finished-status search may show them, but they are never persisted.
  // Watch / participate / reject stay. Untouched old live rows are removed.
  const pruneStaleCases = async (): Promise<void> => {
    const keepCaseIds = new Set(
      workspace()
        .profiles()
        .flatMap((profile) => [...workspace().searchIds(profile.id)]),
    );
    const removed = catalog().prune({
      now: clock(),
      maxAgeMs: caseMaxAgeMs,
      keepSourceIds: workspace().decidedSourceIds(),
      keepCaseIds,
    });
    const cutoff = new Date(Date.parse(clock()) - caseMaxAgeMs).toISOString();
    const staleIds = await cabinets.listStaleUndecidedIds(
      currentCabinet().workspaceId,
      cutoff,
      [...workspace().decidedSourceIds()],
      [...keepCaseIds],
    );
    const ids = [...new Set([...removed, ...staleIds])];
    if (ids.length === 0) return;
    const retainedInMemory = new Set<string>(catalog().storedCases().map((card) => card.id));
    for (const id of ids) {
      if (!retainedInMemory.has(id)) workspace().removeSearchId(id);
    }
    workspace().setDismissedInboxIds(catalog().dismissedIds());
    logger.info("Specialist stale cases pruned", { count: ids.length });
    if (options.removeCases !== undefined) {
      await options.removeCases(ids, currentCabinet().workspaceId);
    }
    await cabinets.removeCases(currentCabinet().workspaceId, ids);
    await persistWorkspaceOnly();
  };

  async function hydrateSourceCard(
    card: SpecialistProcurementCardValue,
    force = false,
  ): Promise<SpecialistProcurementCardValue> {
    if (cardWatch === undefined) return card;
    // The review already stored the platform card it scored: re-reading it
    // for a decision costs a live fetch the specialist did not ask for.
    // Explicit refresh (reindex) forces the read.
    if (!force && card.sourceCard !== undefined) return card;
    try {
      const live = await cardWatch.read(card.sourceProcurementId);
      if (live === undefined) return card;
      return applyFreshSourceCard(card, live, clock()).next;
    } catch (error) {
      logger.error("Specialist source card hydrate failed", error, {
        sourceProcurementId: card.sourceProcurementId,
      });
      return card;
    }
  }

  /**
   * Participate ingest is long and must outlive the HTTP request: switching
   * console tabs aborts the fetch, and one stdio MCP pipe cannot overlap get
   * with get_documents. Persist triage first, then download in the cabinet
   * that owned the request.
   */
  const ingestJobs = new Set<string>();
  const startDocumentJob = (
    card: SpecialistProcurementCardValue,
    run: (next: SpecialistProcurementCardValue) => Promise<SpecialistProcurementCardValue>,
    failedMessage: string,
  ): void => {
    if (ingestJobs.has(card.id)) return;
    ingestJobs.add(card.id);
    ingestProgress.begin(card.id);
    const cabinet = currentCabinet();
    void cabinetAls.run(cabinet, async () => {
      try {
        const ingested = withTriage(await run(card), workspace());
        ingestProgress.done(card.id);
        catalog().upsertCase(ingested);
        await persist(cabinet);
        logger.info("Specialist document job finished", {
          sourceProcurementId: card.sourceProcurementId,
          documentCount: ingested.documents.length,
        });
      } catch (error) {
        ingestProgress.fail(card.id);
        logger.error("Specialist document job failed", error, {
          sourceProcurementId: card.sourceProcurementId,
        });
        await recordJournal(journal, {
          kind: "documents",
          level: "error",
          message: `${failedMessage}: ${card.sourceProcurementId}`,
          sourceProcurementId: card.sourceProcurementId,
        });
      } finally {
        ingestJobs.delete(card.id);
      }
    });
  };
  const startParticipateIngest = (card: SpecialistProcurementCardValue): void => {
    const ingest = documentIngest;
    if (ingest === undefined) return;
    startDocumentJob(card, (next) => ingest.ingest(next), "Не удалось скачать документы");
  };
  const startReindex = (card: SpecialistProcurementCardValue): void => {
    const ingest = documentIngest;
    const reindex = ingest?.reindex;
    if (ingest === undefined || reindex === undefined) return;
    const hashed = card.documents.filter(
      (document) => document.hash !== undefined && document.status === "hashed",
    );
    if (hashed.length === 0) {
      startParticipateIngest(card);
      return;
    }
    startDocumentJob(card, (next) => reindex(next), "Не удалось перечитать документы");
  };

  const listPage = async (
    query: {
      tab?: "listed" | "search" | "all" | "monitor" | "participate" | "archive" | "trash";
      profileId?: string | undefined;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const tab = query.tab ?? "listed";
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;
    if (tab === "listed") {
      await pruneStaleCases();
    }
    if (tab === "search") {
      const items: SpecialistProcurementCardValue[] = [];
      const seen = new Set<string>();
      // The caller (GET /api/procurements) requires profileId for this tab.
      for (const id of workspace().searchIds(query.profileId ?? "")) {
        const card = (catalog().procurement(id) ?? (await resolveCase(id)));
        if (card === undefined) continue;
        if (isRejectedTriage(card.triage) || isWatchedTriage(card)) continue;
        // A review candidate the specialist opened from the inbox waits
        // in the queue for an explicit decision — it is not a "match".
        if (!isScoredSearchMatch(card) && card.foundAs !== "review") continue;
        if (seen.has(card.sourceProcurementId)) continue;
        seen.add(card.sourceProcurementId);
        items.push(slimListedCard(card));
      }
      return SpecialistProcurementListResponse.parse({
        items: items.slice(offset, offset + limit),
        total: items.length,
        tab,
        hasMore: offset + limit < items.length,
      });
    }
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
      items: items.map(slimListedCard),
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
    const path = request.url.split("?")[0] ?? request.url;
    if (path === "/api/health" || path.startsWith("/api/auth")) return;
    const workspaceId = request.principal?.workspaceId ?? TEST_WORKSPACE_ID;
    request.cabinet = await cabinets.open(workspaceId);
  });
  app.addHook("preHandler", (request, _reply, done) => {
    cabinetAls.run(request.cabinet ?? defaultCabinet, () => {
      done();
    });
  });
  // Slow-request log: separates server-side stalls from network/payload
  // time when a click "feels slow" but MCP calls show nothing.
  app.addHook("onResponse", (request, reply, done) => {
    const durationMs = Math.round(reply.elapsedTime);
    if (durationMs >= 500) {
      logger.info("Specialist API slow request", {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs,
      });
    }
    done();
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
    searchKeywords?: readonly string[],
  ): Omit<SearchQuery, "sourceId"> {
    return profileToSiteSearchQuery(profile, {
      limit,
      offset,
      ...(publishedFrom === undefined ? {} : { publishedFrom }),
      ...(searchKeywords === undefined ? {} : { searchKeywords }),
      toIsoDateTime,
    });
  }

  async function resolveSearchPlan(profile: SpecialistWorkingProfile): Promise<SearchIntentPlan> {
    const inferred = inferSearchIntentPlan({
      name: profileDisplayName(profile),
      keywords: profile.keywords,
      excludeKeywords: profile.excludeKeywords,
    });
    const profileName = profileDisplayName(profile);
    if (searchIntent === undefined) {
      logger.info("Specialist search plan", { profileName, source: "inferred", ...planSummary(inferred) });
      return inferred;
    }
    try {
      const fromModel = await searchIntent.plan({
        name: profileName,
        keywords: profile.keywords,
        excludeKeywords: profile.excludeKeywords,
      });
      const plan = mergeSearchIntentPlans(inferred, fromModel);
      logger.info("Specialist search plan", {
        profileName,
        source: "model+inferred",
        ...planSummary(plan),
        modelOnly: planSummary(fromModel),
      });
      return plan;
    } catch (error) {
      logger.warn("Search intent parser failed; using the cheap plan", {
        profileName,
        err: error instanceof Error ? error.message : String(error),
      });
      logger.info("Specialist search plan", { profileName, source: "inferred", ...planSummary(inferred) });
      return inferred;
    }
  }

  function planSummary(plan: SearchIntentPlan): Record<string, unknown> {
    return {
      intent: plan.intent,
      objects: plan.objects,
      desired: plan.desired_actions,
      excluded: plan.excluded_actions,
      requiredContext: plan.required_context,
      excludedContext: plan.excluded_context,
    };
  }

  async function findExistingCase(
    sourceProcurementId: string,
  ): Promise<SpecialistProcurementCardValue | undefined> {
    return (
      catalog()
        .procurements()
        .find((item) => item.sourceProcurementId === sourceProcurementId) ??
      (await cabinets.findCaseBySource(currentCabinet().workspaceId, sourceProcurementId))
    );
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
    const existing = await findExistingCase(card.sourceProcurementId);
    const foundAs = card.foundAs === "match" || existing?.foundAs === "match" ? "match" : card.foundAs;
    const merged: SpecialistProcurementCardValue =
      existing === undefined
        ? { ...card, lastSeenAt: now }
        : {
            ...existing,
            title: card.title,
            status: card.status,
            statusLabel: card.statusLabel,
            live: existing.live === true || card.live === true,
            ...(card.buyerName === undefined ? {} : { buyerName: card.buyerName }),
            ...(card.amountLabel === undefined ? {} : { amountLabel: card.amountLabel }),
            ...(foundAs === undefined ? {} : { foundAs }),
            ...(card.relevanceScore === undefined ? {} : { relevanceScore: card.relevanceScore }),
            ...(card.relevanceReason === undefined ? {} : { relevanceReason: card.relevanceReason }),
            ...(card.actions.length > existing.actions.length ? { actions: card.actions } : {}),
            lastSeenAt: now,
          };
    const owned = withTriage(attachProfileToCard(merged, profileId), workspace());
    catalog().upsertCase(owned);
    return { card: owned, isNew: existing === undefined };
  }

  function queueFoundInbox(card: SpecialistProcurementCardValue, now: string): void {
    const recorded = catalog().record(inboxItemFromFoundCard(card, now));
    if (recorded.duplicate) catalog().undismiss(recorded.item.change.id);
    workspace().setDismissedInboxIds(catalog().dismissedIds());
  }

  function mergeSearchHits(
    first: readonly SearchHit[],
    extra: readonly SearchHit[],
  ): SearchHit[] {
    const byId = new Map<string, SearchHit>(
      first.map((item) => [item.sourceProcurementId, item] as const),
    );
    for (const hit of extra) {
      const known = byId.get(hit.sourceProcurementId);
      if (known === undefined) {
        byId.set(hit.sourceProcurementId, hit);
        continue;
      }
      const terms = [...(known.matchedSearchTerms ?? [])];
      for (const term of hit.matchedSearchTerms ?? []) {
        if (!terms.includes(term)) terms.push(term);
      }
      if (terms.length > 0) byId.set(hit.sourceProcurementId, { ...known, matchedSearchTerms: terms });
    }
    return [...byId.values()];
  }

  /**
   * Listing for a profile: cheap terms go to the site while the model plans;
   * objects the model added are fetched after, with the same filters.
   * Button search leaves publishedFrom empty; watch passes the watermark.
   */
  async function fetchProfileHits(
    profile: SpecialistWorkingProfile,
    limit: number,
    offset: number,
    publishedFrom?: string,
  ): Promise<{ plan: SearchIntentPlan; hits: SearchHit[]; hasMore: boolean }> {
    const inferred = inferSearchIntentPlan({
      name: profileDisplayName(profile),
      keywords: profile.keywords,
      excludeKeywords: profile.excludeKeywords,
    });
    const listingTerms = platformSearchTerms(inferred, profile.keywords);
    const searchDetailed = async (
      query: Omit<SearchQuery, "sourceId">,
    ): Promise<{ hits: readonly SearchHit[]; hasMore: boolean }> => {
      if (searchHits.searchDetailed !== undefined) {
        const page = await searchHits.searchDetailed(query);
        // undefined means the source did not report truncation — a full
        // window is the honest "more may follow" signal.
        return { hits: page.hits, hasMore: page.hasMore ?? page.hits.length >= query.limit };
      }
      const hits = await searchHits.search(query);
      return { hits, hasMore: hits.length >= query.limit };
    };
    const siteQuery = buildSearchQuery(profile, limit, offset, publishedFrom, listingTerms);
    logger.info("Specialist profile search query", {
      profileName: profileDisplayName(profile),
      keywords: siteQuery.keywords,
      statuses: siteQuery.statuses,
      statusIds: siteQuery.statusIds,
      typeIds: siteQuery.typeIds,
      regionIds: siteQuery.regionIds,
      publishedFrom: siteQuery.publishedFrom ?? "",
    });
    const [plan, firstPage] = await Promise.all([
      resolveSearchPlan(profile),
      searchDetailed(siteQuery),
    ]);
    const extraTerms = extraPlatformSearchTerms(listingTerms, plan, profile.keywords);
    const extraPage =
      extraTerms.length === 0
        ? { hits: [] as readonly SearchHit[], hasMore: false }
        : await searchDetailed(
            buildSearchQuery(profile, limit, offset, publishedFrom, extraTerms),
          );
    const hits = mergeSearchHits(firstPage.hits, extraPage.hits);
    logger.info("Specialist profile search retrieval", {
      profileName: profileDisplayName(profile),
      originalTerms: [...profile.keywords],
      listingTerms,
      derivedTerms: extraTerms,
      firstHits: firstPage.hits.length,
      extraHits: extraPage.hits.length,
      candidates: hits.length,
      perTerm: countHitsPerTerm(hits),
    });
    return { plan, hits, hasMore: firstPage.hasMore || extraPage.hasMore };
  }

  /**
   * One line per candidate so a search can be replayed from the journal:
   * which phrase found it, what the listing score decided and why.
   */
  function logSearchTrace(
    profile: SpecialistWorkingProfile,
    selected: ReturnType<typeof selectRelevantSearchCards>,
  ): void {
    const profileName = profileDisplayName(profile);
    const rows = [
      ...selected.cards.map((card) => ({
        decision: "match" as const,
        sourceProcurementId: card.sourceProcurementId,
        title: card.title,
        score: card.relevanceScore,
        reason: card.relevanceReason,
      })),
      ...selected.ambiguousCards.map((card, index) => ({
        decision: "review" as const,
        sourceProcurementId: card.sourceProcurementId,
        title: card.title,
        score: card.relevanceScore,
        reason: card.relevanceReason,
        matchedSearchTerms: selected.ambiguousHits[index]?.matchedSearchTerms,
      })),
      ...selected.discarded.map((item) => ({
        decision: "discard" as const,
        sourceProcurementId: item.hit.sourceProcurementId,
        title: item.hit.title,
        score: item.score,
        reason: item.reason,
        matchedSearchTerms: item.hit.matchedSearchTerms,
      })),
    ];
    for (const row of rows) {
      if (row.decision === "discard") {
        logger.info("Specialist search skipped", { profileName, ...row });
        continue;
      }
      logger.debug("Specialist search candidate", { profileName, ...row });
    }
  }

  function countHitsPerTerm(hits: readonly SearchHit[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const hit of hits) {
      for (const term of hit.matchedSearchTerms ?? []) {
        counts[term] = (counts[term] ?? 0) + 1;
      }
    }
    return counts;
  }

  /**
   * Scores listing rows after procurement.get (or a title-only stand-in when
   * the review port is off). Matches stay in the session search queue; SQL
   * gets a row only after watch / participate / reject (or a review stub).
   * Listing titles never write a match/discard verdict.
   */
  async function scorePendingHits(
    pending: Array<{ card: SpecialistProcurementCardValue; hit: SearchHit }>,
    profile: SpecialistWorkingProfile,
    now: string,
    plan: SearchIntentPlan,
    scoring: { inboxForMatches: boolean; persistEach: boolean },
  ): Promise<{ matched: SpecialistProcurementCardValue[]; discarded: number; ambiguousCount: number }> {
    let discarded = 0;
    let ambiguousCount = 0;
    let matchCount = 0;
    let scoredCount = 0;
    const matched: SpecialistProcurementCardValue[] = [];
    const dropped: string[] = [];
    const cabinet = currentCabinet();
    const reviewProfile = {
      name: profileDisplayName(profile),
      ...(profile.purpose === undefined ? {} : { purpose: profile.purpose }),
      ...(profile.description === undefined ? {} : { description: profile.description }),
      keywords: profile.keywords,
      excludeKeywords: profile.excludeKeywords,
      intent: plan,
    };
    // One scoring pass is one search run: the model-call budget is shared by
    // every card, so per-hit review calls cannot reset it.
    const reviewBudget: ReviewBudget = { used: 0 };
    for (const item of pending) {
      const outcome =
        searchReview === undefined
          ? scoreIntentCard(procedureCardFromHit(item.hit, now), plan).outcome
          : (await searchReview.review([item.hit], reviewProfile, reviewBudget))[0];
      scoredCount += 1;
      if (outcome?.verdict === "irrelevant") {
        discarded += 1;
        workspace().rememberIrrelevant(profile.id, item.card.sourceProcurementId, now);
        const forgotten = dropFromProfileQueue(item.card.id, profile.id);
        if (forgotten) dropped.push(item.card.id);
        searchProgress.scored(profile.id, {
          scoredCount,
          matchCount,
          discardedCount: discarded,
          reviewCount: ambiguousCount,
        });
        logger.info("Specialist search card scored", {
          profileName: profileDisplayName(profile),
          sourceProcurementId: item.card.sourceProcurementId,
          title: item.card.title.slice(0, 160),
          verdict: "irrelevant",
          scoredCount,
          pendingCount: pending.length,
        });
        searchProgress.skip(profile.id, {
          sourceProcurementId: item.card.sourceProcurementId,
          title: item.card.title.slice(0, 160),
          reason: outcome.reason.length > 0 ? outcome.reason : "карточка не подходит профилю",
          stage: "card",
        });
        if (scoring.persistEach) {
          workspace().setDismissedInboxIds(catalog().dismissedIds());
          if (forgotten) {
            await cabinets.removeCases(cabinet.workspaceId, [item.card.id]);
            if (options.removeCases !== undefined) {
              await options.removeCases([item.card.id], cabinet.workspaceId);
            }
          }
          await persistProgress(forgotten ? [] : [item.card.id], cabinet);
        }
        continue;
      }
      const existing = await findExistingCase(item.card.sourceProcurementId);
      const procedureStatus = outcome?.status ?? item.hit.status ?? item.card.status;
      const requestedClosedStatus =
        isClosedProcedureStatus(procedureStatus) && profile.statuses.includes(procedureStatus);
      if (
        isClosedProcedureStatus(procedureStatus) &&
        !requestedClosedStatus &&
        existing?.triage === undefined
      ) {
        discarded += 1;
        const forgotten = dropFromProfileQueue(item.card.id, profile.id);
        if (forgotten) dropped.push(item.card.id);
        searchProgress.scored(profile.id, {
          scoredCount,
          matchCount,
          discardedCount: discarded,
          reviewCount: ambiguousCount,
        });
        logger.info("Specialist search card scored", {
          profileName: profileDisplayName(profile),
          sourceProcurementId: item.card.sourceProcurementId,
          title: item.card.title.slice(0, 160),
          verdict: "closed",
          scoredCount,
          pendingCount: pending.length,
        });
        searchProgress.skip(profile.id, {
          sourceProcurementId: item.card.sourceProcurementId,
          title: item.card.title.slice(0, 160),
          reason: "завершена или отменена, статус не выбран в профиле",
          stage: "card",
        });
        if (scoring.persistEach) {
          workspace().setDismissedInboxIds(catalog().dismissedIds());
          if (forgotten) {
            await cabinets.removeCases(cabinet.workspaceId, [item.card.id]);
            if (options.removeCases !== undefined) {
              await options.removeCases([item.card.id], cabinet.workspaceId);
            }
          }
          await persistProgress(forgotten ? [] : [item.card.id], cabinet);
        }
        continue;
      }
      const builtCard: SpecialistProcurementCardValue =
        outcome === undefined
          ? { ...item.card, status: procedureStatus, statusLabel: statusLabel(procedureStatus) }
          : {
              ...item.card,
              status: procedureStatus,
              statusLabel: statusLabel(procedureStatus),
              ...(outcome.verdict === "relevant" ? { foundAs: "match" as const } : {}),
              ...(outcome.score === undefined ? {} : { relevanceScore: outcome.score }),
              ...(outcome.reason.length === 0
                ? {}
                : {
                    relevanceReason: outcome.reason.slice(0, 500),
                  }),
              actions: [
                ...item.card.actions,
                {
                  step: item.card.actions.length + 1,
                  actor: "DomainSearchAgent",
                  status: "done",
                  detail: `${reviewActor(outcome.decidedBy)}: ${outcome.reason}`,
                },
              ],
            };
      // The review already paid for procurement.get: keep that card on the
      // case so opening it later does not fetch the platform page again.
      const reviewedCard =
        outcome?.card === undefined
          ? builtCard
          : applyFreshSourceCard(builtCard, outcome.card, now).next;
      const remembered = await rememberFound(reviewedCard, profile.id, now);
      if (outcome?.verdict === "relevant") {
        matchCount += 1;
        matched.push(remembered.card);
        workspace().appendSearchId(profile.id, remembered.card.id);
        catalog().dismissByProcurementId(item.card.id);
        if (scoring.inboxForMatches && remembered.isNew) {
          catalog().record(inboxItemFromFoundCard(remembered.card, now));
        }
      } else {
        ambiguousCount += 1;
        // Manual search resurfaces a still-undecided row (incl. a dismissed
        // one); a discovery pass only announces genuinely new candidates so
        // it cannot nag the specialist about the same card every hour.
        if (remembered.isNew || !scoring.inboxForMatches) queueFoundInbox(remembered.card, now);
      }
      searchProgress.scored(profile.id, {
        scoredCount,
        matchCount,
        discardedCount: discarded,
        reviewCount: ambiguousCount,
      });
      logger.info("Specialist search card scored", {
        profileName: profileDisplayName(profile),
        sourceProcurementId: item.card.sourceProcurementId,
        title: item.card.title.slice(0, 160),
        verdict: outcome?.verdict ?? "unscored",
        scoredCount,
        pendingCount: pending.length,
      });
      if (scoring.persistEach) {
        workspace().setDismissedInboxIds(catalog().dismissedIds());
        await persistProgress([remembered.card.id], cabinet);
      }
    }
    workspace().setDismissedInboxIds(catalog().dismissedIds());
    if (dropped.length > 0 && !scoring.persistEach) {
      await cabinets.removeCases(cabinet.workspaceId, dropped);
      if (options.removeCases !== undefined) {
        await options.removeCases(dropped, cabinet.workspaceId);
      }
    }
    return { matched, discarded, ambiguousCount };
  }

  function startListingReviewJob(
    pending: Array<{ card: SpecialistProcurementCardValue; hit: SearchHit }>,
    profile: SpecialistWorkingProfile,
    now: string,
    plan: SearchIntentPlan,
  ): void {
    if (pending.length === 0) {
      searchProgress.finish(profile.id, "done");
      return;
    }
    const cabinet = currentCabinet();
    void cabinetAls.run(cabinet, async () => {
      try {
        await scorePendingHits(pending, profile, now, plan, {
          inboxForMatches: false,
          persistEach: true,
        });
        await pruneStaleCases();
        await persist(cabinet);
        searchProgress.scored(profile.id, {
          matchCount: searchQueueCards(profile.id).length,
        });
        searchProgress.finish(profile.id, "done");
      } catch (error) {
        searchProgress.finish(profile.id, "failed");
        logger.error("Specialist search review job failed", error, {
          profileName: profileDisplayName(profile),
        });
      }
    });
  }

  function procedureCardFromHit(hit: SearchHit, fetchedAt: string) {
    return ProcedureCard.parse({
      sourceId: hit.sourceId,
      sourceProcurementId: hit.sourceProcurementId,
      url: hit.url,
      title: hit.title,
      fetchedAt,
      lots: [],
      ...(hit.kind === undefined ? {} : { kind: hit.kind }),
      ...(hit.pageFamily === undefined ? {} : { pageFamily: hit.pageFamily }),
      ...(hit.status === undefined ? {} : { status: hit.status }),
      ...(hit.sourceStatus === undefined ? {} : { sourceStatus: hit.sourceStatus }),
    });
  }

  function searchQueueHas(profileId: string, cardId: string): boolean {
    return workspace().searchIds(profileId).includes(cardId);
  }

  function heldOutsideProfile(cardId: string, profileId: string): boolean {
    const card = catalog().procurement(cardId);
    if (card?.triage !== undefined) return true;
    return workspace()
      .profiles()
      .some((item) => item.id !== profileId && searchQueueHas(item.id, cardId));
  }

  /** Drop a discard from this profile only. Other queues and decisions stay. */
  function dropFromProfileQueue(cardId: string, profileId: string): boolean {
    workspace().replaceSearchIds(
      profileId,
      workspace().searchIds(profileId).filter((id) => id !== cardId),
    );
    if (heldOutsideProfile(cardId, profileId)) return false;
    catalog().forgetCase(cardId);
    return true;
  }

  function searchQueueCards(profileId: string): SpecialistProcurementCardValue[] {
    const ids = workspace().searchIds(profileId);
    const byId = new Map<string, SpecialistProcurementCardValue>();
    for (const item of catalog().procurements()) byId.set(item.id, item);
    const seen = new Set<string>();
    return ids
      .map((id) => byId.get(id))
      .filter((card): card is SpecialistProcurementCardValue => card !== undefined)
      .filter(
        (card) =>
          isScoredSearchMatch(card) &&
          !isRejectedTriage(card.triage) &&
          !isWatchedTriage(card),
      )
      .filter((card) => {
        if (seen.has(card.sourceProcurementId)) return false;
        seen.add(card.sourceProcurementId);
        return true;
      });
  }

  /**
   * Listing rows that still need a card score. A stored review case means
   * "could not decide", not a verdict: it goes back to pending so the card
   * (and the model, when it is back) gets another look under the current
   * profile — in the cabinet inbox it just waits for a human either way.
   */
  async function collectPendingHits(
    selected: ReturnType<typeof selectRelevantSearchCards>,
    profile: SpecialistWorkingProfile,
    options: { skipKnownIrrelevant: boolean },
  ): Promise<{
    pending: Array<{ card: SpecialistProcurementCardValue; hit: SearchHit }>;
    skippedRejected: number;
    discardedFromReview: number;
  }> {
    const rejected = workspace().rejectedSourceIds();
    const sourceIds = selected.ambiguousCards.map((item) => item.sourceProcurementId);
    const stored = await cabinets.loadCasesBySources(currentCabinet().workspaceId, sourceIds);
    const known = new Map(
      catalog().procurements().map((item) => [item.sourceProcurementId, item] as const),
    );
    for (const [sourceId, card] of stored) {
      if (!known.has(sourceId)) known.set(sourceId, card);
    }
    let skippedRejected = 0;
    let discardedFromReview = 0;
    const pending: Array<{ card: SpecialistProcurementCardValue; hit: SearchHit }> = [];
    for (const [index, card] of selected.ambiguousCards.entries()) {
      const hit = selected.ambiguousHits[index];
      if (hit === undefined) continue;
      if (rejected.has(card.sourceProcurementId)) {
        skippedRejected += 1;
        continue;
      }
      if (
        options.skipKnownIrrelevant &&
        workspace().isReviewedIrrelevant(profile.id, card.sourceProcurementId)
      ) {
        discardedFromReview += 1;
        continue;
      }
      const already = known.get(card.sourceProcurementId);
      if (already?.foundAs === "match" && options.skipKnownIrrelevant) {
        if (searchQueueHas(profile.id, already.id) || already.profileIds.includes(profile.id)) {
          continue;
        }
      }
      pending.push({ card, hit });
    }
    return { pending, skippedRejected, discardedFromReview };
  }

  /**
   * Applies a fresh platform card and reports what moved — no matter who
   * read it: the watch pass, an explicit refresh or a card open. A silent
   * apply would replace the watch baseline and the next monitoring pass
   * would see nothing, so the diff and the inbox events belong to the
   * apply itself (R22). Events only fire for cases the specialist follows.
   */
  function applyFreshSourceCard(
    card: SpecialistProcurementCardValue,
    fresh: ProcedureCard,
    now: string,
    options?: { suppressTransitions?: ReadonlySet<string> },
  ): { next: SpecialistProcurementCardValue; changes: WatchChange[] } {
    const previous = card.watchSnapshot;
    let next = withTriage(applySourceCard(card, fresh, now), workspace());
    const snapshot = next.watchSnapshot;
    if (snapshot === undefined || !isWatchedTriage(next)) {
      return { next, changes: [] };
    }
    const nowDate = new Date(now);
    const changes = previous === undefined ? [] : diffCardSnapshots(previous, snapshot);
    const deadlineChanged = changes.some((item) => item.kind === "deadline_changed");
    const notifiedChanges = new Set(
      catalog().inboxItems().map((item) => item.change.id),
    );
    const unreported = (change: WatchChange): boolean =>
      !notifiedChanges.has(inboxItemFromWatchChange(next, change, now).change.id);
    // Time passing is a change too: the platform can keep «приём заявок» on
    // the page for weeks after acceptance closed, so field diffs alone never
    // announce that the window is gone. Reported by state, not only at the
    // crossing: a deadline that expired before this code ran is still worth
    // one row — the stable change id keeps it a one-time event.
    if (!deadlineChanged && bidsDeadlinePassed(next, nowDate)) {
      const change: WatchChange = {
        kind: "deadline_changed",
        field: "bidsDeadline",
        previous: snapshot.bidsDeadline ?? previous?.bidsDeadline ?? null,
        current: "срок подачи истёк",
      };
      if (unreported(change)) changes.push(change);
    }
    // A day-ahead warning only for cases the specialist entered: an
    // expiring deadline on a monitor-only card would be noise.
    if (
      !deadlineChanged &&
      next.triage === "participate" &&
      deadlineWithin(next, nowDate, DEADLINE_SOON_MS)
    ) {
      const change: WatchChange = {
        kind: "deadline_changed",
        field: "bidsDeadline",
        previous: snapshot.bidsDeadline ?? previous?.bidsDeadline ?? null,
        current: "срок подачи истекает завтра",
      };
      if (unreported(change)) changes.push(change);
    }
    for (const change of changes) {
      const built = inboxItemFromWatchChange(next, change, now);
      // A transition the specialist just resolved is consumed, not
      // re-reported; its values still reach the card (R25).
      const item = options?.suppressTransitions?.has(watchTransitionKey(built.change))
        ? built
        : catalog().record(built).item;
      next = withTriage(applyInboxChangeToCard(next, item.change), workspace());
      next = applySourceCard(next, fresh, now);
    }
    if (
      next.triage === "participate" &&
      changes.some((item) => item.kind === "document_added")
    ) {
      startParticipateIngest(next);
    }
    return { next, changes };
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
    const watchReader = options.monitorWatch ?? cardWatch;
    if (watchReader === undefined || watchLimit <= 0) {
      return { monitoredCount: 0, changedCount: 0 };
    }
    const followed = (await cabinets.listWatchedCases(currentCabinet().workspaceId, watchLimit)).map(
      (item) => withTriage(item, workspace()),
    );
    let monitoredCount = 0;
    let changedCount = 0;
    for (const card of followed) {
      await discoveryController.beforeRequest(new Date());
      const fresh = await watchReader.read(card.sourceProcurementId);
      if (fresh === undefined) continue;
      monitoredCount += 1;
      let applied: { next: SpecialistProcurementCardValue; changes: WatchChange[] };
      try {
        applied = applyFreshSourceCard(card, fresh, now);
      } catch (error) {
        logger.error("Specialist watched case could not store the source card", error, {
          sourceProcurementId: card.sourceProcurementId,
        });
        continue;
      }
      catalog().upsertCase(applied.next);
      if (applied.changes.length === 0) continue;
      changedCount += 1;
      logger.info("Specialist watched case changed", {
        sourceProcurementId: card.sourceProcurementId,
        kinds: applied.changes.map((item) => item.kind),
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

  /**
   * Button search: listing is retrieval. Matches are written after each
   * procurement.get + intent score. Without a review port (fixture tests)
   * the title stands in for the card so the HTTP call still returns a list.
   */
  async function runManualSearch(
    profile: SpecialistWorkingProfileValue,
    limit: number,
    offset: number,
  ): Promise<ReturnType<typeof SpecialistSearchResponse.parse>> {
    const { plan, hits, hasMore } = await fetchProfileHits(profile, limit, offset);
    const selected = selectRelevantSearchCards(
      hits,
      {
        keywords: profile.keywords,
        excludeKeywords: profile.excludeKeywords,
        statuses: profile.statuses,
        excludeSingleSource: profile.excludeSingleSource,
        intent: plan,
      },
      limit,
    );
    logSearchTrace(profile, selected);
    const now = clock();
    // A new button search replaces this profile's unread queue only.
    // Other profiles keep their cards.
    if (offset === 0) {
      workspace().replaceSearchIds(profile.id, []);
    }
    const collected = await collectPendingHits(selected, profile, {
      skipKnownIrrelevant: false,
    });
    const listingDiscarded =
      selected.discardedCount + collected.skippedRejected + collected.discardedFromReview;
    const background = searchReview !== undefined;
    searchProgress.begin({
      profileId: profile.id,
      profileName: profileDisplayName(profile),
      status: collected.pending.length === 0 ? "done" : background ? "retrieving" : "scoring",
      retrievedCount: collected.pending.length,
      scoredCount: 0,
      matchCount: 0,
      discardedCount: 0,
      reviewCount: 0,
      listingDiscardedCount: listingDiscarded,
      skipped: selected.discarded.map((item) => ({
        sourceProcurementId: item.hit.sourceProcurementId,
        title: item.hit.title.slice(0, 160),
        reason: item.reason,
        stage: "listing" as const,
      })),
    });
    let discardedCount = listingDiscarded;
    let ambiguousCount = 0;
    if (!background) {
      const scored = await scorePendingHits(collected.pending, profile, now, plan, {
        inboxForMatches: false,
        persistEach: false,
      });
      discardedCount += scored.discarded;
      ambiguousCount += scored.ambiguousCount;
      searchProgress.scored(profile.id, {
        matchCount: searchQueueCards(profile.id).length,
        discardedCount: scored.discarded,
        reviewCount: scored.ambiguousCount,
      });
      searchProgress.finish(profile.id, "done");
      await pruneStaleCases();
      await persist();
    } else {
      ambiguousCount += collected.pending.length;
      await persist();
      startListingReviewJob(collected.pending, profile, now, plan);
    }
    const items = searchQueueCards(profile.id);
    logger.info("Specialist profile search recorded", {
      profileName: profile.name,
      relevantCount: items.length,
      discardedCount,
      ambiguousCount,
    });
    const run = searchProgress.snapshot(profile.id);
    return SpecialistSearchResponse.parse({
      profileName: profileDisplayName(profile),
      relevantCount: items.length,
      discardedCount,
      ambiguousCount,
      hasMore: hasMore || hits.length >= limit,
      items,
      ...(run === undefined ? {} : { run }),
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
        let plan: SearchIntentPlan;
        const startedAt = clock();
        try {
          await discoveryController.beforeRequest(new Date());
          const fetched = await fetchProfileHits(
            profile,
            limit,
            0,
            discoveryPublishedFrom(profile),
          );
          plan = fetched.plan;
          hits = fetched.hits;
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
            intent: plan,
            skipReviewSourceIds: workspace().reviewedIrrelevantSourceIds(profile.id),
          },
          limit,
        );
        logSearchTrace(profile, selected);
        const now = clock();
        const collected = await collectPendingHits(selected, profile, {
          skipKnownIrrelevant: true,
        });
        const reviewed = await scorePendingHits(collected.pending, profile, now, plan, {
          inboxForMatches: true,
          persistEach: false,
        });
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

  app.get("/api/health", async () => ({
    ok: true as const,
    postgres: options.postgres === true,
  }));

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

  app.get("/api/admin/cabinets", async (_request, reply) => {
    if (options.authDirectory === undefined) {
      return reply.code(503).send({ error: "auth_unavailable" });
    }
    const users = await options.authDirectory.listUsers();
    const seen = await options.authDirectory.listLatestSeen();
    const workspaceByUser = new Map<string, string>();
    const workspaceIds: string[] = [];
    for (const user of users) {
      const workspaceId = await cabinets.findWorkspaceId(user.id);
      if (workspaceId === undefined) continue;
      workspaceByUser.set(user.id, workspaceId);
      workspaceIds.push(workspaceId);
    }
    const counts = await cabinets.summarizeCabinets(workspaceIds);
    return AdminCabinetListResponse.parse({
      items: users.map((user) => {
        const workspaceId = workspaceByUser.get(user.id);
        const summary =
          workspaceId === undefined ? EMPTY_CABINET_COUNTS : (counts.get(workspaceId) ?? EMPTY_CABINET_COUNTS);
        const lastActiveAt = seen.get(user.id);
        return {
          userId: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          accessStatus: user.accessStatus,
          ...(workspaceId === undefined ? {} : { workspaceId }),
          profileCount: summary.profileCount,
          mineCount: summary.mineCount,
          archiveCount: summary.archiveCount,
          trashCount: summary.trashCount,
          ...(lastActiveAt === undefined ? {} : { lastActiveAt }),
        };
      }),
    });
  });

  app.get("/api/admin/users/:id/procurements", async (request, reply) => {
    if (options.authDirectory === undefined) {
      return reply.code(503).send({ error: "auth_unavailable" });
    }
    const params = request.params as { id: string };
    const users = await options.authDirectory.listUsers();
    const target = users.find((user) => user.id === params.id);
    if (target === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    const workspaceId = await cabinets.findWorkspaceId(target.id);
    if (workspaceId === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    const rawQuery = (request.query ?? {}) as Record<string, unknown>;
    const parsed = SpecialistProcurementListQuery.safeParse({
      ...rawQuery,
      tab: rawQuery.tab ?? "all",
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const tab = parsed.data.tab;
    const offset = parsed.data.offset;
    const page = await cabinets.listCases(workspaceId, {
      tab,
      limit: parsed.data.limit,
      offset,
    });
    const actor = users.find((user) => user.id === request.principal?.userId);
    await recordJournal(journal, {
      kind: "access",
      level: "info",
      message: `Администратор просмотрел кабинет: ${target.name} (${target.email})`,
      ...(actor === undefined ? {} : { actorName: actor.name, actorEmail: actor.email }),
    });
    return SpecialistProcurementListResponse.parse({
      items: page.items,
      total: page.total,
      tab,
      hasMore: offset + page.items.length < page.total,
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
    // Profile rows live in workspace state; rewriting every case card here
    // only queues behind search and makes «Новый профиль» / × feel broken.
    await persistWorkspaceOnly();
    logger.info("Specialist working profile created", { id: created.id });
    return SpecialistWorkingProfile.parse(created);
  });

  app.post("/api/profiles/:id/activate", async (request, reply) => {
    const params = request.params as { id: string };
    if (workspace().findProfile(params.id) === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    workspace().activate(params.id);
    await persistWorkspaceOnly();
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
    await persistWorkspaceOnly();
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
    await cabinets.deleteProfile(currentCabinet(), params.id);
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
    await persistWorkspaceOnly();
    logger.info("Specialist profile watch updated", {
      id: saved.id,
      watchNewProcurements: saved.watchNewProcurements,
    });
    return SpecialistWorkingProfile.parse(saved);
  });

  app.get("/api/profile", async () => SpecialistWorkingProfile.parse(workspace().profile()));

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
    // 201 means durable: the event must reach the store before the response,
    // otherwise a restart silently loses an acknowledged change (R18).
    await persist();
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
    // Resolving a row is navigation, not a decision: the verdict, triage
    // and profile links stay untouched. The card joins the search queue
    // of the profile(s) that found it — never whichever profile happens
    // to be active — so it stays reachable for the explicit triage
    // buttons without silently becoming "relevant".
    if (action !== "dismiss" && card !== undefined) {
      const linked =
        card.profileIds.length > 0
          ? card
          : attachProfileToCard(card, workspace().profile().id);
      card = withTriage(linked, workspace());
      catalog().upsertCase(card);
      for (const profileId of card.profileIds) {
        workspace().appendSearchId(profileId, card.id);
      }
    }
    if (action === "refresh" && card !== undefined) {
      if (cardWatch === undefined) {
        // No live reader is wired (fixture/offline mode): the change the row
        // carries is the freshest data available (R25).
        card = withTriage(applyInboxChangeToCard(card, item.change), workspace());
        catalog().upsertCase(card);
      } else {
        try {
          const fresh = await cardWatch.read(card.sourceProcurementId);
          if (fresh === undefined) {
            throw new Error("source card unavailable");
          }
          // «Обновить» reads the live card, not the historical event the row
          // stored: the platform may have moved further since (R25). The
          // resolved transition is consumed — re-detecting it must not spawn
          // the same row again.
          card = applyFreshSourceCard(card, fresh, clock(), {
            suppressTransitions: new Set([watchTransitionKey(item.change)]),
          }).next;
          catalog().upsertCase(card);
        } catch (error) {
          logger.error("Specialist inbox refresh failed", error, {
            sourceProcurementId: card.sourceProcurementId,
          });
          await recordJournal(journal, {
            kind: "platform",
            level: "error",
            message: `Не удалось обновить карточку: ${card.sourceProcurementId}`,
            sourceProcurementId: card.sourceProcurementId,
          });
          // The row stays: the specialist sees the failure and can retry
          // instead of losing the notification to a silent dismiss.
          return reply.code(502).send({ error: "refresh_failed" });
        }
      }
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
        // The row stays in the inbox: the specialist sees the failure and
        // can retry instead of losing the notification to a silent
        // dismiss (R25).
        return reply.code(502).send({ error: "ingest_failed" });
      }
    }

    catalog().dismiss(params.id);
    workspace().setDismissedInboxIds(catalog().dismissedIds());
    await persistProgress(card === undefined ? [] : [card.id]);
    logger.info("Specialist inbox resolved", {
      changeId: params.id,
      action,
      topic,
    });
    return SpecialistInboxResolveResponse.parse({
      items: catalog().urgentInbox(),
      documents: action === "documents" ? inboxDocumentLinks(card) : [],
      // The console only navigates by card.id; the detail page refetches the
      // full case itself. Shipping the stored platform card here would double
      // the payload of every inbox resolve.
      ...(card === undefined ? {} : { card: slimListedCard(card) }),
    });
  });

  app.get("/api/procurements", async (request, reply) => {
    const parsed = SpecialistProcurementListQuery.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (parsed.data.tab === "search") {
      // A search queue belongs to the profile that found it. The request
      // must name that profile — the active one is shared mutable state.
      if (parsed.data.profileId === undefined) {
        return reply.code(400).send({ error: "missing_profile" });
      }
      if (workspace().findProfile(parsed.data.profileId) === undefined) {
        return reply.code(404).send({ error: "not_found" });
      }
    }
    return listPage(parsed.data);
  });

  app.post("/api/procurements/search", async (request, reply) => {
    const parsed = SpecialistProfileSearchRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const profile = workspace().findProfile(parsed.data.profileId);
    if (profile === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (profile.keywords.length === 0) {
      return reply.code(400).send({ error: "no_keywords" });
    }
    try {
      return await runManualSearch(profile, parsed.data.limit, parsed.data.offset);
    } catch (error) {
      logger.error("Specialist profile search failed", error);
      await noteSearchFailure(journal, error);
      return mapSearchError(reply, error);
    }
  });

  app.get("/api/procurements/search/progress", async (request, reply) => {
    const parsed = SpecialistSearchProgressQuery.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const profile = workspace().findProfile(parsed.data.profileId);
    if (profile === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    const run = searchProgress.snapshot(profile.id);
    if (run !== undefined) return run;
    return SpecialistSearchRun.parse({
      profileId: profile.id,
      profileName: profileDisplayName(profile),
      status: "done",
      retrievedCount: 0,
      scoredCount: 0,
      matchCount: 0,
      discardedCount: 0,
      reviewCount: 0,
    });
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
    if (
      parsed.data.kind === "monitor" ||
      parsed.data.kind === "participate" ||
      parsed.data.kind === "reject"
    ) {
      workspace().removeSearchId(card.id);
    }
    let next = withTriage(card, workspace());
    // Stale rows for this case are cleared before the fresh read: changes the
    // read detects are reported as new rows and must survive the cleanup.
    catalog().dismissByProcurementId(next.id);
    // Hydrate the platform card before returning; file ingest continues after.
    if (parsed.data.kind === "monitor" || parsed.data.kind === "participate") {
      next = await hydrateSourceCard(next);
      if (next.live !== true) {
        next = SpecialistProcurementCard.parse({ ...next, live: true });
      }
    }
    catalog().upsertCase(next);
    workspace().setDismissedInboxIds(catalog().dismissedIds());
    await persistProgress([next.id]);
    if (parsed.data.kind === "participate") {
      startParticipateIngest(next);
    }
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
    await persistProgress([next.id]);
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
    await persistProgress([next.id]);
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
    await persistWorkspaceOnly();
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
    await persistWorkspaceOnly();
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
    const params = request.params as { id: string };
    const card = await resolveCase(params.id);
    if (card === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    // The review already fetched and stored this platform card: opening must
    // not pay for a second live read. Watch passes own freshness; ?fresh=1 is
    // the explicit "Обновить" read, and a card without a stored page falls
    // back to a live fetch.
    const freshRequested = (request.query as { fresh?: string }).fresh !== undefined;
    if (!freshRequested && card.sourceCard !== undefined) {
      return ProcedureCard.parse(card.sourceCard);
    }
    if (cardWatch === undefined) {
      return reply.code(503).send({ error: "card_read_unavailable" });
    }
    const live = await cardWatch.read(card.sourceProcurementId);
    if (live === undefined) {
      logger.warn("Specialist source card unavailable", {
        sourceProcurementId: card.sourceProcurementId,
      });
      return reply.code(404).send({ error: "card_unavailable" });
    }
    try {
      catalog().upsertCase(applyFreshSourceCard(card, live, clock()).next);
      await persistProgress([card.id]);
    } catch (error) {
      // The page was read fine; only the console copy failed. Still show it.
      logger.error("Specialist source card store failed", error, {
        sourceProcurementId: card.sourceProcurementId,
      });
    }
    return ProcedureCard.parse(live);
  });

  /**
   * Refresh the platform page, then re-read already downloaded files so a
   * new extractor can fill terms without hitting goszakupki.by again.
   */
  app.post("/api/procurements/:id/reindex", async (request, reply) => {
    const params = request.params as { id: string };
    const card = await resolveCase(params.id);
    if (card === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    let next = withTriage(card, workspace());
    next = await hydrateSourceCard(next, true);
    if (next.live !== true) {
      next = SpecialistProcurementCard.parse({ ...next, live: true });
    }
    catalog().upsertCase(next);
    await persistProgress([next.id]);
    if (next.triage === "participate") {
      startReindex(next);
    }
    logger.info("Specialist case refresh recorded", {
      sourceProcurementId: card.sourceProcurementId,
      triage: next.triage,
      documentCount: next.documents.length,
    });
    return SpecialistProcurementListResponse.parse({ items: [next] });
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
