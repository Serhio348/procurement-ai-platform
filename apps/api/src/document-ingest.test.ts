import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RequestId, SourceId, SpecialistProcurementCard } from "@procurement/contracts";
import type { McpToolCaller } from "@procurement/mcp-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { putBlob } from "./blobs.js";
import { createProcurementDocumentIngest } from "./document-ingest.js";
import { createIngestProgressHub } from "./ingest-progress.js";

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

    progress.begin(card.id);
    const next = await port.ingest(card);
    progress.done(card.id);

    expect(next.documents[0]?.status).toBe("hashed");
    expect(next.documents[0]?.hash).toBe(hash);
    expect(progress.snapshot(card.id).phase).toBe("done");
    expect(progress.snapshot(card.id).files[0]?.state).toMatch(/read|skipped/);
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

    const next = await port.ingest(card);

    expect(next.documents[0]?.status).toBe("download_failed");
    expect(next.documents[0]?.note).toMatch(/не найден в хранилище/);
  });
});
