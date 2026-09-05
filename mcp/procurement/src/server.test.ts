import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLogger, type LogRecord } from "@procurement/observability";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureProcurementSource } from "./fixture-source.js";
import { GoszakupkiBySource } from "./goszakupki-by-source.js";
import { createProcurementMcpServer } from "./server.js";
import { SourceAccessError } from "./source-registry.js";

describe("Procurement MCP", () => {
  let client: Client;
  let server: ReturnType<typeof createProcurementMcpServer>;
  let records: LogRecord[];

  beforeEach(async () => {
    const fixturePath = fileURLToPath(
      new URL("../../../tests/fixtures/procurement/normalized.json", import.meta.url),
    );
    const source = new FixtureProcurementSource(
      JSON.parse(await readFile(fixturePath, "utf8")) as unknown,
    );
    const liveSource = new GoszakupkiBySource({
      client: {
        get: async () => {
          throw new SourceAccessError("goszakupki_by", "simulated outage");
        },
      },
    });
    records = [];
    server = createProcurementMcpServer({
      sources: [source, liveSource],
      logger: createLogger({ sink: (record) => records.push(record) }),
    });
    client = new Client({ name: "procurement-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await Promise.all([client.close(), server.close()]);
  });

  it("publishes the complete source-neutral tool surface", async () => {
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "procurement.download",
      "procurement.get",
      "procurement.get_changes",
      "procurement.get_documents",
      "procurement.get_history",
      "procurement.get_lots",
      "procurement.get_status",
      "procurement.search",
    ]);
  });

  it("carries the client correlation id into structured logs", async () => {
    await client.callTool({
      name: "procurement.search",
      arguments: { sourceId: "fixture" },
      _meta: { requestId: "correlation-1" },
    });

    expect(records).toContainEqual(
      expect.objectContaining({
        requestId: "correlation-1",
        toolName: "procurement.search",
      }),
    );
  });

  it("searches normalized fixtures without receiving a domain profile", async () => {
    const result = await client.callTool({
      name: "procurement.search",
      arguments: {
        sourceId: "fixture",
        keywords: ["ТРАНСФОРМАТОР"],
        excludeKeywords: ["ремонт"],
        limit: 10,
        offset: 0,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      hits: [
        { sourceProcurementId: "auction-001" },
        { sourceProcurementId: "marketing-001" },
      ],
    });
  });

  it("returns card, status, lots, documents, history and changes", async () => {
    const input = { sourceId: "fixture", sourceProcurementId: "auction-001" };
    const [card, status, lots, documents, history, changes] = await Promise.all([
      client.callTool({ name: "procurement.get", arguments: input }),
      client.callTool({ name: "procurement.get_status", arguments: input }),
      client.callTool({ name: "procurement.get_lots", arguments: input }),
      client.callTool({ name: "procurement.get_documents", arguments: input }),
      client.callTool({ name: "procurement.get_history", arguments: input }),
      client.callTool({
        name: "procurement.get_changes",
        arguments: { ...input, since: "2026-08-27T00:00:00+03:00" },
      }),
    ]);

    expect(card.structuredContent).toMatchObject({ title: expect.stringContaining("подстанция") });
    expect(status.structuredContent).toMatchObject({ status: "accepting_bids" });
    expect(lots.structuredContent).toMatchObject({ lots: [{ number: "1" }] });
    expect(documents.structuredContent).toMatchObject({
      documents: [{ name: "Техническое задание.pdf" }],
    });
    expect(history.structuredContent).toMatchObject({ clarifications: [{ answer: expect.any(String) }] });
    expect(changes.structuredContent).toMatchObject({ changes: [{ kind: "deadline_changed" }] });
  });

  it("accepts a sparse source card instead of inventing missing fields", async () => {
    const result = await client.callTool({
      name: "procurement.get",
      arguments: { sourceId: "fixture", sourceProcurementId: "etrade-001" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      title: "Кабель силовой",
      status: "unknown",
    });
    expect(result.structuredContent).not.toHaveProperty("amount");
  });

  it("rejects profile-shaped input and never forwards it to a source", async () => {
    const result = await client.callTool({
      name: "procurement.search",
      arguments: {
        sourceId: "fixture",
        keywords: [],
        domainProfile: { slug: "must-not-cross-boundary" },
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns an MCP tool error for unknown source records", async () => {
    const result = await client.callTool({
      name: "procurement.get",
      arguments: { sourceId: "fixture", sourceProcurementId: "missing" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("not found") }),
    ]);
    expect(result._meta).toMatchObject({ errorKind: "not_found" });
  });

  it("maps an unavailable live source to the public MCP error taxonomy", async () => {
    const result = await client.callTool({
      name: "procurement.search",
      arguments: { sourceId: "goszakupki_by", keywords: ["трансформатор"] },
    });

    expect(result.isError).toBe(true);
    expect(result._meta).toMatchObject({ errorKind: "source_unavailable" });
  });
});
