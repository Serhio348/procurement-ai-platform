import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLogger } from "@procurement/observability";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureDocumentCatalog } from "./fixture-catalog.js";
import { createDocumentsMcpServer } from "./server.js";

describe("Documents MCP", () => {
  let client: Client;
  let server: ReturnType<typeof createDocumentsMcpServer>;

  beforeEach(async () => {
    const catalog = await FixtureDocumentCatalog.load(
      fileURLToPath(new URL("../../../tests/fixtures/documents/catalog.json", import.meta.url)),
    );
    server = createDocumentsMcpServer({
      catalog,
      logger: createLogger({ sink: () => undefined }),
    });
    client = new Client({ name: "documents-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await Promise.all([client.close(), server.close()]);
  });

  it("publishes document and file tools without a delete tool", async () => {
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "documents.download",
      "documents.extract_tables",
      "documents.extract_text",
      "documents.get_page",
      "documents.list",
      "documents.ocr",
      "documents.search",
      "files.exists",
      "files.get",
      "files.put",
    ]);
  });

  it("stores identical downloads once and extracts digital text without OCR", async () => {
    const first = await client.callTool({
      name: "documents.download",
      arguments: { sourceUrl: "https://example.test/files/spec-001.pdf" },
    });
    const second = await client.callTool({
      name: "documents.download",
      arguments: { sourceUrl: "https://example.test/files/spec-001.pdf" },
    });
    const hash = (first.structuredContent as { hash: string }).hash;
    expect((second.structuredContent as { hash: string }).hash).toBe(hash);

    const extracted = await client.callTool({
      name: "documents.extract_text",
      arguments: { hash },
    });
    expect(extracted.structuredContent).toMatchObject({
      status: "extracted",
      ocrApplied: false,
      text: expect.stringContaining("Аванс 30"),
    });

    const tables = await client.callTool({
      name: "documents.extract_tables",
      arguments: { hash },
    });
    expect(tables.structuredContent).toMatchObject({
      tables: [{ rows: [["Показатель", "Значение"], ["Аванс", "30%"]] }],
    });
  });

  it("does not treat a poorly read scan as extracted text until OCR reports low confidence", async () => {
    const downloaded = await client.callTool({
      name: "documents.download",
      arguments: { sourceUrl: "https://example.test/files/scan-low.tiff" },
    });
    const hash = (downloaded.structuredContent as { hash: string }).hash;
    const extracted = await client.callTool({
      name: "documents.extract_text",
      arguments: { hash },
    });
    expect(extracted.structuredContent).toMatchObject({
      status: "ocr_required",
      text: "",
      ocrApplied: false,
    });

    const ocr = await client.callTool({
      name: "documents.ocr",
      arguments: { hash },
    });
    expect(ocr.structuredContent).toMatchObject({
      status: "ocr_low_confidence",
      ocrApplied: true,
      confidence: 0.31,
    });
  });

  it("searches already extracted text and returns a single page", async () => {
    const downloaded = await client.callTool({
      name: "documents.download",
      arguments: { sourceUrl: "https://example.test/files/spec-001.pdf" },
    });
    const hash = (downloaded.structuredContent as { hash: string }).hash;
    await client.callTool({ name: "documents.extract_text", arguments: { hash } });

    const search = await client.callTool({
      name: "documents.search",
      arguments: { hash, query: "Аванс" },
    });
    expect(search.structuredContent).toMatchObject({
      hits: [{ page: 1, snippet: expect.stringContaining("Аванс") }],
    });

    const page = await client.callTool({
      name: "documents.get_page",
      arguments: { hash, page: 1 },
    });
    expect(page.structuredContent).toMatchObject({
      page: 1,
      ocrApplied: false,
      text: expect.stringContaining("Аванс 30"),
    });
  });

  it("rejects an unknown download URL", async () => {
    const result = await client.callTool({
      name: "documents.download",
      arguments: { sourceUrl: "https://example.test/missing.pdf" },
    });
    expect(result.isError).toBe(true);
    expect(result._meta).toMatchObject({ errorKind: "not_found" });
  });
});
