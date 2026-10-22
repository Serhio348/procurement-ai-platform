import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SourceId } from "@procurement/contracts";
import {
  createSourceRoutingCaller,
  type McpToolCaller,
} from "@procurement/mcp-client";
import { createLogger, type Logger } from "@procurement/observability";
import { buildSpecialistApi, type SpecialistApi } from "./app.js";
import { createSmtpMailPort } from "./auth/mail.js";
import { resolveBlobDirectory } from "./blobs.js";
import { removeDiscoveryRepeat, startDiscoveryRepeat } from "./discovery-queue.js";
import { discoveryTransport } from "./discovery-transport.js";
import { createProcurementDocumentIngest } from "./document-ingest.js";
import { createCommercialReaderFromEnv } from "./commercial-reader.js";
import { createIngestProgressHub } from "./ingest-progress.js";
import { loadDotEnv } from "./load-env.js";
import { createBlobStoreFromEnv, objectStoreKind } from "./object-store.js";
import { recordJournal } from "./admin/journal.js";
import { openSpecialistPersistence } from "./persist.js";
import { connectProcurementMcp, type ProcurementMcpProcess } from "./procurement-mcp.js";
import { createProcurementSearchHits } from "./procurement-search.js";
import {
  createSourceHealthMonitor,
  type SourceHealthMonitor,
} from "./source-health.js";
import { createProfileSuggestFromEnv } from "./profile-suggest.js";
import { createAssistantDirectionFromEnv } from "./assistant-directions.js";
import { createSearchClassifierFromEnv } from "./search-classifier.js";
import { createSearchIntentFromEnv } from "./search-intent.js";
import { createProcurementSearchReview } from "./search-review.js";
import { createDiscoveryController } from "./discovery-control.js";
import { createProcurementCardWatch } from "./card-watch.js";
import {
  createTelegramBotFromEnv,
  createTelegramNotifier,
  type TelegramNotifier,
} from "./telegram.js";
import {
  createPostgresAssistantSuggestionStore,
  createPostgresDecisionMemoryStore,
  createPostgresTelegramStore,
} from "@procurement/db";
import { assistantPilotFromEnv } from "./decision-memory.js";

