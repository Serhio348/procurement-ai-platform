import path from "node:path";
import { fileURLToPath } from "node:url";
import { SourceId } from "@procurement/contracts";
import { SpecialistCatalog } from "@procurement/domain";
import { createLogger } from "@procurement/observability";
import { buildSpecialistApi } from "./app.js";
import { resolveBlobDirectory } from "./blobs.js";
import { startDiscoveryRepeat } from "./discovery-queue.js";
import { discoveryTransport } from "./discovery-transport.js";
import { createProcurementDocumentIngest } from "./document-ingest.js";
import { createIngestProgressHub } from "./ingest-progress.js";
import { loadDotEnv } from "./load-env.js";
import { loadFixtureCatalog } from "./load-fixture.js";
import { createBlobStoreFromEnv, objectStoreKind } from "./object-store.js";
import { openSpecialistPersistence } from "./persist.js";
import { connectProcurementMcp } from "./procurement-mcp.js";
import { createProcurementSearchHits } from "./procurement-search.js";

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  await loadDotEnv(path.join(repoRoot, ".env"));
  const logger = createLogger({
    level: process.env["LOG_LEVEL"] === "debug" ? "debug" : "info",
    sink: (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
  });
  const mode = process.env["PROCUREMENT_SOURCE_MODE"] === "live" ? "live" : "fixture";
  const catalog = mode === "live" ? new SpecialistCatalog() : await loadFixtureCatalog();
  const blobDirectory = resolveBlobDirectory(process.env["DOCUMENT_BLOB_DIR"]);
  const blobStore = createBlobStoreFromEnv(process.env, blobDirectory);
  const ingestProgress = createIngestProgressHub();
  const persistence = await openSpecialistPersistence({
    workspacePath: path.join(repoRoot, "data", "specialist-workspace.json"),
    databaseUrl: process.env["DATABASE_URL"],
    logger,
  });
  await persistence.hydrateCatalog(catalog);
  const workspace = persistence.workspace;
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
  const app = await buildSpecialistApi({
    catalog,
    workspace,
    logger,
    blobDirectory,
    blobStore,
    persistWorkspace: persistence.persistWorkspace,
    persistCases: persistence.persistCases,
    ingestProgress,
    ...(searchHits === undefined ? {} : { searchHits }),
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
    watchingCount: workspace.profiles().filter((item) => item.watchNewProcurements).length,
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
    }
  }
  if (redisRepeat === undefined && transport.kind !== "off") {
    const intervalMs = transport.intervalMs;
    timer = setInterval(() => {
      void app.runDiscovery().catch((error: unknown) => {
        logger.error("Specialist discovery failed", error);
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
