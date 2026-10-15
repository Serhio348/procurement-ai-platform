import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ProcurementSourcePort } from "@procurement/contracts";
import { createLogger, type Logger } from "@procurement/observability";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FixtureProcurementSource } from "./fixture-source.js";
import { GoszakupkiHttpClient } from "./goszakupki-by-http.js";
import { GoszakupkiBySource } from "./goszakupki-by-source.js";
import { ButbHttpClient } from "./butb-http.js";
import { ButbSource } from "./butb-source.js";
import { createProcurementMcpServer } from "./server.js";

async function main(): Promise<void> {
  const mode = process.env["PROCUREMENT_SOURCE_MODE"] ?? "fixture";
  const logger = createLogger({
    level: process.env["LOG_LEVEL"] === "debug" ? "debug" : "info",
    sink: (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
  });
  const sources =
    mode === "fixture"
      ? [await fixtureSource()]
      : mode === "live"
        ? liveSources(logger)
        : undefined;
  if (sources === undefined || sources.length === 0) {
    throw new Error(`Unsupported PROCUREMENT_SOURCE_MODE: ${mode}`);
  }
  const server = createProcurementMcpServer({ sources, logger });
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

function liveSources(logger: Logger): ProcurementSourcePort[] {
  const sources: ProcurementSourcePort[] = [
    new GoszakupkiBySource({
      logger,
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
        maxDownloadBytes: positiveNumber(
          process.env["GOSZAKUPKI_BY_MAX_DOWNLOAD_BYTES"],
          2 * 1024 * 1024 * 1024,
          "GOSZAKUPKI_BY_MAX_DOWNLOAD_BYTES",
        ),
        ...(process.env["GOSZAKUPKI_BY_USER_AGENT"] === undefined
          ? {}
          : { userAgent: process.env["GOSZAKUPKI_BY_USER_AGENT"] }),
      }),
    }),
  ];
  // BUTB is opt-in: the JSF session protocol is still being proven, and the
  // adapter must never disturb the goszakupki lane for active specialists.
  if (process.env["BUTB_ENABLED"] === "1") {
    sources.push(
      new ButbSource({
        logger,
        client: new ButbHttpClient({
          ...(process.env["BUTB_BY_BASE_URL"] === undefined
            ? {}
            : { baseUrl: process.env["BUTB_BY_BASE_URL"] }),
          requestsPerMinute: positiveNumber(
            process.env["BUTB_BY_RATE_LIMIT_RPM"],
            12,
            "BUTB_BY_RATE_LIMIT_RPM",
          ),
          timeoutMs: positiveNumber(
            process.env["BUTB_BY_TIMEOUT_MS"],
            20_000,
            "BUTB_BY_TIMEOUT_MS",
          ),
        }),
      }),
    );
    logger.info("BUTB source enabled", { component: "procurement-mcp" });
  }
  return sources;
}

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

await main();
