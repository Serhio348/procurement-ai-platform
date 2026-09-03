import { createLogger } from "@procurement/observability";
import { buildSpecialistApi } from "./app.js";
import { loadFixtureCatalog } from "./load-fixture.js";

async function main(): Promise<void> {
  const logger = createLogger({
    level: process.env["LOG_LEVEL"] === "debug" ? "debug" : "info",
    sink: (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
  });
  const catalog = await loadFixtureCatalog();
  const app = await buildSpecialistApi({ catalog, logger });
  const port = Number.parseInt(process.env["API_PORT"] ?? "3001", 10);
  await app.listen({ port, host: "127.0.0.1" });
  logger.info("Specialist API listening", { port });
}

await main();
