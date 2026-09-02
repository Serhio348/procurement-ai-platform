import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createLogger } from "@procurement/observability";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FixtureProcurementSource } from "./fixture-source.js";
import { GoszakupkiHttpClient } from "./goszakupki-by-http.js";
import { GoszakupkiBySource } from "./goszakupki-by-source.js";
import { createProcurementMcpServer } from "./server.js";

async function main(): Promise<void> {
  const mode = process.env["PROCUREMENT_SOURCE_MODE"] ?? "fixture";
  const source =
    mode === "fixture"
      ? await fixtureSource()
      : mode === "live"
        ? liveSource()
        : undefined;
  if (source === undefined) {
    throw new Error(`Unsupported PROCUREMENT_SOURCE_MODE: ${mode}`);
  }
  const logger = createLogger({
    level: process.env["LOG_LEVEL"] === "debug" ? "debug" : "info",
    sink: (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
  });
  const server = createProcurementMcpServer({ sources: [source], logger });
  await server.connect(new StdioServerTransport());
}

async function fixtureSource(): Promise<FixtureProcurementSource> {
  const defaultFixturePath = fileURLToPath(
    new URL("../../../tests/fixtures/procurement/normalized.json", import.meta.url),
  );
  const fixturePath = process.env["PROCUREMENT_FIXTURE_PATH"] ?? defaultFixturePath;
  const dataset = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
  return new FixtureProcurementSource(dataset);
}

function liveSource(): GoszakupkiBySource {
  return new GoszakupkiBySource({
    client: new GoszakupkiHttpClient({
      ...(process.env["GOSZAKUPKI_BY_BASE_URL"] === undefined
        ? {}
        : { baseUrl: process.env["GOSZAKUPKI_BY_BASE_URL"] }),
      requestsPerMinute: positiveNumber(
        process.env["GOSZAKUPKI_BY_RATE_LIMIT_RPM"],
        20,
        "GOSZAKUPKI_BY_RATE_LIMIT_RPM",
      ),
      timeoutMs: positiveNumber(
        process.env["GOSZAKUPKI_BY_TIMEOUT_MS"],
        20_000,
        "GOSZAKUPKI_BY_TIMEOUT_MS",
      ),
      ...(process.env["GOSZAKUPKI_BY_USER_AGENT"] === undefined
        ? {}
        : { userAgent: process.env["GOSZAKUPKI_BY_USER_AGENT"] }),
    }),
  });
}

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

await main();