// /api/health reports the deployed revision so an operator can verify which
// build actually answers instead of inferring it from old inbox rows (R42).
function resolveBuildSha(repoRoot: string): string | undefined {
  const fromEnv = process.env["APP_BUILD_SHA"]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

interface SourceLane {
  caller: McpToolCaller;
  /** Per-source callers — used to probe each child's registry for health. */
  callersBySource: ReadonlyMap<string, McpToolCaller>;
  close: () => Promise<void>;
}

/**
 * One stdio child per source on this lane: searches, card reads and
 * downloads for different platforms get their own pipe, queue and timeout
 * budget — a slow lane can no longer starve siblings (a BUTB registry scan
 * used to hold the shared pipe long enough to time out every queued call).
 * The first configured source is required for boot; extra sources degrade
 * to `source_unavailable` instead of taking the API down.
 * `health` receives lifecycle facts (started / spawn-failed / transport
 * closed) so /api/health reports observed state, not configured intent.
 */
async function connectSourceLane(options: {
  lane: string;
  sourceIds: readonly SourceId[];
  logger: Logger;
  blobDirectory: string;
  health?: SourceHealthMonitor | undefined;
  envOverrides?: Record<string, string>;
}): Promise<SourceLane | undefined> {
  const callersBySource = new Map<string, McpToolCaller>();
  const missing = new Set<string>();
  const children: ProcurementMcpProcess[] = [];
  for (const sourceId of options.sourceIds) {
    try {
      const child = await connectProcurementMcp({
        mode: "live",
        logger: options.logger,
        blobDirectory: options.blobDirectory,
        lane: `${options.lane}:${String(sourceId)}`,
        onlySources: [String(sourceId)],
        onProcessClosed: () =>
          options.health?.noteClosed(options.lane, String(sourceId)),
        ...(options.envOverrides === undefined ? {} : { envOverrides: options.envOverrides }),
      });
      callersBySource.set(String(sourceId), child.caller);
      children.push(child);
      options.health?.noteStarted(options.lane, String(sourceId), child.caller);
    } catch (error) {
      options.health?.noteFailed(options.lane, String(sourceId), error);
      if (children.length === 0) throw error;
      missing.add(String(sourceId));
      options.logger.error(
        "Source child failed to start — its calls report source_unavailable",
        error,
        { sourceId },
      );
    }
  }
  const fallback = callersBySource.values().next().value;
  if (fallback === undefined) return undefined;
  return {
    caller: createSourceRoutingCaller({ callers: callersBySource, missing, fallback }),
    callersBySource,
    close: async () => {
      await Promise.all(children.map((child) => child.close().catch(() => undefined)));
    },
  };
}

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  await loadDotEnv(path.join(repoRoot, ".env"));
  const logger = createLogger({
    level: process.env["LOG_LEVEL"] === "debug" ? "debug" : "info",
    sink: (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
  });
  const mode = process.env["PROCUREMENT_SOURCE_MODE"] === "live" ? "live" : "fixture";
  const blobDirectory = resolveBlobDirectory(process.env["DOCUMENT_BLOB_DIR"]);
  const blobStore = createBlobStoreFromEnv(process.env, blobDirectory);
  const ingestProgress = createIngestProgressHub();
  const persistence = await openSpecialistPersistence({
    workspacePath: path.join(repoRoot, "data", "specialist-workspace.json"),
    databaseUrl: process.env["DATABASE_URL"],
    logger,
  });
  // BUTB: registered in MCP only under BUTB_ENABLED, and its hits reach a
  // cabinet only while BUTB_WORKSPACE_IDS pilots it — two separate gates so
  // the adapter can deploy dark and still never disturb other specialists.
  const enabledSourceIds: SourceId[] = [
    SourceId.parse("goszakupki_by"),
    ...(process.env["BUTB_ENABLED"] === "1" ? [SourceId.parse("butb")] : []),
  ];
  // Lifecycle + cached registry probes per lane×source — /api/health reads
  // this snapshot and never enters a child pipe itself.
  const sourceHealth =
    mode === "live" ? createSourceHealthMonitor({ logger }) : undefined;
  const mcp =
    mode === "live"
      ? await connectSourceLane({
          lane: "background",
          sourceIds: enabledSourceIds,
          logger,
          blobDirectory,
          health: sourceHealth,
        })
      : undefined;
  // Interactive reads (card open, decision hydrate) get their own lane:
  // one stdio pipe per source is strictly serial, so a card click would
  // otherwise queue behind every background search/discovery/ingest call.
  // The BUTB child on this lane gets a shorter search budget: card clicks
  // share its pipe, so an interactive native search must return a bounded
  // page instead of holding the lane for the background-sized window.
  const interactiveButbSearchMs =
    Number(process.env["BUTB_BY_INTERACTIVE_MAX_SEARCH_MS"]) > 0
      ? String(process.env["BUTB_BY_INTERACTIVE_MAX_SEARCH_MS"])
      : "120000";
  const mcpInteractive =
    mode === "live"
      ? await connectSourceLane({
          lane: "interactive",
          sourceIds: enabledSourceIds,
          logger,
          blobDirectory,
          health: sourceHealth,
          envOverrides: { BUTB_BY_MAX_SEARCH_MS: interactiveButbSearchMs },
        })
      : undefined;
  sourceHealth?.start();
  const butbPilot = assistantPilotFromEnv(process.env["BUTB_WORKSPACE_IDS"]);
  const sourcesForWorkspace = (workspaceId: string | undefined): readonly SourceId[] =>
    enabledSourceIds.filter((id) => id !== "butb" || butbPilot(workspaceId ?? ""));
  const searchTimeoutRaw = Number(process.env["PROCUREMENT_SEARCH_TIMEOUT_MS"]);
  const searchTimeout =
    Number.isFinite(searchTimeoutRaw) && searchTimeoutRaw > 0
      ? { timeoutMs: searchTimeoutRaw }
      : {};
  // One retrieval operation (plan + first pass + extra-terms + continuation
  // pages) shares this deadline — aligned with the per-call search timeout.
  const searchBudgetMs =
    Number.isFinite(searchTimeoutRaw) && searchTimeoutRaw > 0 ? searchTimeoutRaw : 300_000;
  const cardTimeoutRaw = Number(process.env["PROCUREMENT_CARD_TIMEOUT_MS"]);
  const cardTimeout =
    Number.isFinite(cardTimeoutRaw) && cardTimeoutRaw > 0
      ? { timeoutMs: cardTimeoutRaw }
      : {};
  const ingestTimeoutRaw = Number(process.env["PROCUREMENT_INGEST_TIMEOUT_MS"]);
  const ingestTimeout =
    Number.isFinite(ingestTimeoutRaw) && ingestTimeoutRaw > 0
      ? { timeoutMs: ingestTimeoutRaw }
      : {};
  // searchHits is created before the app, so the workspace lookup is indirect.
  const appRef: { current?: SpecialistApi } = {};
  const activeWorkspaceId = () => appRef.current?.currentWorkspaceId();
  const searchHits =
    mcp === undefined
      ? undefined
      : createProcurementSearchHits({
          caller: mcp.caller,
          sourceIds: enabledSourceIds,
          sourcesForWorkspace,
          activeWorkspaceId,
          logger,
          ...searchTimeout,
        });
  const cardWatch =
    mcpInteractive === undefined
      ? undefined
      : createProcurementCardWatch({
          caller: mcpInteractive.caller,
          sourceId: SourceId.parse("goszakupki_by"),
          logger,
          ...cardTimeout,
        });
  const monitorWatch =
    mcp === undefined
      ? undefined
      : createProcurementCardWatch({
          caller: mcp.caller,
          sourceId: SourceId.parse("goszakupki_by"),
          logger,
          ...cardTimeout,
        });
  const classifier = createSearchClassifierFromEnv(process.env);
  const searchIntent = createSearchIntentFromEnv(process.env);
  const searchReview =
    mcp === undefined
      ? undefined
      : createProcurementSearchReview({
          caller: mcp.caller,
          ...(classifier === undefined ? {} : { classifier }),
          logger,
          ...cardTimeout,
        });
  const commercialReader = createCommercialReaderFromEnv(process.env);
  const profileSuggest = createProfileSuggestFromEnv(process.env);
  const assistantDirections = createAssistantDirectionFromEnv(process.env);
  // The listing probe answers on the interactive lane — a specialist waiting
  // on «Заполнить профиль» must not queue behind background search/ingest.
  const suggestSearch =
    mcpInteractive === undefined
      ? undefined
      : createProcurementSearchHits({
          caller: mcpInteractive.caller,
          sourceIds: enabledSourceIds,
          sourcesForWorkspace,
          activeWorkspaceId,
          logger,
          ...searchTimeout,
        });
  logger.info("Search intent configured", { model: searchIntent !== undefined });
  if (mcp !== undefined) {
    logger.info("Search review configured", { model: classifier !== undefined });
    logger.info("Commercial reader configured", { model: commercialReader !== undefined });
  }
  const bootstrapEmail = process.env["AUTH_BOOTSTRAP_EMAIL"]?.trim() ?? "";
  const bootstrapPassword = process.env["AUTH_BOOTSTRAP_PASSWORD"] ?? "";
  if (bootstrapEmail.length > 0 && bootstrapPassword.length >= 8) {
    const admin = await persistence.authDirectory.bootstrapAdmin(
      bootstrapEmail,
      bootstrapPassword,
      "Администратор",
    );
    if (admin !== undefined) {
      await persistence.cabinets.ensurePersonalWorkspace(admin.id, admin.name);
    }
  }
  const authMail = createSmtpMailPort(process.env);
  // The bot needs durable links and send markers: without postgres it stays
  // off rather than announcing the same inbox events again after a restart.
  let telegram: TelegramNotifier | undefined;
  let telegramOk = false;
  // The notifier is built before the app (notifyInbox is an app option), but
  // triage callbacks only arrive via polling that starts after the app exists.
  const decideBridge: {
    fn?: SpecialistApi["decideForWorkspace"];
    suggestion?: SpecialistApi["resolveSuggestionForWorkspace"];
  } = {};
  const telegramBot = createTelegramBotFromEnv(process.env);
  if (telegramBot !== undefined && persistence.db !== undefined) {
    try {
      const me = await telegramBot.getMe();
      telegram = createTelegramNotifier({
        bot: telegramBot,
        store: createPostgresTelegramStore(persistence.db),
        logger,
        publicUrl:
          process.env["APP_PUBLIC_URL"] ??
          process.env["AUTH_PUBLIC_URL"] ??
          process.env["BETTER_AUTH_URL"] ??
          "http://127.0.0.1:5173",
        botUsername: me.username,
        openCabinet: async (userId) => {
          const workspaceId = await persistence.cabinets.findWorkspaceId(userId);
          if (workspaceId === undefined) return undefined;
          const cabinet = await persistence.cabinets.open(workspaceId);
          return {
            workspaceId,
            inbox: cabinet.catalog.urgentInbox().map((entry) => ({
              id: entry.id,
              procurementId: entry.procurementId,
              kind: entry.kind,
              title: entry.title,
              statusLabel: entry.statusLabel,
              detail: entry.detail,
              url: entry.url,
            })),
            async dismiss(id) {
              if (!cabinet.catalog.dismiss(id)) return false;
              cabinet.workspace.setDismissedInboxIds(cabinet.catalog.dismissedIds());
              await persistence.cabinets.persist(cabinet);
              return true;
            },
            async decide(cardId, kind) {
              if (decideBridge.fn === undefined) return "unavailable";
              const card = await decideBridge.fn(workspaceId, cardId, kind);
              return card === undefined ? "not_found" : "ok";
            },
            async resolveSuggestion(suggestionId, action) {
              if (decideBridge.suggestion === undefined) return "unavailable";
              const result = await decideBridge.suggestion(workspaceId, suggestionId, action);
              if (result === "ok") return "ok";
              return result === "not_found" ? "not_found" : "unavailable";
            },
          };
        },
      });
      telegramOk = true;
      logger.info("Telegram bot configured", { bot: me.username });
    } catch (error) {
      logger.error("Telegram bot unavailable", error);
      await recordJournal(persistence.journal, {
        kind: "platform",
        level: "error",
        message: "Telegram-бот не ответил на запуске. Уведомления в Telegram выключены.",
      });
    }
  } else if (telegramBot !== undefined) {
    logger.warn("Telegram bot token set but PostgreSQL is off — bot disabled");
  }
  const watchLimitRaw = process.env["SPECIALIST_WATCH_LIMIT"];
  const watchLimit =
    watchLimitRaw === undefined ? undefined : Math.max(0, Number.parseInt(watchLimitRaw, 10) || 0);
  const discoveryController = createDiscoveryController({
    requestIntervalMs: Math.max(
      0,
      Number.parseInt(process.env["SPECIALIST_DISCOVERY_REQUEST_INTERVAL_MS"] ?? "5000", 10) || 0,
    ),
    failureThreshold: Math.max(
      1,
      Number.parseInt(process.env["SPECIALIST_DISCOVERY_FAILURE_THRESHOLD"] ?? "3", 10) || 3,
    ),
    cooldownMs: Math.max(
      1_000,
      Number.parseInt(process.env["SPECIALIST_DISCOVERY_COOLDOWN_MS"] ?? "1800000", 10) || 1_800_000,
    ),
  });
  const app = await buildSpecialistApi({
    logger,
    blobDirectory,
    blobStore,
    cabinets: persistence.cabinets,
    journal: persistence.journal,
    postgres: persistence.postgres,
    ingestProgress,
    discoveryController,
    authDirectory: persistence.authDirectory,
    ...(authMail === undefined ? {} : { authMail }),
    authCookieSecure: process.env["AUTH_COOKIE_SECURE"] === "1",
    authPublicUrl:
      process.env["AUTH_PUBLIC_URL"] ?? process.env["BETTER_AUTH_URL"] ?? "http://127.0.0.1:5173",
    ...(process.env["INTERNAL_API_TOKEN"] === undefined
      ? {}
      : { internalApiToken: process.env["INTERNAL_API_TOKEN"] }),
    ...(searchHits === undefined ? {} : { searchHits }),
    ...(searchReview === undefined ? {} : { searchReview }),
    ...(searchIntent === undefined ? {} : { searchIntent }),
    ...(profileSuggest === undefined ? {} : { profileSuggest }),
    ...(suggestSearch === undefined ? {} : { suggestSearch }),
    ...(cardWatch === undefined ? {} : { cardWatch }),
    ...(monitorWatch === undefined ? {} : { monitorWatch }),
    ...(telegram === undefined ? {} : { telegram }),
    ...(persistence.db === undefined
      ? {}
      : {
          assistant: {
            memory: createPostgresDecisionMemoryStore(persistence.db),
            suggestions: createPostgresAssistantSuggestionStore(persistence.db),
            enabledFor: assistantPilotFromEnv(process.env["ASSISTANT_WORKSPACE_IDS"]),
          },
          ...(assistantDirections === undefined
            ? {}
            : { assistantDirections }),
        }),
    ...(watchLimit === undefined ? {} : { watchLimit }),
    ...(mcp === undefined
      ? {}
      : {
          documentIngest: createProcurementDocumentIngest({
            caller: mcp.caller,
            blobDirectory,
            blobStore,
            logger,
            progress: ingestProgress,
            ...ingestTimeout,
            ...(commercialReader === undefined ? {} : { commercialReader }),
          }),
        }),
    ...(mode === "live" ? { liveProcurementsOnly: true } : {}),
    searchBudgetMs,
    serviceHealth: {
      sha: resolveBuildSha(repoRoot),
      mode,
      objectStore: objectStoreKind(process.env),
      source: {
        background: mcp !== undefined,
        interactive: mcpInteractive !== undefined,
      },
      sources: enabledSourceIds.map(String),
      // The first configured source is required at boot — it is also the one
      // whose failure must fail readiness; extra sources degrade only.
      requiredSources: enabledSourceIds.slice(0, 1).map(String),
      // Cached lifecycle+probe snapshot — the endpoint stays synchronous and
      // never enqueues probe calls itself.
      ...(sourceHealth === undefined
        ? {}
        : { sourcesSnapshot: () => sourceHealth.snapshot() }),
      models: {
        searchIntent: searchIntent !== undefined,
        classifier: classifier !== undefined,
        commercialReader: commercialReader !== undefined,
      },
      mail: authMail !== undefined,
      telegram: telegramOk,
      telegramFailed: telegramBot !== undefined && !telegramOk,
      postgresConfigured: persistence.postgresConfigured,
      postgresPing: persistence.ping,
    },
  });
  appRef.current = app;
  decideBridge.fn = app.decideForWorkspace;
  decideBridge.suggestion = app.resolveSuggestionForWorkspace;
  const port = Number.parseInt(process.env["API_PORT"] ?? "3001", 10);
  await app.listen({ port, host: "127.0.0.1" });
  const transport = discoveryTransport(process.env);
  logger.info("Specialist API listening", {
    port,
    searchMode: mode,
    postgres: persistence.postgres,
    objectStore: objectStoreKind(process.env),
    discovery: transport.kind,
    watchingCount: (await persistence.cabinets.listIds()).length,
  });

  let redisRepeat: Awaited<ReturnType<typeof startDiscoveryRepeat>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (transport.kind === "off") {
    // Interval=0 must be honestly off: the BullMQ scheduler lives in Redis,
    // so an earlier registration keeps feeding the queue unless removed.
    const redisUrl = process.env["REDIS_URL"]?.trim() ?? "";
    if (redisUrl.length > 0) {
      try {
        await removeDiscoveryRepeat({ redisUrl, logger });
      } catch (error) {
        logger.warn("Redis discovery scheduler cleanup failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  if (transport.kind === "redis") {
    try {
      redisRepeat = await startDiscoveryRepeat({
        redisUrl: transport.redisUrl,
        intervalMs: transport.intervalMs,
        run: async () => {
          await app.runDiscovery();
        },
        logger,
      });
    } catch (error) {
      logger.warn("Redis discovery unavailable; using in-process interval", {
        error: error instanceof Error ? error.message : String(error),
      });
      await recordJournal(persistence.journal, {
        kind: "platform",
        level: "error",
        message: "Redis для слежения недоступен. Поиск новых закупок идёт внутри процесса.",
      });
    }
  }
  if (redisRepeat === undefined && transport.kind !== "off") {
    const intervalMs = transport.intervalMs;
    timer = setInterval(() => {
      void app.runDiscovery().catch((error: unknown) => {
        logger.error("Specialist discovery failed", error);
        void recordJournal(persistence.journal, {
          kind: "discovery",
          level: "error",
          message: "Фоновый поиск новых закупок не выполнен.",
        });
      });
    }, intervalMs);
  }

  // Telegram long polling: without a public HTTPS endpoint a webhook is
  // impossible, so the bot pulls updates itself — works from any server.
  let telegramTimer: ReturnType<typeof setTimeout> | undefined;
  if (telegram !== undefined) {
    let offset = 0;
    const poll = async (): Promise<void> => {
      try {
        offset = await telegram.pollOnce(offset);
      } catch (error) {
        logger.error("Telegram polling failed", error);
        await new Promise((resolve) => {
          setTimeout(resolve, 5_000);
        });
      }
      telegramTimer = setTimeout(() => {
        void poll();
      }, 1_000);
    };
    void poll();
  }

  const shutdown = async (): Promise<void> => {
    if (timer !== undefined) clearInterval(timer);
    if (telegramTimer !== undefined) clearTimeout(telegramTimer);
    sourceHealth?.stop();
    if (redisRepeat !== undefined) await redisRepeat.close();
    await app.close();
    if (mcp !== undefined) await mcp.close();
    if (mcpInteractive !== undefined) await mcpInteractive.close();
    await persistence.close();
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

await main();
