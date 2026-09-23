import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RequestId, SourceId, SpecialistProcurementCard } from "@procurement/contracts";
import type { McpToolCaller } from "@procurement/mcp-client";
import { rarEntries, zipEntries } from "@procurement/mcp-documents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { putBlob } from "./blobs.js";
import { createProcurementDocumentIngest } from "./document-ingest.js";
import { createIngestProgressHub } from "./ingest-progress.js";

const WS = "00000000-0000-4000-8000-0000000000ee";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fakeCaller(hash: string): McpToolCaller["callTool"] {
  return async (toolName) => {
    if (toolName === "procurement.get_documents") {
      return {
        structuredContent: {
          documents: [
            {
              name: "ТЗ.pdf",
              sourceUrl: "https://goszakupki.by/files/1",
              downloadUrl: "https://goszakupki.by/files/1?download=1",
              mimeType: "application/pdf",
              discoveredAt: "2026-09-05T08:00:00.000Z",
            },
          ],
        },
      };
    }
    if (toolName === "procurement.download") {
      return {
        structuredContent: {
          hash,
          storageKey: `blobs/${hash}`,
          sizeBytes: 12,
          contentType: "application/pdf",
        },
      };
    }
    throw new Error(`unexpected tool ${toolName}`);
  };
}

describe("createProcurementDocumentIngest", () => {
  it("lists and downloads through Procurement MCP and never searches", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const blobDirectory = await mkdtemp(path.join(os.tmpdir(), "ingest-blobs-"));
    tmpDirs.push(blobDirectory);
    await putBlob(blobDirectory, hash, bytes);
    const callTool = vi.fn<McpToolCaller["callTool"]>().mockImplementation(fakeCaller(hash));
    const progress = createIngestProgressHub();
    const blobStore = { put: vi.fn(async () => undefined), get: vi.fn(async () => undefined) };
    const port = createProcurementDocumentIngest({
      caller: { callTool },
      blobDirectory,
      blobStore,
      progress,
    });
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/401",
      sourceProcurementId: "auction/401",
      live: true,
    });

    progress.begin(WS, card.id);
    const next = await port.ingest(card, WS);
    progress.done(WS, card.id);

    expect(next.documents[0]?.status).toBe("hashed");
    expect(next.documents[0]?.hash).toBe(hash);
    expect(progress.snapshot(WS, card.id).phase).toBe("done");
    expect(progress.snapshot(WS, card.id).files[0]?.state).toMatch(/read|skipped/);
    expect(progress.snapshot(WS, card.id).files[0]?.hash).toBe(hash);
    expect(callTool.mock.calls.map((item) => item[0])).toEqual([
      "procurement.get_documents",
      "procurement.download",
    ]);
    expect(callTool.mock.calls[0]?.[1]).toMatchObject({
      sourceId: SourceId.parse("goszakupki_by"),
      sourceProcurementId: "auction/401",
    });
    expect(RequestId.parse(String(callTool.mock.calls[0]?.[2]?.requestId)).length).toBeGreaterThan(0);
    expect(blobStore.put).toHaveBeenCalledWith(hash, expect.any(Uint8Array));
  });

  it("unpacks a downloaded zip and reads the Word file inside", async () => {
    const inner = zipEntries({
      "word/document.xml":
        '<?xml version="1.0"?><w:document><w:p><w:r><w:t>оплата в течение 30 календарных дней после акта</w:t></w:r></w:p></w:document>',
    });
    const pack = zipEntries({ "ТЗ.docx": inner });
    const hash = createHash("sha256").update(pack).digest("hex");
    const blobDirectory = await mkdtemp(path.join(os.tmpdir(), "ingest-zip-"));
    tmpDirs.push(blobDirectory);
    await putBlob(blobDirectory, hash, pack);
    const callTool = vi.fn<McpToolCaller["callTool"]>(async (toolName) => {
      if (toolName === "procurement.get_documents") {
        return {
          structuredContent: {
            documents: [
              {
                name: "Комплект.zip",
                sourceUrl: "https://goszakupki.by/files/1",
                downloadUrl: "https://goszakupki.by/files/1?download=1",
                mimeType: "application/zip",
                discoveredAt: "2026-09-05T08:00:00.000Z",
              },
            ],
          },
        };
      }
      if (toolName === "procurement.download") {
        return {
          structuredContent: {
            hash,
            storageKey: `blobs/${hash}`,
            sizeBytes: pack.byteLength,
            contentType: "application/zip",
          },
        };
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const port = createProcurementDocumentIngest({
      caller: { callTool },
      blobDirectory,
    });
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/401",
      sourceProcurementId: "auction/401",
      live: true,
    });

    const next = await port.ingest(card, WS);

    expect(next.documents.map((item) => item.name)).toEqual([
      "Комплект.zip",
      "Комплект.zip / ТЗ.docx",
    ]);
    expect(next.documents[0]?.extraction?.kind).toBe("archive");
    expect(next.documents[1]?.extraction?.kind).toBe("office_text");
    expect(next.documents[1]?.extraction?.textPreview).toContain("30 календарных дней");
  });

  it("unpacks a downloaded rar and reads the Word file inside", async () => {
    const inner = zipEntries({
      "word/document.xml":
        '<?xml version="1.0"?><w:document><w:p><w:r><w:t>оплата в течение 45 календарных дней</w:t></w:r></w:p></w:document>',
    });
    const pack = rarEntries({ "ТЗ.docx": inner });
    const hash = createHash("sha256").update(pack).digest("hex");
    const blobDirectory = await mkdtemp(path.join(os.tmpdir(), "ingest-rar-"));
    tmpDirs.push(blobDirectory);
    await putBlob(blobDirectory, hash, pack);
    const callTool = vi.fn<McpToolCaller["callTool"]>(async (toolName) => {
      if (toolName === "procurement.get_documents") {
        return {
          structuredContent: {
            documents: [
              {
                name: "Комплект.rar",
                sourceUrl: "https://goszakupki.by/files/2",
                downloadUrl: "https://goszakupki.by/files/2?download=1",
                mimeType: "application/vnd.rar",
                discoveredAt: "2026-09-05T08:00:00.000Z",
              },
            ],
          },
        };
      }
      if (toolName === "procurement.download") {
        return {
          structuredContent: {
            hash,
            storageKey: `blobs/${hash}`,
            sizeBytes: pack.byteLength,
            contentType: "application/vnd.rar",
          },
        };
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const port = createProcurementDocumentIngest({
      caller: { callTool },
      blobDirectory,
    });
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/401",
      sourceProcurementId: "auction/401",
      live: true,
    });

    const next = await port.ingest(card, WS);

    expect(next.documents.map((item) => item.name)).toEqual([
      "Комплект.rar",
      "Комплект.rar / ТЗ.docx",
    ]);
    expect(next.documents[0]?.extraction?.kind).toBe("archive");
    expect(next.documents[1]?.extraction?.kind).toBe("office_text");
    expect(next.documents[1]?.extraction?.textPreview).toContain("45 календарных дней");
  });

  it("fails a download that returned an HTML page instead of the file", async () => {
    const page = new TextEncoder().encode(
      '<!DOCTYPE html><html><body><p>Сессия истекла</p></body></html>',
    );
    const hash = createHash("sha256").update(page).digest("hex");
    const blobDirectory = await mkdtemp(path.join(os.tmpdir(), "ingest-html-"));
    tmpDirs.push(blobDirectory);
    await putBlob(blobDirectory, hash, page);
    const callTool = vi.fn<McpToolCaller["callTool"]>(async (toolName) => {
      if (toolName === "procurement.get_documents") {
        return {
          structuredContent: {
            documents: [
              {
                name: "Комплект.zip",
                sourceUrl: "https://goszakupki.by/files/3",
                downloadUrl: "https://goszakupki.by/files/3?download=1",
                mimeType: "application/zip",
                discoveredAt: "2026-09-05T08:00:00.000Z",
              },
            ],
          },
        };
      }
      if (toolName === "procurement.download") {
        return {
          structuredContent: {
            hash,
            storageKey: `blobs/${hash}`,
            sizeBytes: page.byteLength,
            contentType: "application/zip",
          },
        };
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const port = createProcurementDocumentIngest({
      caller: { callTool },
      blobDirectory,
    });
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/401",
      sourceProcurementId: "auction/401",
      live: true,
    });

    const next = await port.ingest(card, WS);

    // An HTML stub must not reach the archive unpacker — the document is
    // honestly marked failed instead of becoming an «empty archive».
    expect(next.documents).toHaveLength(1);
    expect(next.documents[0]?.status).toBe("download_failed");
    expect(next.documents[0]?.note).toContain("HTML");
  });

  it("reindexes hashed blobs without listing or downloading from the platform", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const blobDirectory = await mkdtemp(path.join(os.tmpdir(), "reindex-blobs-"));
    tmpDirs.push(blobDirectory);
    await putBlob(blobDirectory, hash, bytes);
    const callTool = vi.fn<McpToolCaller["callTool"]>().mockImplementation(fakeCaller(hash));
    const progress = createIngestProgressHub();
    const port = createProcurementDocumentIngest({
      caller: { callTool },
      blobDirectory,
      progress,
    });
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/401",
      sourceProcurementId: "auction/401",
      live: true,
      triage: "participate",
      documents: [
        {
          name: "ТЗ.pdf",
          sourceUrl: "https://goszakupki.by/files/1",
          hash,
          status: "hashed",
        },
      ],
    });

    progress.begin(WS, card.id);
    const reindex = port.reindex;
    if (reindex === undefined) {
      throw new Error("reindex is required");
    }
    const next = await reindex(card, WS);
    progress.done(WS, card.id);

    expect(callTool).not.toHaveBeenCalled();
    expect(next.documents[0]?.status).toBe("hashed");
    expect(next.documents[0]?.hash).toBe(hash);
  });

  it("does not download a file the case already hashed", async () => {
    const oldBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    const newBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x32]);
    const oldHash = createHash("sha256").update(oldBytes).digest("hex");
    const newHash = createHash("sha256").update(newBytes).digest("hex");
    const blobDirectory = await mkdtemp(path.join(os.tmpdir(), "ingest-skip-"));
    tmpDirs.push(blobDirectory);
    await putBlob(blobDirectory, newHash, newBytes);
    const callTool = vi.fn<McpToolCaller["callTool"]>(async (toolName) => {
      if (toolName === "procurement.get_documents") {
        return {
          structuredContent: {
            documents: [
              {
                name: "ТЗ.pdf",
                sourceUrl: "https://goszakupki.by/files/1",
                downloadUrl: "https://goszakupki.by/files/1?download=1",
                mimeType: "application/pdf",
                discoveredAt: "2026-09-05T08:00:00.000Z",
              },
              {
                name: "Изменения.pdf",
                sourceUrl: "https://goszakupki.by/files/2",
                downloadUrl: "https://goszakupki.by/files/2?download=1",
                mimeType: "application/pdf",
                discoveredAt: "2026-09-05T08:00:00.000Z",
              },
            ],
          },
        };
      }
      if (toolName === "procurement.download") {
        return {
          structuredContent: {
            hash: newHash,
            storageKey: `blobs/${newHash}`,
            sizeBytes: newBytes.byteLength,
            contentType: "application/pdf",
          },
        };
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const port = createProcurementDocumentIngest({
      caller: { callTool },
      blobDirectory,
    });
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/401",
      sourceProcurementId: "auction/401",
      live: true,
      documents: [
        {
          name: "ТЗ.pdf",
          sourceUrl: "https://goszakupki.by/files/1",
          hash: oldHash,
          status: "hashed",
        },
      ],
    });

    const next = await port.ingest(card, WS);

    expect(callTool.mock.calls.map((item) => item[0])).toEqual([
      "procurement.get_documents",
      "procurement.download",
    ]);
    expect(next.documents.map((item) => item.sourceUrl).sort()).toEqual([
      "https://goszakupki.by/files/1",
      "https://goszakupki.by/files/2",
    ]);
    expect(next.documents.find((item) => item.sourceUrl.endsWith("/1"))?.hash).toBe(oldHash);
    expect(next.documents.find((item) => item.sourceUrl.endsWith("/2"))?.hash).toBe(newHash);
  });

  it("does not report a download as hashed when the blob cannot be read back", async () => {
    const hash = "a".repeat(64);
    const port = createProcurementDocumentIngest({
      caller: { callTool: fakeCaller(hash) },
      blobDirectory: path.join(os.tmpdir(), "missing-blobs-never-created"),
    });
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/401",
      sourceProcurementId: "auction/401",
      live: true,
    });

    const next = await port.ingest(card, WS);

    expect(next.documents[0]?.status).toBe("download_failed");
    expect(next.documents[0]?.note).toMatch(/не найден в хранилище/);
  });
});
