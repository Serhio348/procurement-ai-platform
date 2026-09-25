import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SourceId } from "@procurement/contracts";
import { createLogger } from "@procurement/observability";
import { buildSpecialistApi } from "./app.js";
import { createSmtpMailPort } from "./auth/mail.js";
import { resolveBlobDirectory } from "./blobs.js";
import { startDiscoveryRepeat } from "./discovery-queue.js";
import { discoveryTransport } from "./discovery-transport.js";
import { createProcurementDocumentIngest } from "./document-ingest.js";
import { createCommercialReaderFromEnv } from "./commercial-reader.js";
import { createIngestProgressHub } from "./ingest-progress.js";
import { loadDotEnv } from "./load-env.js";
import { createBlobStoreFromEnv, objectStoreKind } from "./object-store.js";
import { recordJournal } from "./admin/journal.js";
import { openSpecialistPersistence } from "./persist.js";
import { connectProcurementMcp } from "./procurement-mcp.js";
import { createProcurementSearchHits } from "./procurement-search.js";
import { createProfileSuggestFromEnv } from "./profile-suggest.js";
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
import { createPostgresTelegramStore } from "@procurement/db";

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
  const mcp =
    mode === "live"
      ? await connectProcurementMcp({ mode: "live", logger, blobDirectory, lane: "background" })
      : undefined;
  // Interactive reads (card open, decision hydrate) get their own child process:
  // one stdio pipe is strictly serial, so a card click would otherwise queue
  // behind every background search/discovery/ingest call.
  const mcpInteractive =
    mode === "live"
      ? await connectProcurementMcp({ mode: "live", logger, blobDirectory, lane: "interactive" })
      : undefined;
  const searchHits =
    mcp === undefined
      ? undefined
      : createProcurementSearchHits({
          caller: mcp.caller,
          sourceId: SourceId.parse("goszakupki_by"),
          logger,
        });
  const cardWatch =
    mcpInteractive === undefined
      ? undefined
      : createProcurementCardWatch({
          caller: mcpInteractive.caller,
          sourceId: SourceId.parse("goszakupki_by"),
          logger,
        });
  const monitorWatch =
    mcp === undefined
      ? undefined
      : createProcurementCardWatch({
          caller: mcp.caller,
          sourceId: SourceId.parse("goszakupki_by"),
          logger,
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
        });
  const commercialReader = createCommercialReaderFromEnv(process.env);
  const profileSuggest = createProfileSuggestFromEnv(process.env);
  // The listing probe answers on the interactive lane — a specialist waiting
  // on «Заполнить профиль» must not queue behind background search/ingest.
  const suggestSearch =
    mcpInteractive === undefined
      ? undefined
      : createProcurementSearchHits({
          caller: mcpInteractive.caller,
          sourceId: SourceId.parse("goszakupki_by"),
          logger,
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
            ...(commercialReader === undefined ? {} : { commercialReader }),
          }),
        }),
    ...(mode === "live" ? { liveProcurementsOnly: true } : {}),
    serviceHealth: {
      sha: resolveBuildSha(repoRoot),
      mode,
      objectStore: objectStoreKind(process.env),
      source: {
        background: mcp !== undefined,
        interactive: mcpInteractive !== undefined,
      },
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
