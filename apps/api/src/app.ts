import {
  InboxFixtureItem,
  SpecialistDecisionWrite,
  SpecialistDiscoveryResponse,
  SpecialistInboxListResponse,
  SpecialistProcurementCard,
  SpecialistProcurementListResponse,
  SpecialistProfileWrite,
  SpecialistSearchRequest,
  SpecialistSearchResponse,
  SpecialistWatchWrite,
  SpecialistWorkingProfile,
  type SearchHit,
  type SpecialistCaseDocument,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
  type SpecialistWorkspaceState,
} from "@procurement/contracts";
import {
  partitionHitsByDecision,
  selectRelevantSearchCards,
  shouldRunDiscovery,
  SpecialistCatalog,
  SpecialistWorkspace,
} from "@procurement/domain";
import { McpToolCallError } from "@procurement/mcp-client";
import { silentLogger, type Logger } from "@procurement/observability";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  contentDisposition,
  contentTypeForName,
  defaultBlobDirectory,
  getBlob,
  isSha256Hex,
} from "./blobs.js";
import { loadFixtureSearchHits } from "./load-fixture.js";

export interface SpecialistSearchHitsPort {
  search: (limit: number, keywords: readonly string[]) => Promise<readonly SearchHit[]>;
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
  liveProcurementsOnly?: boolean;
  persistWorkspace?: (state: SpecialistWorkspaceState) => Promise<void>;
  clock?: () => string;
}

export async function buildSpecialistApi(options: BuildApiOptions = {}): Promise<SpecialistApi> {
  const catalog = options.catalog ?? new SpecialistCatalog();
  const workspace = options.workspace ?? new SpecialistWorkspace();
  const logger = options.logger ?? silentLogger;
  const blobDirectory = options.blobDirectory ?? defaultBlobDirectory();
  const searchHits = options.searchHits ?? { search: loadDefaultSearchHits };
  const liveProcurementsOnly = options.liveProcurementsOnly === true;
  const clock = options.clock ?? (() => new Date().toISOString());
  const persist = async (): Promise<void> => {
    if (options.persistWorkspace === undefined) return;
    await options.persistWorkspace(workspace.snapshot());
  };

  const listed = (): SpecialistProcurementCardValue[] => {
    const rejected = workspace.rejectedSourceIds();
    return catalog
      .procurements()
      .filter((item) => !rejected.has(item.sourceProcurementId))
      .filter((item) => !liveProcurementsOnly || item.live)
      .map((item) => withTriage(item, workspace));
  };

  const app = Fastify({ logger: false });

  async function runManualSearch(limit: number): Promise<ReturnType<typeof SpecialistSearchResponse.parse>> {
    const profile = workspace.profile();
    const hits = await searchHits.search(limit, profile.keywords);
    const selected = selectRelevantSearchCards(
      hits,
      {
        keywords: profile.keywords,
        excludeKeywords: profile.excludeKeywords,
      },
      limit,
    );
    let skippedRejected = 0;
    for (const card of selected.cards) {
      if (workspace.rejectedSourceIds().has(card.sourceProcurementId)) {
        skippedRejected += 1;
        continue;
      }
      catalog.upsertCase(withTriage(card, workspace));
    }
    logger.info("Specialist profile search recorded", {
      profileName: profile.name,
      relevantCount: selected.cards.length - skippedRejected,
      discardedCount: selected.discardedCount + skippedRejected,
    });
    return SpecialistSearchResponse.parse({
      profileName: profile.name,
      relevantCount: selected.cards.length - skippedRejected,
      discardedCount: selected.discardedCount + skippedRejected,
      items: listed(),
    });
  }

  async function runDiscovery(limit = 20) {
    const profile = workspace.profile();
    if (!shouldRunDiscovery(profile.watchNewProcurements)) {
      return SpecialistDiscoveryResponse.parse({
        ran: false,
        reason: "watch_off",
        addedCount: 0,
        skippedDecidedCount: 0,
        items: listed(),
      });
    }
    if (profile.keywords.length === 0) {
      return SpecialistDiscoveryResponse.parse({
        ran: false,
        reason: "no_keywords",
        addedCount: 0,
        skippedDecidedCount: 0,
        items: listed(),
      });
    }
    let hits: readonly SearchHit[];
    try {
      hits = await searchHits.search(limit, profile.keywords);
    } catch (error) {
      logger.error("Specialist discovery search failed", error);
      throw error;
    }
    const partitioned = partitionHitsByDecision(hits, workspace.decidedSourceIds());
    const selected = selectRelevantSearchCards(
      partitioned.undecided,
      {
        keywords: profile.keywords,
        excludeKeywords: profile.excludeKeywords,
      },
      limit,
    );
    const known = new Set(catalog.procurements().map((item) => item.sourceProcurementId));
    let addedCount = 0;
    for (const card of selected.cards) {
      if (known.has(card.sourceProcurementId)) continue;
      catalog.upsertCase(withTriage(card, workspace));
      addedCount += 1;
    }
    logger.info("Specialist discovery recorded", {
      profileName: profile.name,
      addedCount,
      skippedDecidedCount: partitioned.skippedDecidedCount,
    });
    return SpecialistDiscoveryResponse.parse({
      ran: true,
      reason: "ok",
      addedCount,
      skippedDecidedCount: partitioned.skippedDecidedCount,
      items: listed(),
    });
  }

  app.get("/api/health", async () => ({ ok: true as const }));

  app.get("/api/profile", async () => SpecialistWorkingProfile.parse(workspace.profile()));

  app.put("/api/profile", async (request, reply) => {
    const parsed = SpecialistProfileWrite.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    workspace.replaceProfile(parsed.data);
    await persist();
    logger.info("Specialist working profile saved", {
      name: parsed.data.name,
      keywordCount: parsed.data.keywords.length,
    });
    return SpecialistWorkingProfile.parse(workspace.profile());
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
      return await runManualSearch(parsed.data.limit);
    } catch (error) {
      logger.error("Specialist profile search failed", error);
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
    const next = withTriage(card, workspace);
    catalog.upsertCase(next);
    await persist();
    logger.info("Specialist triage recorded", {
      sourceProcurementId: card.sourceProcurementId,
      kind: parsed.data.kind,
    });
    return SpecialistProcurementListResponse.parse({ items: listed() });
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
    const bytes = await getBlob(blobDirectory, params.hash);
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

function withTriage(
  card: SpecialistProcurementCardValue,
  workspace: SpecialistWorkspace,
): SpecialistProcurementCardValue {
  const triage = workspace.latestKind(card.sourceProcurementId);
  if (triage === undefined) return SpecialistProcurementCard.parse(card);
  return SpecialistProcurementCard.parse({ ...card, triage });
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

async function loadDefaultSearchHits(
  _limit: number,
  _keywords: readonly string[],
): Promise<readonly SearchHit[]> {
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
