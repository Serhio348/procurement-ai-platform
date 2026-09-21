import { InboxFixtureItem, ProcedureCard, SpecialistProcurementCard } from "@procurement/contracts";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBootstrap } from "./bootstrap.js";
import { createDatabase, type Database } from "./client.js";
import { migrateDatabase } from "./migrate.js";
import { createRepositories } from "./repositories.js";
import { documentVersions, domainProfiles, procurements, seedRuns } from "./schema.js";
import { blobStorageKey, createSpecialistStore } from "./specialist-store.js";

const testDatabaseUrl = process.env["TEST_DATABASE_URL"];
const integration = describe.skipIf(testDatabaseUrl === undefined);

integration("PostgreSQL migrations and invariants", () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>["pool"];

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required");
    await migrateDatabase(testDatabaseUrl);
    ({ db, pool } = createDatabase(testDatabaseUrl));
  });

  afterAll(async () => {
    await pool.end();
  });

  it("applies bootstrap once and keeps exactly one editable equipment profile", async () => {
    await applyBootstrap(db);
    const secondApplication = await applyBootstrap(db);

    const profiles = await db.select().from(domainProfiles);
    const runs = await db.select().from(seedRuns);

    expect(secondApplication).toBe(false);
    expect(profiles.filter((row) => row.slug === "electrical_equipment")).toHaveLength(1);
    expect(runs.filter((row) => row.seedId === "electrical_equipment.v1")).toHaveLength(1);
  });

  it("does not overwrite specialist edits on later bootstrap runs", async () => {
    await db
      .update(domainProfiles)
      .set({ name: "Изменённый специалистом профиль" })
      .where(eq(domainProfiles.slug, "electrical_equipment"));

    await applyBootstrap(db);
    const rows = await db
      .select({ name: domainProfiles.name })
      .from(domainProfiles)
      .where(eq(domainProfiles.slug, "electrical_equipment"));

    expect(rows[0]?.name).toBe("Изменённый специалистом профиль");
  });

  it("upserts a procurement by source and record id without duplicates", async () => {
    const repositories = createRepositories(db);
    const card = ProcedureCard.parse({
      sourceId: "integration_source",
      sourceProcurementId: "record-1",
      url: "https://example.test/procurements/record-1",
      title: "Integration test procurement",
      kind: "other" as const,
      status: "unknown" as const,
      pageFamily: "other" as const,
      externalIds: [],
      parties: [],
      lots: [],
      rawFields: {},
      fetchedAt: "2026-08-31T19:00:00.000Z",
    });

    const first = await repositories.procurements.upsertCard(card);
    const second = await repositories.procurements.upsertCard(ProcedureCard.parse({
      ...card,
      title: "Updated integration test procurement",
    }));
    const rows = await db
      .select()
      .from(procurements)
      .where(
        sql`${procurements.sourceId} = 'integration_source' and ${procurements.sourceRecordId} = 'record-1'`,
      );

    expect(second.id).toBe(first.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Updated integration test procurement");
  });

  it("rejects updates to append-only change events", async () => {
    const procurementRows = await db
      .select({ id: procurements.id })
      .from(procurements)
      .where(sql`${procurements.sourceId} = 'integration_source'`)
      .limit(1);
    const procurementId = procurementRows[0]?.id;
    if (procurementId === undefined) throw new Error("integration procurement missing");

    await db.execute(sql`
      insert into change_events
        (event_key, procurement_id, kind, previous, current, detected_at)
      values
        ('integration:event-1', ${procurementId}, 'status_changed', 'unknown', 'announced', now())
      on conflict do nothing
    `);

    await expect(
      db.execute(sql`
        update change_events
        set current = 'completed'
        where procurement_id = ${procurementId}
          and event_key = 'integration:event-1'
      `),
    ).rejects.toThrow();

    const unchanged = await db.execute<{ current: string }>(sql`
      select current
      from change_events
      where procurement_id = ${procurementId}
        and event_key = 'integration:event-1'
    `);
    expect(unchanged.rows[0]?.current).toBe("announced");
  });

  it("stores specialist cases and document hashes without file bytes", async () => {
    const store = createSpecialistStore(db);
    const hash = "b".repeat(64);
    const userId = "00000000-0000-4000-8000-000000000910";
    await db.execute(sql`
      insert into auth_users (id, email, name, password_hash, role, access_status)
      values (${userId}, 'persist@test.local', 'Persist', 'x', 'specialist', 'active')
      on conflict (email) do nothing
    `);
    const workspaceId = await store.ensurePersonalWorkspace(userId, "Persist");
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000901",
      title: "Кабель для persist",
      status: "unknown",
      statusLabel: "неизвестен",
      url: "https://goszakupki.by/auction/view/901",
      sourceProcurementId: "auction/901-persist",
      live: true,
      documents: [
        {
          name: "ТЗ.pdf",
          sourceUrl: "https://goszakupki.by/files/901",
          hash,
          sizeBytes: 12,
          status: "hashed",
          note: "application/pdf",
        },
      ],
    });

    await store.saveWorkspace({
      profiles: [
        {
          id: "00000000-0000-4000-8000-000000000902",
          name: "Persist",
          purpose: "",
          description: "",
          keywords: ["кабель"],
          excludeKeywords: [],
          statuses: ["accepting_bids"],
          excludeSingleSource: false,
          filters: {},
          watchNewProcurements: false,
          lastDiscoveryAt: "2026-09-09T10:00:00.000Z",
        },
      ],
      activeProfileId: "00000000-0000-4000-8000-000000000902",
      decisions: [],
      dismissedInboxIds: [],
      reviewedIrrelevant: [
        {
          profileId: "00000000-0000-4000-8000-000000000902",
          sourceProcurementId: "auction/review-cache",
          decidedAt: "2026-09-09T10:00:00.000Z",
          algorithmVersion: "search-review-v2",
        },
      ],
      archivedSourceIds: [],
      searchIdsByProfile: {},
      searchRuns: {},
    }, workspaceId);
    await store.saveCases([card], workspaceId);
    await store.saveInbox([
      InboxFixtureItem.parse({
        procurement: {
          title: card.title,
          status: card.status,
          url: card.url,
          sourceProcurementId: card.sourceProcurementId,
        },
        change: {
          id: "00000000-0000-4000-8000-000000000903",
          procurementId: card.id,
          kind: "procedure_found",
          previous: null,
          current: card.title,
          detectedAt: "2026-09-01T10:00:00.000Z",
          urgent: true,
        },
      }),
    ], workspaceId);

    const loadedWorkspace = await store.loadWorkspace(workspaceId);
    const loadedCases = await store.loadCases(workspaceId);
    const loadedInbox = await store.loadInbox(workspaceId);
    const listed = await store.listCases(workspaceId, { tab: "listed", limit: 10 });
    const mine = await store.listCases(workspaceId, { tab: "all" });
    const byId = await store.getCase(workspaceId, card.id);
    await store.removeCases([card.id], workspaceId);
    const inboxAfterRemove = await store.loadInbox(workspaceId);
    const versions = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.hash, hash));

    expect(loadedWorkspace?.profiles[0]?.name).toBe("Persist");
    expect(loadedWorkspace?.profiles[0]?.lastDiscoveryAt).toBe("2026-09-09T10:00:00.000Z");
    expect(loadedWorkspace?.reviewedIrrelevant[0]?.algorithmVersion).toBe("search-review-v2");
    expect(loadedCases.map((item) => item.sourceProcurementId)).toContain("auction/901-persist");
    expect(listed.items.some((item) => item.id === card.id)).toBe(true);
    expect(mine.items.some((item) => item.id === card.id)).toBe(false);
    // A tile page must not carry the TOASTed parts of the card.
    expect(listed.items.find((item) => item.id === card.id)?.documents).toEqual([]);
    expect(byId?.documents.map((item) => item.name)).toEqual(["ТЗ.pdf"]);
    expect(byId?.sourceProcurementId).toBe(card.sourceProcurementId);
    expect(versions[0]?.hash).toBe(hash);
    expect(versions[0]?.storageKey).toBe(blobStorageKey(hash));
    expect(loadedInbox.map((item) => item.change.id)).toContain(
      "00000000-0000-4000-8000-000000000903",
    );
    // Removing the case takes its inbox row with it: the inbox never points
    // at a card that no longer exists.
    expect(inboxAfterRemove.some((item) => item.change.procurementId === card.id)).toBe(false);
  });

  it("deletes a rejected case that still has profile links so trash cannot return after reload", async () => {
    const store = createSpecialistStore(db);
    const userId = "00000000-0000-4000-8000-000000000913";
    await db.execute(sql`
      insert into auth_users (id, email, name, password_hash, role, access_status)
      values (${userId}, 'purge-rls@test.local', 'Purge', 'x', 'specialist', 'active')
      on conflict (email) do nothing
    `);
    const workspaceId = await store.ensurePersonalWorkspace(userId, "Purge");
    const profileId = (await store.loadWorkspace(workspaceId))?.profiles[0]?.id;
    if (profileId === undefined) throw new Error("workspace profile missing");
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000923",
      title: "Кабель удалить из корзины",
      status: "accepting_bids",
      statusLabel: "приём",
      url: "https://goszakupki.by/auction/view/purge-rls",
      sourceProcurementId: "auction/purge-rls",
      live: true,
      triage: "reject",
      profileIds: [profileId],
    });
    await store.saveCases([card], workspaceId);
    expect((await store.listCases(workspaceId, { tab: "trash" })).items.map((item) => item.id)).toEqual([
      card.id,
    ]);
    await store.removeCases([card.id], workspaceId);
    expect((await store.listCases(workspaceId, { tab: "trash" })).items).toEqual([]);
    expect(await store.getCase(workspaceId, card.id)).toBeUndefined();
  });

  it("keeps two users' cases isolated while sharing one canonical procurement", async () => {
    const store = createSpecialistStore(db);
    const userA = "00000000-0000-4000-8000-000000000911";
    const userB = "00000000-0000-4000-8000-000000000912";
    await db.execute(sql`
      insert into auth_users (id, email, name, password_hash, role, access_status)
      values
        (${userA}, 'a-iso@test.local', 'A', 'x', 'specialist', 'active'),
        (${userB}, 'b-iso@test.local', 'B', 'x', 'specialist', 'active')
      on conflict (email) do nothing
    `);
    const workspaceA = await store.ensurePersonalWorkspace(userA, "A");
    const workspaceB = await store.ensurePersonalWorkspace(userB, "B");
    const source = "auction/iso-shared";
    const cardA = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000921",
      title: "Общая закупка",
      status: "accepting_bids",
      statusLabel: "приём",
      url: "https://goszakupki.by/auction/view/iso",
      sourceProcurementId: source,
      live: true,
      triage: "monitor",
    });
    const cardB = SpecialistProcurementCard.parse({
      ...cardA,
      id: "00000000-0000-4000-8000-000000000922",
      triage: "participate",
    });
    await store.saveCases([cardA], workspaceA);
    await store.saveCases([cardB], workspaceB);
    const loadedA = await store.loadCases(workspaceA);
    const loadedB = await store.loadCases(workspaceB);
    const canonical = await db
      .select({ id: procurements.id })
      .from(procurements)
      .where(sql`${procurements.sourceRecordId} = ${source}`);

    expect(canonical).toHaveLength(1);
    const mineA = await store.listCases(workspaceA, { tab: "all" });
    const mineB = await store.listCases(workspaceB, { tab: "participate" });
    const counts = await store.summarizeCabinets([workspaceA, workspaceB]);
    expect(loadedA[0]?.triage).toBe("monitor");
    expect(loadedB[0]?.triage).toBe("participate");
    expect(mineA.items.map((item) => item.id)).toEqual([cardA.id]);
    expect(mineB.items.map((item) => item.id)).toEqual([cardB.id]);
    expect(counts.get(workspaceA)).toEqual({
      profileCount: 1,
      mineCount: 1,
      archiveCount: 0,
      trashCount: 0,
    });
    expect(counts.get(workspaceB)?.mineCount).toBe(1);
    expect((await store.findCaseBySource(workspaceA, source))?.triage).toBe("monitor");
    expect(loadedA[0]?.id).not.toBe(loadedB[0]?.id);
    expect(loadedA[0]?.canonicalProcurementId).toBe(canonical[0]?.id);
    expect(loadedB[0]?.canonicalProcurementId).toBe(canonical[0]?.id);
    expect(await store.hasDocumentHash(workspaceB, "c".repeat(64))).toBe(false);
  });

  it("lets two cabinets persist the same listing card UUID", async () => {
    const store = createSpecialistStore(db);
    const userA = "00000000-0000-4000-8000-000000000931";
    const userB = "00000000-0000-4000-8000-000000000932";
    await db.execute(sql`
      insert into auth_users (id, email, name, password_hash, role, access_status)
      values
        (${userA}, 'a-pk@test.local', 'A', 'x', 'specialist', 'active'),
        (${userB}, 'b-pk@test.local', 'B', 'x', 'specialist', 'active')
      on conflict (email) do nothing
    `);
    const workspaceA = await store.ensurePersonalWorkspace(userA, "A");
    const workspaceB = await store.ensurePersonalWorkspace(userB, "B");
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000941",
      title: "Одинаковый UUID карточки",
      status: "accepting_bids",
      statusLabel: "приём",
      url: "https://goszakupki.by/auction/view/3651756",
      sourceProcurementId: "auction/3651756",
      live: true,
      foundAs: "review",
    });
    await store.saveCases([card], workspaceA);
    await store.saveCases([{ ...card, foundAs: "match" }], workspaceB);
    const loadedA = await store.getCase(workspaceA, card.id);
    const loadedB = await store.getCase(workspaceB, card.id);
    await store.removeCases([card.id], workspaceA);
    expect(loadedA?.foundAs).toBe("review");
    expect(loadedB?.foundAs).toBe("match");
    expect(await store.getCase(workspaceA, card.id)).toBeUndefined();
    expect((await store.getCase(workspaceB, card.id))?.foundAs).toBe("match");
  });

  it("rejects a fact that is committed without evidence", async () => {
    const procurementRows = await db
      .select({ id: procurements.id })
      .from(procurements)
      .where(sql`${procurements.sourceId} = 'integration_source'`)
      .limit(1);
    const procurementId = procurementRows[0]?.id;
    if (procurementId === undefined) throw new Error("integration procurement missing");

    await expect(
      db.execute(sql`
        insert into facts
          (procurement_id, key, value, confidence, extracted_by, extracted_at)
        values
          (${procurementId}, 'commercial.advance_percent', '30'::jsonb, 0.9, 'integration', now())
      `),
    ).rejects.toThrow();
  });
});
