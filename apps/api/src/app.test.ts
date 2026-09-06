import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SearchHit,
  SpecialistProcurementCard,
  electricalEquipmentSeedV1,
} from "@procurement/contracts";
import { SpecialistCatalog } from "@procurement/domain";
import { McpToolCallError } from "@procurement/mcp-client";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("does not seed fixture stubs or the captured dump when only live cases are listed", async () => {
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      liveProcurementsOnly: true,
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/3629820",
            url: "https://goszakupki.by/auction/view/3629820",
            title: "2БКТПБ 400кВА-10/0,4 кВ",
          }),
        ],
      },
    });

    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "КТПБ", keywords: ["2БКТПБ"] },
    });
    const inbox = await app.inject({ method: "GET", url: "/api/inbox" });
    const before = await app.inject({ method: "GET", url: "/api/procurements" });
    const searched = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: { limit: 5 },
    });
    const items = JSON.parse(searched.body).items as Array<{
      title: string;
      live?: boolean;
      sourceProcurementId: string;
    }>;

    expect(JSON.parse(inbox.body).items).toEqual([]);
    expect(JSON.parse(before.body).items).toEqual([]);
    expect(searched.statusCode).toBe(200);
    expect(items).toEqual([
      expect.objectContaining({
        live: true,
        sourceProcurementId: "auction/3629820",
        title: "2БКТПБ 400кВА-10/0,4 кВ",
      }),
    ]);
    expect(items.some((item) => item.title === "Бытовой щиток")).toBe(false);

    await app.close();
  });

  it("persists found cases after search so a restart can reload them", async () => {
    const persistCases = vi.fn(async () => undefined);
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      persistCases,
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/persist-1",
            url: "https://goszakupki.by/auction/view/persist-1",
            title: "Кабель силовой",
          }),
        ],
      },
    });

    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"] },
    });
    const searched = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: { limit: 5 },
    });

    expect(searched.statusCode).toBe(200);
    expect(persistCases).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ sourceProcurementId: "auction/persist-1" }),
      ]),
    );

    await app.close();
  });

  it("returns delivery and warranty from the live Word TZ and does not treat 99.5% cap as advance", async () => {
    const app = await buildSpecialistApi({ catalog: await loadFixtureCatalog() });
    const list = await app.inject({ method: "GET", url: "/api/procurements" });
    const items = JSON.parse(list.body).items as Array<{
      id: string;
      sourceProcurementId: string;
    }>;
    const live = items.find((item) => item.sourceProcurementId === "auction/3629820");
    expect(live).toBeDefined();
    const card = await app.inject({ method: "GET", url: `/api/procurements/${live?.id ?? ""}` });
    const body = JSON.parse(card.body) as { termsDetail?: string; paymentQuote?: string };

    expect(card.statusCode).toBe(200);
    expect(body.termsDetail).toContain("Аванс: до 99,5%.");
    expect(body.termsDetail).toContain("Гарантия: 60 мес.");
    expect(body.termsDetail ?? "").not.toMatch(/Аванс:\s*99,5%\./);
    expect(body.paymentQuote).toContain("предоплата до 99,5");
    expect(body.paymentQuote ?? "").not.toMatch(/_/);

    await app.close();
  });

  it("searches by the saved profile and ignores keywords in the request body", async () => {
    const app = await buildSpecialistApi({ catalog: await loadFixtureCatalog() });
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: {
        name: "Электротехническое оборудование",
        keywords: electricalEquipmentSeedV1.keywords,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: { keywords: ["кабель"], limit: 20 },
    });
    const body = JSON.parse(response.body) as {
      profileName: string;
      relevantCount: number;
      discardedCount: number;
      items: Array<{ title: string; sourceProcurementId: string }>;
    };

    expect(response.statusCode).toBe(200);
    expect(body.profileName).toBe("Электротехническое оборудование");
    expect(body.relevantCount).toBe(1);
    expect(body.discardedCount).toBe(3);
    expect(body.items.some((item) => item.title === "Комплектная трансформаторная подстанция")).toBe(
      true,
    );
    expect(body.items.some((item) => item.title === "Кабель силовой")).toBe(false);
    expect(body.items.some((item) => item.title === "Трансформаторы силовые")).toBe(false);
    expect(body.items.some((item) => item.title === "Ремонт трансформаторной подстанции")).toBe(
      false,
    );

    const listed = await app.inject({ method: "GET", url: "/api/procurements" });
    const titles = (JSON.parse(listed.body).items as Array<{ title: string }>).map(
      (item) => item.title,
    );
    expect(titles).toContain("Комплектная трансформаторная подстанция");
    expect(titles).toContain("Бытовой щиток");

    const invalid = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: { limit: 0 },
    });
    expect(invalid.statusCode).toBe(400);

    await app.close();
  });

  it("searches with saved profile keywords and does not re-list a rejected procedure", async () => {
    const app = await buildSpecialistApi({ catalog: new SpecialistCatalog() });

    const saved = await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"], excludeKeywords: [] },
    });
    const watchOff = await app.inject({ method: "GET", url: "/api/profile" });
    const searched = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: { limit: 20 },
    });
    const found = JSON.parse(searched.body).items as Array<{
      id: string;
      title: string;
      sourceProcurementId: string;
    }>;
    const cable = found.find((item) => item.title === "Кабель силовой");
    const rejected = await app.inject({
      method: "POST",
      url: `/api/procurements/${cable?.id ?? ""}/decision`,
      payload: { kind: "reject" },
    });
    const afterReject = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: { limit: 20 },
    });
    const remaining = JSON.parse(afterReject.body).items as Array<{ title: string }>;

    expect(saved.statusCode).toBe(200);
    expect(JSON.parse(watchOff.body).watchNewProcurements).toBe(false);
    expect(JSON.parse(watchOff.body).keywords).toEqual(["кабель"]);
    expect(JSON.parse(saved.body).keywords).toEqual(["кабель"]);
    expect(searched.statusCode).toBe(200);
    expect(found.some((item) => item.title === "Комплектная трансформаторная подстанция")).toBe(
      false,
    );
    expect(cable).toBeDefined();
    expect(rejected.statusCode).toBe(200);
    expect(remaining.some((item) => item.title === "Кабель силовой")).toBe(false);

    await app.close();
  });

  it("ingests documents only after participate, not after monitor", async () => {
    const found = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/401",
      sourceProcurementId: "auction/401",
      live: true,
    });
    const catalog = new SpecialistCatalog();
    catalog.upsertCase(found);
    const ingest = vi.fn(async (card: typeof found) =>
      SpecialistProcurementCard.parse({
        ...card,
        documents: [
          {
            name: "ТЗ.pdf",
            sourceUrl: "https://goszakupki.by/files/401",
            hash: "a".repeat(64),
            sizeBytes: 12,
            status: "hashed",
          },
        ],
        actions: [
          ...card.actions,
          {
            step: 2,
            actor: "DocumentAgent",
            status: "done",
            detail: "procurement.get_documents: 1 файл(ов), скачано: 1, ошибок: 0, разобрано: 0.",
          },
        ],
      }),
    );
    const app = await buildSpecialistApi({
      catalog,
      documentIngest: { ingest },
    });

    const monitored = await app.inject({
      method: "POST",
      url: `/api/procurements/${found.id}/decision`,
      payload: { kind: "monitor" },
    });
    const participated = await app.inject({
      method: "POST",
      url: `/api/procurements/${found.id}/decision`,
      payload: { kind: "participate" },
    });
    const items = JSON.parse(participated.body).items as Array<{
      documents: Array<{ name: string; status: string }>;
    }>;

    expect(monitored.statusCode).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(participated.statusCode).toBe(200);
    expect(items[0]?.documents).toEqual([
      expect.objectContaining({ name: "ТЗ.pdf", status: "hashed" }),
    ]);

    await app.close();
  });

  it("exposes ingest progress while participate is still running", async () => {
    const found = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/401",
      sourceProcurementId: "auction/401",
      live: true,
    });
    const catalog = new SpecialistCatalog();
    catalog.upsertCase(found);
    const holder: { app?: Awaited<ReturnType<typeof buildSpecialistApi>> } = {};
    const ingest = vi.fn(async (card: typeof found) => {
      const mid = await holder.app?.inject({
        method: "GET",
        url: `/api/procurements/${found.id}/ingest-progress`,
      });
      expect(mid?.statusCode).toBe(200);
      expect(JSON.parse(mid?.body ?? "{}").phase).toBe("listing");
      return card;
    });
    const app = await buildSpecialistApi({
      catalog,
      documentIngest: { ingest },
    });
    holder.app = app;

    const idle = await app.inject({
      method: "GET",
      url: `/api/procurements/${found.id}/ingest-progress`,
    });
    const participated = await app.inject({
      method: "POST",
      url: `/api/procurements/${found.id}/decision`,
      payload: { kind: "participate" },
    });
    const done = await app.inject({
      method: "GET",
      url: `/api/procurements/${found.id}/ingest-progress`,
    });

    expect(JSON.parse(idle.body).phase).toBe("idle");
    expect(participated.statusCode).toBe(200);
    expect(JSON.parse(done.body).phase).toBe("done");
    expect(JSON.parse(done.body).percent).toBe(100);

    await app.close();
  });

  it("starts with an empty profile and can add a second empty direction", async () => {
    const app = await buildSpecialistApi({ catalog: new SpecialistCatalog() });

    const first = await app.inject({ method: "GET", url: "/api/profile" });
    const created = await app.inject({ method: "POST", url: "/api/profiles" });
    const listed = await app.inject({ method: "GET", url: "/api/profiles" });
    const body = JSON.parse(listed.body) as {
      items: Array<{ id: string; name: string; keywords: string[] }>;
      activeProfileId: string;
    };

    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body).name).toBe("");
    expect(JSON.parse(first.body).keywords).toEqual([]);
    expect(created.statusCode).toBe(200);
    expect(JSON.parse(created.body).keywords).toEqual([]);
    expect(body.items).toHaveLength(2);
    expect(body.activeProfileId).toBe(JSON.parse(created.body).id);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/profiles/${JSON.parse(created.body).id}`,
    });
    const afterRemove = JSON.parse(removed.body) as {
      items: Array<{ id: string }>;
      activeProfileId: string;
    };
    const last = await app.inject({
      method: "DELETE",
      url: `/api/profiles/${afterRemove.activeProfileId}`,
    });

    expect(removed.statusCode).toBe(200);
    expect(afterRemove.items).toHaveLength(1);
    expect(afterRemove.activeProfileId).toBe(JSON.parse(first.body).id);
    expect(last.statusCode).toBe(409);

    await app.close();
  });

  it("keeps edited platform keywords and fills them from looking-for when empty", async () => {
    const app = await buildSpecialistApi({ catalog: new SpecialistCatalog() });

    const edited = await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: {
        name: "Кабель",
        description: "кабель силовой",
        keywords: ["кабель"],
        excludeKeywords: [],
      },
    });
    const derived = await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: {
        name: "Кабель",
        description: "кабель",
        keywords: [],
        excludeKeywords: [],
      },
    });

    expect(edited.statusCode).toBe(200);
    expect(JSON.parse(edited.body).keywords).toEqual(["кабель"]);
    expect(derived.statusCode).toBe(200);
    expect(JSON.parse(derived.body).keywords).toEqual(["кабель"]);

    await app.close();
  });

  it("does not discover new procurements until watch is turned on and then skips judged ids", async () => {
    const app = await buildSpecialistApi({ catalog: new SpecialistCatalog() });

    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: {
        name: "Электротехническое оборудование",
        keywords: electricalEquipmentSeedV1.keywords,
      },
    });
    const idle = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const enabled = await app.inject({
      method: "POST",
      url: "/api/profile/watch",
      payload: { watchNewProcurements: true },
    });
    const first = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });
    const items = JSON.parse(first.body).items as Array<{ id: string; title: string }>;
    const substation = items.find((item) => item.title === "Комплектная трансформаторная подстанция");
    const decided = await app.inject({
      method: "POST",
      url: `/api/procurements/${substation?.id ?? ""}/decision`,
      payload: { kind: "monitor" },
    });
    const second = await app.inject({ method: "POST", url: "/api/profile/discovery", payload: {} });

    expect(idle.statusCode).toBe(200);
    expect(JSON.parse(idle.body).ran).toBe(false);
    expect(JSON.parse(idle.body).reason).toBe("watch_off");
    expect(JSON.parse(idle.body).items).toEqual([]);
    expect(enabled.statusCode).toBe(200);
    expect(JSON.parse(enabled.body).watchNewProcurements).toBe(true);
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body).ran).toBe(true);
    expect(JSON.parse(first.body).addedCount).toBeGreaterThanOrEqual(1);
    expect(substation).toBeDefined();
    expect(decided.statusCode).toBe(200);
    expect(JSON.parse(second.body).ran).toBe(true);
    expect(JSON.parse(second.body).addedCount).toBe(0);
    expect(JSON.parse(second.body).skippedDecidedCount).toBeGreaterThanOrEqual(1);

    await app.close();
  });

  it("maps a blocked live source to 503 without inventing search hits", async () => {
    const app = await buildSpecialistApi({
      catalog: new SpecialistCatalog(),
      searchHits: {
        search: async () => {
          throw new McpToolCallError(
            "source_unavailable",
            "procurement.search",
            "Source is blocked",
          );
        },
      },
    });

    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "Кабель", keywords: ["кабель"] },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      payload: {},
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).error).toBe("source_unavailable");
    const listed = await app.inject({ method: "GET", url: "/api/procurements" });
    expect(JSON.parse(listed.body).items).toEqual([]);

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
