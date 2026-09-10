import {
  InboxFixtureItem,
  type SearchQuery,
  SpecialistDecisionWrite,
  SpecialistDiscoveryResponse,
  SpecialistIngestProgress,
  SpecialistInboxListResponse,
  SpecialistInboxResolveResponse,
  SpecialistInboxResolveWrite,
  SpecialistProcurementCard,
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
  attachProfileToCard,
  discoveryPublishedFrom,
  inboxDocumentLinks,
  inboxItemFromFoundCard,
  inboxTopic,
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
import { discoveryDoneMessage, discoveryFailedMessage } from "./discovery-transport.js";
import type { SpecialistDocumentIngestPort } from "./document-ingest.js";
import { createIngestProgressHub } from "./ingest-progress.js";
import { loadFixtureSearchHits } from "./load-fixture.js";
import type { BlobStore } from "./object-store.js";
import type { SpecialistReviewPort } from "./search-review.js";

export const DEFAULT_CASE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Listing rows one background pass may take per profile. With the discovery
 * watermark the source returns only what was posted since the last pass, so
 * this is a ceiling for the first pass and for busy days, not a per-hour cap.
 */
export const DEFAULT_DISCOVERY_LIMIT = 100;

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
  documentIngest?: SpecialistDocumentIngestPort;
  liveProcurementsOnly?: boolean;
  persistWorkspace?: (state: SpecialistWorkspaceState) => Promise<void>;
  persistCases?: (cards: readonly SpecialistProcurementCardValue[]) => Promise<void>;
  persistInbox?: (items: readonly InboxFixtureItemValue[]) => Promise<void>;
  removeCases?: (ids: readonly string[]) => Promise<void>;
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
}

