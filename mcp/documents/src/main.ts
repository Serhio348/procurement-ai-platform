import { fileURLToPath } from "node:url";
import { createLogger } from "@procurement/observability";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FixtureDocumentCatalog } from "./fixture-catalog.js";
import { createDocumentsMcpServer } from "./server.js";

async function main(): Promise<void> {
  const defaultCatalog = fileURLToPath(
    new URL("../../../tests/fixtures/documents/catalog.json", import.meta.url),
  );
  const catalogPath = process.env["DOCUMENT_FIXTURE_PATH"] ?? defaultCatalog;
  const catalog = await FixtureDocumentCatalog.load(catalogPath);
  const logger = createLogger({
    level: process.env["LOG_LEVEL"] === "debug" ? "debug" : "info",
    sink: (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
  });
  const server = createDocumentsMcpServer({ catalog, logger });
  await server.connect(new StdioServerTransport());
}

await main();
