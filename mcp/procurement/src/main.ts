import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createLogger } from "@procurement/observability";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FixtureProcurementSource } from "./fixture-source.js";
import { createProcurementMcpServer } from "./server.js";

async function main(): Promise<void> {
  const mode = process.env["PROCUREMENT_SOURCE_MODE"] ?? "fixture";
  if (mode !== "fixture") {
    throw new Error(
      "Live procurement transport is not implemented without verified goszakupki.by fixtures",
    );
  }

  const defaultFixturePath = fileURLToPath(
    new URL("../../../tests/fixtures/procurement/normalized.json", import.meta.url),
  );
  const fixturePath = process.env["PROCUREMENT_FIXTURE_PATH"] ?? defaultFixturePath;
  const dataset = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
  const source = new FixtureProcurementSource(dataset);
  const logger = createLogger({
    level: process.env["LOG_LEVEL"] === "debug" ? "debug" : "info",
    sink: (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
  });
  const server = createProcurementMcpServer({ sources: [source], logger });
  await server.connect(new StdioServerTransport());
}

await main();
