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

  it("follows a hidden docx hyperlink and indexes the linked file", async () => {
    const linkDocx = zipEntries({
      "word/document.xml":
        '<?xml version="1.0"?><w:document><w:p><w:r><w:t>Скачать документацию</w:t></w:r></w:p></w:document>',
      "word/_rels/document.xml.rels":
        '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://files.by/docs/tz.pdf" TargetMode="External"/></Relationships>',
    });
    const docxHash = createHash("sha256").update(linkDocx).digest("hex");
    const linkedBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x39]);
    const linkedHash = createHash("sha256").update(linkedBytes).digest("hex");
    const blobDirectory = await mkdtemp(path.join(os.tmpdir(), "ingest-link-"));
    tmpDirs.push(blobDirectory);
    await putBlob(blobDirectory, docxHash, linkDocx);
    await putBlob(blobDirectory, linkedHash, linkedBytes);
    const callTool = vi.fn<McpToolCaller["callTool"]>(async (toolName, args) => {
      if (toolName === "procurement.get_documents") {
        return {
          structuredContent: {
            documents: [
              {
                name: "link.docx",
                sourceUrl: "https://goszakupki.by/files/link.docx",
                downloadUrl: "https://goszakupki.by/files/link.docx?download=1",
                mimeType: "application/octet-stream",
                discoveredAt: "2026-09-05T08:00:00.000Z",
              },
            ],
          },
        };
      }
      if (toolName === "procurement.download") {
        const url = (args as { downloadUrl?: string }).downloadUrl ?? "";
        const isLink = url === "https://files.by/docs/tz.pdf";
        return {
          structuredContent: {
            hash: isLink ? linkedHash : docxHash,
            storageKey: `blobs/${isLink ? linkedHash : docxHash}`,
            sizeBytes: 1,
            contentType: isLink ? "application/pdf" : "application/octet-stream",
          },
        };
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
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
    });

    progress.begin(WS, card.id);
    const next = await port.ingest(card, WS);
    progress.done(WS, card.id);

    const linked = next.documents.find((item) => item.sourceUrl.includes("#link/"));
    expect(linked?.name).toContain("tz.pdf");
    expect(linked?.name).toContain("link.docx");
    expect(linked?.downloadUrl).toBe("https://files.by/docs/tz.pdf");
    expect(linked?.hash).toBe(linkedHash);
    expect(linked?.status).toBe("hashed");
    expect(callTool.mock.calls.map((item) => item[1])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ downloadUrl: "https://files.by/docs/tz.pdf" }),
      ]),
    );
    expect(progress.snapshot(WS, card.id).files.some((f) => f.sourceUrl.includes("#link/"))).toBe(
      true,
    );
  });

  it("marks a dead link failed without stalling the sibling document", async () => {
    const linkDocx = zipEntries({
      "word/document.xml":
        '<?xml version="1.0"?><w:document><w:p><w:r><w:t>текст</w:t></w:r></w:p></w:document>',
      "word/_rels/document.xml.rels":
        '<Relationships><Relationship Type="http://x/hyperlink" Target="https://files.by/gone.pdf"/></Relationships>',
    });
    const docxHash = createHash("sha256").update(linkDocx).digest("hex");
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const pdfHash = createHash("sha256").update(pdfBytes).digest("hex");
    const blobDirectory = await mkdtemp(path.join(os.tmpdir(), "ingest-deadlink-"));
    tmpDirs.push(blobDirectory);
    await putBlob(blobDirectory, docxHash, linkDocx);
    await putBlob(blobDirectory, pdfHash, pdfBytes);
    const callTool = vi.fn<McpToolCaller["callTool"]>(async (toolName, args) => {
      if (toolName === "procurement.get_documents") {
        return {
          structuredContent: {
            documents: [
              {
                name: "link.docx",
                sourceUrl: "https://goszakupki.by/files/link.docx",
                downloadUrl: "https://goszakupki.by/files/link.docx?download=1",
                mimeType: "application/octet-stream",
                discoveredAt: "2026-09-05T08:00:00.000Z",
              },
              {
                name: "sibling.pdf",
                sourceUrl: "https://goszakupki.by/files/sibling.pdf",
                downloadUrl: "https://goszakupki.by/files/sibling.pdf?download=1",
                mimeType: "application/octet-stream",
                discoveredAt: "2026-09-05T08:00:00.000Z",
              },
            ],
          },
        };
      }
      if (toolName === "procurement.download") {
        const url = (args as { downloadUrl?: string }).downloadUrl ?? "";
        if (url === "https://files.by/gone.pdf") throw new Error("HTTP 404");
        return {
          structuredContent: {
            hash: url.includes("sibling") ? pdfHash : docxHash,
            storageKey: `blobs/${url.includes("sibling") ? pdfHash : docxHash}`,
            sizeBytes: 1,
            contentType: "application/octet-stream",
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

    const dead = next.documents.find((item) => item.sourceUrl.includes("#link/"));
    expect(dead?.status).toBe("download_failed");
    expect(dead?.note).toContain("Не удалось скачать файл по ссылке");
    expect(
      next.documents.find((item) => item.name === "sibling.pdf")?.status,
    ).toBe("hashed");
  });

  it("never fetches a link to an internal address from document text", async () => {
    const inner = zipEntries({
      "word/document.xml":
        '<?xml version="1.0"?><w:document><w:p><w:r><w:t>Схема: http://192.168.0.5/secret.pdf</w:t></w:r></w:p></w:document>',
    });
    const docxHash = createHash("sha256").update(inner).digest("hex");
    const blobDirectory = await mkdtemp(path.join(os.tmpdir(), "ingest-ssrf-"));
    tmpDirs.push(blobDirectory);
    await putBlob(blobDirectory, docxHash, inner);
    const callTool = vi.fn<McpToolCaller["callTool"]>(async (toolName) => {
      if (toolName === "procurement.get_documents") {
        return {
          structuredContent: {
            documents: [
              {
                name: "plan.docx",
                sourceUrl: "https://goszakupki.by/files/plan.docx",
                downloadUrl: "https://goszakupki.by/files/plan.docx?download=1",
                mimeType: "application/octet-stream",
                discoveredAt: "2026-09-05T08:00:00.000Z",
              },
            ],
          },
        };
      }
      if (toolName === "procurement.download") {
        return {
          structuredContent: {
            hash: docxHash,
            storageKey: `blobs/${docxHash}`,
            sizeBytes: inner.byteLength,
            contentType: "application/octet-stream",
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

    const downloads = callTool.mock.calls
      .filter((call) => call[0] === "procurement.download")
      .map((call) => (call[1] as { downloadUrl?: string }).downloadUrl);
    expect(downloads).toEqual(["https://goszakupki.by/files/plan.docx?download=1"]);
    expect(next.documents[0]?.extraction?.notes.join(" ")).toContain("192.168.0.5");
  });

  it("does not refetch a link that is already a listed document", async () => {
    const inner = zipEntries({
      "word/document.xml":
        '<?xml version="1.0"?><w:document><w:p><w:r><w:t>см https://files.by/tz.pdf тут</w:t></w:r></w:p></w:document>',
    });
    const docxHash = createHash("sha256").update(inner).digest("hex");
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const pdfHash = createHash("sha256").update(pdfBytes).digest("hex");
    const blobDirectory = await mkdtemp(path.join(os.tmpdir(), "ingest-dedup-"));
    tmpDirs.push(blobDirectory);
    await putBlob(blobDirectory, docxHash, inner);
    await putBlob(blobDirectory, pdfHash, pdfBytes);
    const callTool = vi.fn<McpToolCaller["callTool"]>(async (toolName, args) => {
      if (toolName === "procurement.get_documents") {
        return {
          structuredContent: {
            documents: [
              {
                name: "tz.pdf",
                sourceUrl: "https://files.by/tz.pdf",
                downloadUrl: "https://files.by/tz.pdf",
                mimeType: "application/octet-stream",
                discoveredAt: "2026-09-05T08:00:00.000Z",
              },
              {
                name: "plan.docx",
                sourceUrl: "https://goszakupki.by/files/plan.docx",
                downloadUrl: "https://goszakupki.by/files/plan.docx?download=1",
                mimeType: "application/octet-stream",
                discoveredAt: "2026-09-05T08:00:00.000Z",
              },
            ],
          },
        };
      }
      if (toolName === "procurement.download") {
        const url = (args as { downloadUrl?: string }).downloadUrl ?? "";
        return {
          structuredContent: {
            hash: url.includes("plan") ? docxHash : pdfHash,
            storageKey: `blobs/${url.includes("plan") ? docxHash : pdfHash}`,
            sizeBytes: 1,
            contentType: "application/octet-stream",
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

    const downloads = callTool.mock.calls
      .filter((call) => call[0] === "procurement.download")
      .map((call) => (call[1] as { downloadUrl?: string }).downloadUrl);
    expect(downloads?.sort()).toEqual([
      "https://files.by/tz.pdf",
      "https://goszakupki.by/files/plan.docx?download=1",
    ]);
    expect(next.documents.some((item) => item.sourceUrl.includes("#link/"))).toBe(false);
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
