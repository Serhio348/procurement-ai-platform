import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SpecialistProcurementCard } from "@procurement/contracts";
import { SpecialistCatalog } from "@procurement/domain";
import { afterEach, describe, expect, it } from "vitest";
import { buildSpecialistApi } from "./app.js";
import { putBlob } from "./blobs.js";
import { loadFixtureCatalog } from "./load-fixture.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("specialist API", () => {
  it("lists seeded urgent inbox items without the non-urgent household panel", async () => {
    const app = await buildSpecialistApi({ catalog: await loadFixtureCatalog() });

    const response = await app.inject({ method: "GET", url: "/api/inbox" });
    const body = JSON.parse(response.body) as { items: Array<{ title: string }> };

    expect(response.statusCode).toBe(200);
    expect(body.items.map((item) => item.title)).toEqual([
      "Поставка КТПБ",
      "НКУ и щитовое оборудование",
    ]);

    await app.close();
  });

  it("shows a newly posted urgent change on the next inbox read", async () => {
    const app = await buildSpecialistApi({ catalog: new SpecialistCatalog() });
    const event = {
      procurement: {
        title: "Поставка КТПБ",
        status: "cancelled",
        url: "https://goszakupki.by/auction/view/001",
        sourceProcurementId: "auction/001",
      },
      change: {
        id: "00000000-0000-4000-8000-000000000201",
        procurementId: "00000000-0000-4000-8000-000000000020",
        kind: "status_changed",
        previous: "accepting_bids",
        current: "cancelled",
        detectedAt: "2026-09-03T11:00:00.000Z",
        urgent: true,
      },
    };

    const created = await app.inject({ method: "POST", url: "/api/inbox/events", payload: event });
    const listed = await app.inject({ method: "GET", url: "/api/inbox" });
    const duplicate = await app.inject({ method: "POST", url: "/api/inbox/events", payload: event });

    expect(created.statusCode).toBe(201);
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body).items).toHaveLength(1);
    expect(JSON.parse(listed.body).items[0]?.title).toBe("Поставка КТПБ");
    expect(duplicate.statusCode).toBe(200);

    await app.close();
  });

  it("lists procurement cases including a non-urgent latest change", async () => {
    const app = await buildSpecialistApi({ catalog: await loadFixtureCatalog() });

    const list = await app.inject({ method: "GET", url: "/api/procurements" });
    const card = await app.inject({
      method: "GET",
      url: "/api/procurements/00000000-0000-4000-8000-000000000022",
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/procurements/00000000-0000-4000-8000-000000000099",
    });

    const items = JSON.parse(list.body).items as Array<{ title: string }>;
    expect(items.some((item) => item.title === "Бытовой щиток")).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(card.statusCode).toBe(200);
    expect(JSON.parse(card.body).title).toBe("Бытовой щиток");
    expect(missing.statusCode).toBe(404);

    await app.close();
  });

  it("serves a catalog PDF from the local blob store, not an unknown hash on disk", async () => {
    const blobDirectory = await mkdtemp(path.join(os.tmpdir(), "blobs-"));
    tmpDirs.push(blobDirectory);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const orphan = createHash("sha256").update("orphan").digest("hex");
    const absent = "c".repeat(64);
    await putBlob(blobDirectory, hash, bytes);
    await putBlob(blobDirectory, orphan, new Uint8Array([1, 2, 3]));

    const catalog = new SpecialistCatalog();
    catalog.upsertCase(
      SpecialistProcurementCard.parse({
        id: "00000000-0000-4000-8000-000000000301",
        title: "Тест PDF",
        status: "announced",
        statusLabel: "объявлена",
        url: "https://goszakupki.by/auction/view/301",
        sourceProcurementId: "auction/301",
        documents: [
          {
            name: "Техническое задание.pdf",
            sourceUrl: "https://goszakupki.by/files/301",
            hash,
            sizeBytes: bytes.byteLength,
            status: "hashed",
          },
          {
            name: "Потерянный.pdf",
            sourceUrl: "https://goszakupki.by/files/302",
            hash: absent,
            sizeBytes: 1,
            status: "hashed",
          },
        ],
      }),
    );
    const app = await buildSpecialistApi({ catalog, blobDirectory });

    const served = await app.inject({ method: "GET", url: `/api/documents/${hash}` });
    const unknown = await app.inject({ method: "GET", url: `/api/documents/${orphan}` });
    const invalid = await app.inject({ method: "GET", url: "/api/documents/not-a-hash" });
    const missingBlob = await app.inject({ method: "GET", url: `/api/documents/${absent}` });
    const missing = await app.inject({
      method: "GET",
      url: `/api/documents/${"b".repeat(64)}`,
    });

    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("application/pdf");
    expect(served.headers["content-disposition"]).toContain("inline");
    expect(Buffer.from(served.rawPayload)).toEqual(Buffer.from(bytes));
    expect(unknown.statusCode).toBe(404);
    expect(JSON.parse(unknown.body).error).toBe("not_found");
    expect(invalid.statusCode).toBe(400);
    expect(JSON.parse(missingBlob.body).error).toBe("blob_missing");
    expect(missingBlob.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);

    await app.close();
  });
});
