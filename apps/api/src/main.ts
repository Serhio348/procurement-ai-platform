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
import { createIngestProgressHub } from "./ingest-progress.js";
import { loadDotEnv } from "./load-env.js";
import { createBlobStoreFromEnv, objectStoreKind } from "./object-store.js";
import { recordJournal } from "./admin/journal.js";
import { openSpecialistPersistence } from "./persist.js";
import { connectProcurementMcp } from "./procurement-mcp.js";
import { createProcurementSearchHits } from "./procurement-search.js";
import { createSearchClassifierFromEnv } from "./search-classifier.js";
import { createProcurementSearchReview } from "./search-review.js";
import { createDiscoveryController } from "./discovery-control.js";
import { createProcurementCardWatch } from "./card-watch.js";

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
      ? await connectProcurementMcp({ mode: "live", logger, blobDirectory })
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
    mcp === undefined
      ? undefined
      : createProcurementCardWatch({
          caller: mcp.caller,
          sourceId: SourceId.parse("goszakupki_by"),
          logger,
        });
  const classifier = createSearchClassifierFromEnv(process.env);
  const searchReview =
    mcp === undefined
      ? undefined
      : createProcurementSearchReview({
          caller: mcp.caller,
          ...(classifier === undefined ? {} : { classifier }),
          logger,
        });
  if (mcp !== undefined) {
    logger.info("Search review configured", { model: classifier !== undefined });
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
  const watchLimitRaw = process.env["SPECIALIST_WATCH_LIMIT"];
  const watchLimit =
    watchLimitRaw === undefined ? undefined : Math.max(0, Number.parseInt(watchLimitRaw, 10) || 0);
  const discoveryController = createDiscoveryController({
    requestIntervalMs: Math.max(
      0,
      Number.parseInt(process.env["SPECIALIST_DISCOVERY_REQUEST_INTERVAL_MS"] ?? "0", 10) || 0,
    ),
    failureThreshold: Math.max(
      1,
      Number.parseInt(process.env["SPECIALIST_DISCOVERY_FAILURE_THRESHOLD"] ?? "3", 10) || 3,
    ),
    cooldownMs: Math.max(
      1_000,
      Number.parseInt(process.env["SPECIALIST_DISCOVERY_COOLDOWN_MS"] ?? "300000", 10) || 300_000,
    ),
  });
  const app = await buildSpecialistApi({
    logger,
    blobDirectory,
    blobStore,
    cabinets: persistence.cabinets,
    journal: persistence.journal,
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
    ...(cardWatch === undefined ? {} : { cardWatch }),
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
          }),
        }),
    ...(mode === "live" ? { liveProcurementsOnly: true } : {}),
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

  const shutdown = async (): Promise<void> => {
    if (timer !== undefined) clearInterval(timer);
    if (redisRepeat !== undefined) await redisRepeat.close();
    await app.close();
    if (mcp !== undefined) await mcp.close();
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
