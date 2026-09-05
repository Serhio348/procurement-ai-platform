import path from "node:path";
import { fileURLToPath } from "node:url";
import { SourceId } from "@procurement/contracts";
import { SpecialistCatalog } from "@procurement/domain";
import { createLogger } from "@procurement/observability";
import { buildSpecialistApi } from "./app.js";
import { resolveBlobDirectory } from "./blobs.js";
import { loadDotEnv } from "./load-env.js";
import { loadFixtureCatalog } from "./load-fixture.js";
import { connectProcurementMcp } from "./procurement-mcp.js";
import { createProcurementSearchHits } from "./procurement-search.js";
import { loadWorkspaceFile, saveWorkspaceFile } from "./workspace-file.js";

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
  const workspacePath = path.join(repoRoot, "data", "specialist-workspace.json");
  const workspace = await loadWorkspaceFile(workspacePath);
  const mcp =
    mode === "live" ? await connectProcurementMcp({ mode: "live", logger }) : undefined;
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
    persistWorkspace: async () => {
      await saveWorkspaceFile(workspacePath, workspace);
    },
    ...(searchHits === undefined ? {} : { searchHits }),
    ...(mode === "live" ? { liveProcurementsOnly: true } : {}),
  });
  const port = Number.parseInt(process.env["API_PORT"] ?? "3001", 10);
  await app.listen({ port, host: "127.0.0.1" });
  logger.info("Specialist API listening", {
    port,
    searchMode: mode,
    watchNewProcurements: workspace.profile().watchNewProcurements,
  });

  const intervalMs = Number.parseInt(process.env["SPECIALIST_DISCOVERY_INTERVAL_MS"] ?? "600000", 10);
  const timer =
    Number.isFinite(intervalMs) && intervalMs > 0
      ? setInterval(() => {
          void app.runDiscovery().catch((error: unknown) => {
            logger.error("Specialist discovery failed", error);
          });
        }, intervalMs)
      : undefined;

  const shutdown = async (): Promise<void> => {
    if (timer !== undefined) clearInterval(timer);
    await app.close();
    if (mcp !== undefined) await mcp.close();
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

await main();