export async function buildSpecialistApi(options: BuildApiOptions = {}): Promise<SpecialistApi> {
  const catalog = options.catalog ?? new SpecialistCatalog();
  const workspace = options.workspace ?? new SpecialistWorkspace();
  catalog.dismissMany(workspace.dismissedInboxIds());
  const logger = options.logger ?? silentLogger;
  const blobDirectory = options.blobDirectory ?? defaultBlobDirectory();
  const searchHits = options.searchHits ?? { search: loadDefaultSearchHits };
  const searchReview = options.searchReview;
  const documentIngest = options.documentIngest;
  const ingestProgress = options.ingestProgress ?? createIngestProgressHub();
  const liveProcurementsOnly = options.liveProcurementsOnly === true;
  const clock = options.clock ?? (() => new Date().toISOString());
  const journal = options.journal ?? createMemoryAdminJournal();
  const caseMaxAgeMs = options.caseMaxAgeMs ?? DEFAULT_CASE_MAX_AGE_MS;
  const persist = async (): Promise<void> => {
    if (options.persistWorkspace !== undefined) {
      await options.persistWorkspace(workspace.snapshot());
    }
    if (options.persistCases !== undefined) {
      await options.persistCases(catalog.procurements());
    }
    if (options.persistInbox !== undefined) {
      await options.persistInbox(catalog.inboxItems());
    }
  };

  // Cases the specialist never touched do not pile up: once a search stops
  // returning them for caseMaxAgeMs they leave the catalog and the database.
  const pruneStaleCases = async (): Promise<void> => {
    const removed = catalog.prune({
      now: clock(),
      maxAgeMs: caseMaxAgeMs,
      keepSourceIds: workspace.decidedSourceIds(),
    });
    if (removed.length === 0) return;
    workspace.setDismissedInboxIds(catalog.dismissedIds());
    logger.info("Specialist stale cases pruned", { count: removed.length });
    if (options.removeCases !== undefined) await options.removeCases(removed);
  };

  // Review cases wait in the inbox; they enter the list only after a
  // specialist opens or decides them.
  const listed = (): SpecialistProcurementCardValue[] => {
    const rejected = workspace.rejectedSourceIds();
    return catalog
      .procurements()
      .filter((item) => !rejected.has(item.sourceProcurementId))
      .filter((item) => !liveProcurementsOnly || item.live)
      .map((item) => withTriage(item, workspace))
      .filter((item) => item.foundAs !== "review" || item.triage !== undefined);
  };

  const app = Fastify({ logger: false });
  registerAuth(app, {
    ...(options.authDirectory === undefined ? {} : { directory: options.authDirectory }),
    ...(options.authMail === undefined ? {} : { mail: options.authMail }),
    ...(options.authCookieSecure === undefined ? {} : { cookieSecure: options.authCookieSecure }),
    ...(options.authPublicUrl === undefined ? {} : { publicUrl: options.authPublicUrl }),
    ...(options.internalApiToken === undefined ? {} : { internalApiToken: options.internalApiToken }),
    journal,
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
  function rememberFound(
    card: SpecialistProcurementCardValue,
    profileId: string,
    now: string,
  ): { card: SpecialistProcurementCardValue; isNew: boolean } {
    const existing = catalog
      .procurements()
      .find((item) => item.sourceProcurementId === card.sourceProcurementId);
    const foundAs = card.foundAs === "match" || existing?.foundAs === "match" ? "match" : card.foundAs;
    const merged: SpecialistProcurementCardValue =
      existing === undefined
        ? { ...card, lastSeenAt: now }
        : {
            ...existing,
            title: card.title,
            statusLabel: card.statusLabel,
            ...(card.buyerName === undefined ? {} : { buyerName: card.buyerName }),
            ...(card.amountLabel === undefined ? {} : { amountLabel: card.amountLabel }),
            ...(foundAs === undefined ? {} : { foundAs }),
            lastSeenAt: now,
          };
    const owned = withTriage(attachProfileToCard(merged, profileId), workspace);
    catalog.upsertCase(owned);
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
    profile: ReturnType<typeof workspace.profile>,
    now: string,
    options: { inboxForMatches: boolean },
  ): Promise<{ matched: SpecialistProcurementCardValue[]; discarded: number; ambiguousCount: number }> {
    const rejected = workspace.rejectedSourceIds();
    const known = new Map(
      catalog.procurements().map((item) => [item.sourceProcurementId, item] as const),
    );
    let discarded = 0;
    let ambiguousCount = 0;
    const pending: Array<{ card: SpecialistProcurementCardValue; hit: SearchHit }> = [];
    selected.ambiguousCards.forEach((card, index) => {
      const hit = selected.ambiguousHits[index];
      if (hit === undefined || rejected.has(card.sourceProcurementId)) return;
      if (workspace.isReviewedIrrelevant(profile.id, card.sourceProcurementId)) {
        discarded += 1;
        return;
      }
      if (known.get(card.sourceProcurementId)?.foundAs === "review") {
        rememberFound(card, profile.id, now);
        ambiguousCount += 1;
        return;
      }
      pending.push({ card, hit });
    });
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
    pending.forEach(({ card }, index) => {
      const outcome = outcomes?.[index];
      if (outcome?.verdict === "irrelevant") {
        discarded += 1;
        workspace.rememberIrrelevant(profile.id, card.sourceProcurementId, now);
        return;
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
      const remembered = rememberFound(reviewedCard, profile.id, now);
      if (outcome?.verdict === "relevant") {
        matched.push(remembered.card);
        if (options.inboxForMatches && remembered.isNew) {
          catalog.record(inboxItemFromFoundCard(remembered.card, now));
        }
        return;
      }
      ambiguousCount += 1;
      if (remembered.isNew) catalog.record(inboxItemFromFoundCard(remembered.card, now));
    });
    return { matched, discarded, ambiguousCount };
  }

  async function runManualSearch(
    limit: number,
    offset: number,
  ): Promise<ReturnType<typeof SpecialistSearchResponse.parse>> {
    const profile = workspace.profile();
    const hits = await searchHits.search(buildSearchQuery(profile, limit, offset));
    const selected = selectRelevantSearchCards(
      hits,
      {
        keywords: profile.keywords,
        excludeKeywords: profile.excludeKeywords,
        statuses: profile.statuses,
      },
      limit,
    );
    const now = clock();
    let skippedRejected = 0;
    const resultItems: SpecialistProcurementCardValue[] = [];
    for (const card of selected.cards) {
      if (workspace.rejectedSourceIds().has(card.sourceProcurementId)) {
        skippedRejected += 1;
        continue;
      }
      resultItems.push(rememberFound(card, profile.id, now).card);
    }
    const reviewed = await reviewAmbiguous(selected, profile, now, { inboxForMatches: false });
    resultItems.push(...reviewed.matched);
    const relevantCount = resultItems.length;
    const discardedCount = selected.discardedCount + skippedRejected + reviewed.discarded;
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

  async function runDiscovery(limit = DEFAULT_DISCOVERY_LIMIT) {
    const watched = workspace.profiles().filter((item) =>
      shouldRunDiscovery(item.watchNewProcurements),
    );
    if (watched.length === 0) {
      return SpecialistDiscoveryResponse.parse({
        ran: false,
        reason: "watch_off",
        addedCount: 0,
        skippedDecidedCount: 0,
        items: listed(),
      });
    }
    const ready = watched.filter((item) => item.keywords.length > 0);
    if (ready.length === 0) {
      return SpecialistDiscoveryResponse.parse({
        ran: false,
        reason: "no_keywords",
        addedCount: 0,
        skippedDecidedCount: 0,
        items: listed(),
      });
    }
    let addedCount = 0;
    let skippedDecidedCount = 0;
    const known = new Set(catalog.procurements().map((item) => item.sourceProcurementId));
    const failed: Array<{ profile: SpecialistWorkingProfile; error: unknown }> = [];
    const succeeded: SpecialistWorkingProfile[] = [];
    for (const profile of ready) {
      // One profile's failure must not cost the others their pass, nor lose
      // what earlier profiles already found: the loop goes on and persists.
      let hits: readonly SearchHit[];
      const startedAt = clock();
      try {
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
      const partitioned = partitionHitsByDecision(hits, workspace.decidedSourceIds());
      skippedDecidedCount += partitioned.skippedDecidedCount;
      const selected = selectRelevantSearchCards(
        partitioned.undecided,
        {
          keywords: profile.keywords,
          excludeKeywords: profile.excludeKeywords,
          statuses: profile.statuses,
        },
        limit,
      );
      const now = clock();
      for (const card of selected.cards) {
        const remembered = rememberFound(card, profile.id, now);
        if (!remembered.isNew) continue;
        catalog.record(inboxItemFromFoundCard(remembered.card, now));
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
      workspace.markDiscovered(profile.id, startedAt);
      logger.info("Specialist discovery recorded", {
        profileName: profileDisplayName(profile),
        addedCount,
        skippedDecidedCount,
      });
    }
    workspace.forgetStaleVerdicts(clock());
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
      }),
    });
    return SpecialistDiscoveryResponse.parse({
      ran: true,
      reason: "ok",
      addedCount,
      skippedDecidedCount,
      items: listed(),
    });
  }

  app.get("/api/health", async () => ({ ok: true as const }));

  function profileList() {
    return SpecialistProfileListResponse.parse({
      items: workspace.profiles(),
      activeProfileId: workspace.profile().id,
    });
  }

  app.get("/api/profiles", async () => profileList());

  app.post("/api/profiles", async () => {
    const created = workspace.addProfile();
    await persist();
    logger.info("Specialist working profile created", { id: created.id });
    return SpecialistWorkingProfile.parse(created);
  });

  app.post("/api/profiles/:id/activate", async (request, reply) => {
    const params = request.params as { id: string };
    if (workspace.findProfile(params.id) === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    workspace.activate(params.id);
    await persist();
    return SpecialistWorkingProfile.parse(workspace.profile());
  });

  app.put("/api/profiles/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const parsed = SpecialistProfileWrite.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (workspace.findProfile(params.id) === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    const saved = workspace.replaceProfileById(params.id, parsed.data);
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
    if (workspace.findProfile(params.id) === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (workspace.profiles().length === 1) {
      return reply.code(409).send({ error: "last_profile" });
    }
    workspace.removeProfile(params.id);
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
    if (workspace.findProfile(params.id) === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    const saved = workspace.setWatchById(params.id, parsed.data.watchNewProcurements);
    await persist();
    logger.info("Specialist profile watch updated", {
      id: saved.id,
      watchNewProcurements: saved.watchNewProcurements,
    });
    return SpecialistWorkingProfile.parse(saved);
  });

  app.get("/api/profile", async () => SpecialistWorkingProfile.parse(workspace.profile()));

  app.put("/api/profile", async (request, reply) => {
    const parsed = SpecialistProfileWrite.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    workspace.replaceProfile(parsed.data);
    await persist();
    const saved = workspace.profile();
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
    workspace.setWatch(parsed.data.watchNewProcurements);
    await persist();
    logger.info("Specialist profile watch updated", {
      watchNewProcurements: parsed.data.watchNewProcurements,
    });
    return SpecialistWorkingProfile.parse(workspace.profile());
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
    SpecialistInboxListResponse.parse({ items: catalog.urgentInbox() }),
  );

  app.post("/api/inbox/events", async (request, reply) => {
    const parsed = InboxFixtureItem.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const recorded = catalog.record(parsed.data);
    logger.info("Specialist inbox event recorded", {
      duplicate: recorded.duplicate,
      changeId: recorded.item.change.id,
    });
    return reply.code(recorded.duplicate ? 200 : 201).send(
      SpecialistInboxListResponse.parse({ items: catalog.urgentInbox() }),
    );
  });

  app.delete("/api/inbox/:id", async (request, reply) => {
    const params = request.params as { id: string };
    if (!catalog.dismiss(params.id)) {
      return reply.code(404).send({ error: "not_found" });
    }
    workspace.setDismissedInboxIds(catalog.dismissedIds());
    await persist();
    return SpecialistInboxListResponse.parse({ items: catalog.urgentInbox() });
  });

  app.post("/api/inbox/:id/resolve", async (request, reply) => {
    const params = request.params as { id: string };
    const parsed = SpecialistInboxResolveWrite.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const item = catalog.inboxItem(params.id);
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

    let card = catalog.procurement(item.change.procurementId);
    // Opening a review case from the inbox is the specialist taking it on:
    // from now on it belongs in the list like any confident match.
    if (action !== "dismiss" && card !== undefined && card.foundAs === "review") {
      card = withTriage({ ...card, foundAs: "match" }, workspace);
      catalog.upsertCase(card);
    }
    if (action === "refresh" && card !== undefined) {
      card = withTriage(applyInboxChangeToCard(card, item.change), workspace);
      catalog.upsertCase(card);
    }
    if (action === "documents" && card !== undefined && documentIngest !== undefined) {
      ingestProgress.begin(card.id);
      try {
        card = withTriage(await documentIngest.ingest(card), workspace);
        ingestProgress.done(card.id);
        catalog.upsertCase(card);
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

    catalog.dismiss(params.id);
    workspace.setDismissedInboxIds(catalog.dismissedIds());
    await persist();
    logger.info("Specialist inbox resolved", {
      changeId: params.id,
      action,
      topic,
    });
    return SpecialistInboxResolveResponse.parse({
      items: catalog.urgentInbox(),
      documents: action === "documents" ? inboxDocumentLinks(card) : [],
      ...(card === undefined ? {} : { card }),
    });
  });

  app.get("/api/procurements", async () =>
    SpecialistProcurementListResponse.parse({ items: listed() }),
  );

  app.post("/api/procurements/search", async (request, reply) => {
    const parsed = SpecialistSearchRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (workspace.profile().keywords.length === 0) {
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
    const card = listed().find((item) => item.id === params.id);
    if (card === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    workspace.recordDecision(card.sourceProcurementId, parsed.data.kind, clock());
    let next = withTriage(card, workspace);
    if (parsed.data.kind === "participate" && documentIngest !== undefined) {
      ingestProgress.begin(card.id);
      try {
        next = withTriage(await documentIngest.ingest(next), workspace);
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
    catalog.upsertCase(next);
    catalog.dismissByProcurementId(next.id);
    workspace.setDismissedInboxIds(catalog.dismissedIds());
    await persist();
    logger.info("Specialist triage recorded", {
      sourceProcurementId: card.sourceProcurementId,
      kind: parsed.data.kind,
      documentCount: next.documents.length,
    });
    return SpecialistProcurementListResponse.parse({ items: listed() });
  });

  app.get("/api/procurements/:id/ingest-progress", async (request, reply) => {
    const params = request.params as { id: string };
    const card = listed().find((item) => item.id === params.id);
    if (card === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    return SpecialistIngestProgress.parse(ingestProgress.snapshot(card.id));
  });

  app.get("/api/procurements/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const card = listed().find((item) => item.id === params.id);
    if (card === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    return card;
  });

  app.get("/api/documents/:hash", async (request, reply) => {
    const params = request.params as { hash: string };
    if (!isSha256Hex(params.hash)) {
      return reply.code(400).send({ error: "invalid_hash" });
    }
    const document = findCatalogDocument(catalog, params.hash);
    if (document === undefined) {
      return reply.code(404).send({ error: "not_found" });
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
  if (triage === undefined) return SpecialistProcurementCard.parse(card);
  return SpecialistProcurementCard.parse({ ...card, triage });
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
