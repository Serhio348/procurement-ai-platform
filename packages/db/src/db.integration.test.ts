import { InboxFixtureItem, ProcedureCard, SpecialistProcurementCard } from "@procurement/contracts";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBootstrap } from "./bootstrap.js";
import { createDatabase, type Database } from "./client.js";
import { createPostgresAssistantSuggestionStore } from "./assistant-suggestion-store.js";
import { createPostgresDecisionMemoryStore } from "./decision-memory-store.js";
import { migrateDatabase } from "./migrate.js";
import { createRepositories } from "./repositories.js";
import {
  documentVersions,
  documents,
  domainProfiles,
  procurements,
  seedRuns,
  workspaceInbox,
  workspaceProcurements,
  workspaceProfiles,
} from "./schema.js";
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
    const ids = await store.listTrashIds(workspaceId);
    expect(ids).toEqual([card.id]);
    await store.removeCases(ids, workspaceId);
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

  it("resaves a butb case whose canonical row predates the source prefix", async () => {
    // Before namespaced ids were recognised, a `butb/…` card was persisted
    // under the goszakupki lane. Re-saving that card used to pin the stale
    // canonical id and crash on the primary key — outside the declared
    // (source_id, source_record_id) conflict target.
    const store = createSpecialistStore(db);
    const user = "00000000-0000-4000-8000-000000000980";
    await db.execute(sql`
      insert into auth_users (id, email, name, password_hash, role, access_status)
      values (${user}, 'legacy-butb@test.local', 'L', 'x', 'specialist', 'active')
      on conflict (email) do nothing
    `);
    const workspaceId = await store.ensurePersonalWorkspace(user, "L");
    const legacyId = "00000000-0000-4000-8000-000000000981";
    await db.execute(sql`
      insert into procurements (id, source_id, source_record_id, canonical_url, title, kind, status, stage)
      values (
        ${legacyId}, 'goszakupki_by', 'butb/AU-legacy',
        'https://zakupki.butb.by/auctions/viewinvitation.html', 'Насосы',
        'other', 'accepting_bids', 'discovered'
      )
      on conflict do nothing
    `);
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000982",
      title: "Насосы",
      status: "accepting_bids",
      statusLabel: "приём",
      url: "https://zakupki.butb.by/auctions/viewinvitation.html",
      sourceProcurementId: "butb/AU-legacy",
      live: true,
      triage: "participate",
      canonicalProcurementId: legacyId,
    });

    await store.saveCases([card], workspaceId);

    const canonical = await db
      .select({ id: procurements.id, sourceId: procurements.sourceId })
      .from(procurements)
      .where(eq(procurements.sourceRecordId, "butb/AU-legacy"));
    const butbRow = canonical.find((row) => row.sourceId === "butb");
    expect(butbRow).toBeDefined();
    // The stale lane row stays — merging it is a separate reviewed backfill,
    // not a hidden side effect of a cabinet write.
    expect(canonical.some((row) => row.id === legacyId)).toBe(true);
    const loaded = await store.loadCases(workspaceId);
    expect(loaded[0]?.canonicalProcurementId).toBe(butbRow?.id);
    const again = SpecialistProcurementCard.parse({
      ...card,
      triage: "monitor",
      canonicalProcurementId: butbRow!.id,
    });
    await store.saveCases([again], workspaceId);
    const twice = await db
      .select({ id: procurements.id })
      .from(procurements)
      .where(
        sql`${procurements.sourceId} = 'butb' and ${procurements.sourceRecordId} = 'butb/AU-legacy'`,
      );
    expect(twice).toHaveLength(1);
  });

  it("repairs a stale canonical link even when the card itself is unchanged", async () => {
    // The unchanged-card skip compares card JSON with canonicalProcurementId
    // stripped — a workspace row already pointing at the wrong-lane canonical
    // row would stay stale forever unless the skip also checks the link.
    const store = createSpecialistStore(db);
    const user = "00000000-0000-4000-8000-000000000983";
    await db.execute(sql`
      insert into auth_users (id, email, name, password_hash, role, access_status)
      values (${user}, 'stale-butb@test.local', 'S', 'x', 'specialist', 'active')
      on conflict (email) do nothing
    `);
    const workspaceId = await store.ensurePersonalWorkspace(user, "S");
    const legacyId = "00000000-0000-4000-8000-000000000984";
    await db.execute(sql`
      insert into procurements (id, source_id, source_record_id, canonical_url, title, kind, status, stage)
      values (
        ${legacyId}, 'goszakupki_by', 'butb/AU-stale',
        'https://zakupki.butb.by/auctions/viewinvitation.html', 'Шкафы',
        'other', 'accepting_bids', 'discovered'
      )
      on conflict do nothing
    `);
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000985",
      title: "Шкафы",
      status: "accepting_bids",
      statusLabel: "приём",
      url: "https://zakupki.butb.by/auctions/viewinvitation.html",
      sourceProcurementId: "butb/AU-stale",
      live: true,
      triage: "monitor",
      canonicalProcurementId: legacyId,
    });
    await store.saveCases([card], workspaceId);
    const healthy = await db
      .select({ id: procurements.id })
      .from(procurements)
      .where(
        sql`${procurements.sourceId} = 'butb' and ${procurements.sourceRecordId} = 'butb/AU-stale'`,
      );
    expect(healthy).toHaveLength(1);

    // Force the stale state the pre-fix skip would protect: the workspace
    // link and the stored card point back at the wrong-lane row while the
    // card content itself is untouched.
    const staleCard = SpecialistProcurementCard.parse({
      ...card,
      canonicalProcurementId: legacyId,
    });
    await db
      .update(workspaceProcurements)
      .set({ procurementId: legacyId, card: staleCard })
      .where(
        and(
          eq(workspaceProcurements.workspaceId, workspaceId),
          eq(workspaceProcurements.sourceProcurementId, "butb/AU-stale"),
        ),
      );

    await store.saveCases([staleCard], workspaceId);

    const relinked = await db
      .select({ procurementId: workspaceProcurements.procurementId })
      .from(workspaceProcurements)
      .where(
        and(
          eq(workspaceProcurements.workspaceId, workspaceId),
          eq(workspaceProcurements.sourceProcurementId, "butb/AU-stale"),
        ),
      );
    expect(relinked[0]?.procurementId).toBe(healthy[0]?.id);
    const loaded = await store.loadCases(workspaceId);
    expect(loaded[0]?.canonicalProcurementId).toBe(healthy[0]?.id);
    // A healed card must satisfy the skip again — the third identical save
    // is a no-op and must not create another canonical row.
    await store.saveCases([staleCard], workspaceId);
    const rows = await db
      .select({ id: procurements.id })
      .from(procurements)
      .where(eq(procurements.sourceRecordId, "butb/AU-stale"));
    expect(rows.filter((row) => row.id === healthy[0]?.id)).toHaveLength(1);
  });

  it("repairs a stale link on the saveCabinet path and keeps hashed documents reachable", async () => {
    // saveCabinet has its own unchanged-card pre-filter in front of
    // saveWorkspaceCase — a stale canonical link must break it too, and the
    // card's hashed documents must move under the resolved canonical row.
    const store = createSpecialistStore(db);
    const user = "00000000-0000-4000-8000-000000000986";
    await db.execute(sql`
      insert into auth_users (id, email, name, password_hash, role, access_status)
      values (${user}, 'cab-butb@test.local', 'C', 'x', 'specialist', 'active')
      on conflict (email) do nothing
    `);
    const workspaceId = await store.ensurePersonalWorkspace(user, "C");
    const profileId = "00000000-0000-4000-8000-000000000987";
    const legacyId = "00000000-0000-4000-8000-000000000988";
    await db.execute(sql`
      insert into procurements (id, source_id, source_record_id, canonical_url, title, kind, status, stage)
      values (
        ${legacyId}, 'goszakupki_by', 'butb/AU-cab',
        'https://zakupki.butb.by/auctions/viewinvitation.html', 'Кресла',
        'other', 'accepting_bids', 'documents_downloaded'
      )
      on conflict do nothing
    `);
    const hash = "e".repeat(64);
    const state = {
      profiles: [
        {
          id: profileId,
          name: "C",
          purpose: "",
          description: "",
          keywords: ["кресла"],
          excludeKeywords: [],
          statuses: ["accepting_bids" as const],
          excludeSingleSource: false,
          filters: {},
          watchNewProcurements: false,
        },
      ],
      activeProfileId: profileId,
      decisions: [],
      dismissedInboxIds: [],
      reviewedIrrelevant: [],
      archivedSourceIds: [],
      searchIdsByProfile: {},
      searchRuns: {},
    };
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000989",
      title: "Кресла",
      status: "accepting_bids",
      statusLabel: "приём",
      url: "https://zakupki.butb.by/auctions/viewinvitation.html",
      sourceProcurementId: "butb/AU-cab",
      live: true,
      triage: "participate",
      canonicalProcurementId: legacyId,
      documents: [
        {
          name: "tz.docx",
          sourceUrl: "https://zakupki.butb.by/auctions/download?id=42&name=tz.docx",
          hash,
          sizeBytes: 100,
          status: "hashed",
          note: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      ],
    });

    await store.saveCabinet(state, [card], [], workspaceId);
    const butbRow = (
      await db
        .select({ id: procurements.id })
        .from(procurements)
        .where(
          sql`${procurements.sourceId} = 'butb' and ${procurements.sourceRecordId} = 'butb/AU-cab'`,
        )
    )[0];
    expect(butbRow).toBeDefined();
    expect(await store.hasDocumentHash(workspaceId, hash)).toBe(true);

    // Force the full stale state: the workspace link, the stored card id
    // AND the already-written document rows all point at the wrong-lane
    // canonical row — exactly what a pre-fix persist left behind.
    const staleCard = SpecialistProcurementCard.parse({
      ...card,
      canonicalProcurementId: legacyId,
    });
    await db
      .update(workspaceProcurements)
      .set({ procurementId: legacyId, card: staleCard })
      .where(
        and(
          eq(workspaceProcurements.workspaceId, workspaceId),
          eq(workspaceProcurements.sourceProcurementId, "butb/AU-cab"),
        ),
      );
    await db
      .update(documents)
      .set({ procurementId: legacyId })
      .where(eq(documents.procurementId, butbRow!.id));

    // Identical card through the cabinet path: the skip compares equal card
    // JSON — only the link check lets the repair through.
    await store.saveCabinet(state, [staleCard], [], workspaceId);

    const relinked = await db
      .select({ procurementId: workspaceProcurements.procurementId })
      .from(workspaceProcurements)
      .where(
        and(
          eq(workspaceProcurements.workspaceId, workspaceId),
          eq(workspaceProcurements.sourceProcurementId, "butb/AU-cab"),
        ),
      );
    expect(relinked[0]?.procurementId).toBe(butbRow!.id);
    // The hashed document is re-linked under the resolved canonical row…
    const relinkedDocs = await db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.procurementId, butbRow!.id),
          eq(documents.sourceUrl, "https://zakupki.butb.by/auctions/download?id=42&name=tz.docx"),
        ),
      );
    expect(relinkedDocs).toHaveLength(1);
    const versions = await db
      .select({ hash: documentVersions.hash })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, relinkedDocs[0]!.id));
    expect(versions.map((row) => row.hash)).toContain(hash);
    // …and remains reachable through the cabinet's hash lookup.
    expect(await store.hasDocumentHash(workspaceId, hash)).toBe(true);
    expect((await store.loadCases(workspaceId))[0]?.canonicalProcurementId).toBe(butbRow!.id);
  });

  it("keeps decision memory per cabinet and past the deleted card", async () => {
    const store = createSpecialistStore(db);
    const memory = createPostgresDecisionMemoryStore(db);
    const userA = "00000000-0000-4000-8000-000000000961";
    const userB = "00000000-0000-4000-8000-000000000962";
    await db.execute(sql`
      insert into auth_users (id, email, name, password_hash, role, access_status)
      values
        (${userA}, 'a-memory@test.local', 'A', 'x', 'specialist', 'active'),
        (${userB}, 'b-memory@test.local', 'B', 'x', 'specialist', 'active')
      on conflict (email) do nothing
    `);
    const workspaceA = await store.ensurePersonalWorkspace(userA, "A");
    const workspaceB = await store.ensurePersonalWorkspace(userB, "B");
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000963",
      title: "Ремонт наружного освещения",
      status: "accepting_bids",
      statusLabel: "приём",
      url: "https://goszakupki.by/request/view/memory",
      sourceProcurementId: "request/memory",
      triage: "reject",
    });
    await store.saveCases([card], workspaceA);
    await memory.record(workspaceA, {
      sourceProcurementId: card.sourceProcurementId,
      kind: "monitor",
      profileIds: [],
      title: card.title,
      lotTitles: ["Светильники"],
      decidedAt: "2026-10-08T09:00:00.000Z",
    });
    await memory.record(workspaceA, {
      sourceProcurementId: card.sourceProcurementId,
      kind: "reject",
      profileIds: [],
      title: card.title,
      lotTitles: [],
      decidedAt: "2026-10-08T10:00:00.000Z",
    });
    await store.removeCases([card.id], workspaceA);

    const own = await memory.list(workspaceA);
    expect(own).toHaveLength(1);
    expect(own[0]?.kind).toBe("reject");
    expect(own[0]?.lotTitles).toEqual([]);
    expect(await memory.list(workspaceB)).toEqual([]);
    await memory.forget(workspaceB, card.sourceProcurementId);
    expect(await memory.list(workspaceA)).toHaveLength(1);
    await memory.forget(workspaceA, card.sourceProcurementId);
    expect(await memory.list(workspaceA)).toEqual([]);
  });

  it("offers an assistant term once per profile and closes it only in its cabinet", async () => {
    const store = createSpecialistStore(db);
    const suggestions = createPostgresAssistantSuggestionStore(db);
    const userA = "00000000-0000-4000-8000-000000000971";
    const userB = "00000000-0000-4000-8000-000000000972";
    await db.execute(sql`
      insert into auth_users (id, email, name, password_hash, role, access_status)
      values
        (${userA}, 'a-suggest@test.local', 'A', 'x', 'specialist', 'active'),
        (${userB}, 'b-suggest@test.local', 'B', 'x', 'specialist', 'active')
      on conflict (email) do nothing
    `);
    const workspaceA = await store.ensurePersonalWorkspace(userA, "A");
    const workspaceB = await store.ensurePersonalWorkspace(userB, "B");
    const offer = {
      id: "00000000-0000-4000-8000-000000000973",
      profileId: "00000000-0000-4000-8000-000000000974",
      termKey: "наруж освеще",
      label: "наружного освещения",
      phrases: [] as string[],
      rejectCount: 5,
      examples: ["Ремонт наружного освещения"],
      state: "open" as const,
      createdAt: "2026-10-08T10:00:00.000Z",
    };
    expect(await suggestions.offer(workspaceA, offer)).toBe(true);
    expect(
      await suggestions.offer(workspaceA, { ...offer, id: "00000000-0000-4000-8000-000000000975" }),
    ).toBe(false);
    expect(await suggestions.list(workspaceB)).toEqual([]);
    expect(
      await suggestions.resolve(workspaceB, offer.id, "accepted", "2026-10-08T11:00:00.000Z"),
    ).toBeUndefined();
    const dismissed = await suggestions.resolve(
      workspaceA,
      offer.id,
      "dismissed",
      "2026-10-08T11:00:00.000Z",
    );
    expect(dismissed?.state).toBe("dismissed");
    expect(
      await suggestions.resolve(workspaceA, offer.id, "accepted", "2026-10-08T12:00:00.000Z"),
    ).toBeUndefined();
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

  it("rewrites only changed rows when the cabinet is saved again (R37)", async () => {
    const store = createSpecialistStore(db);
    const userId = "00000000-0000-4000-8000-000000000950";
    await db.execute(sql`
      insert into auth_users (id, email, name, password_hash, role, access_status)
      values (${userId}, 'r37@test.local', 'R37', 'x', 'specialist', 'active')
      on conflict (email) do nothing
    `);
    const workspaceId = await store.ensurePersonalWorkspace(userId, "R37");
    const profileId = "00000000-0000-4000-8000-000000000951";
    const state = {
      profiles: [
        {
          id: profileId,
          name: "R37",
          purpose: "",
          description: "",
          keywords: ["кабель"],
          excludeKeywords: [],
          statuses: ["accepting_bids" as const],
          excludeSingleSource: false,
          filters: {},
          watchNewProcurements: false,
        },
      ],
      activeProfileId: profileId,
      decisions: [],
      dismissedInboxIds: [],
      reviewedIrrelevant: [
        {
          profileId,
          sourceProcurementId: "auction/r37-reviewed",
          decidedAt: "2026-09-09T10:00:00.000Z",
          algorithmVersion: "search-review-v2",
        },
      ],
      archivedSourceIds: [],
      searchIdsByProfile: {},
      searchRuns: {},
    };
    const card = (n: number) =>
      SpecialistProcurementCard.parse({
        id: `00000000-0000-4000-8000-00000000095${n}`,
        title: `Карточка ${n}`,
        status: "accepting_bids",
        statusLabel: "приём",
        url: `https://goszakupki.by/auction/view/r37-${n}`,
        sourceProcurementId: `auction/r37-${n}`,
        live: true,
        triage: "monitor",
      });
    const cardA = card(2);
    const cardB = card(3);
    const inboxItem = (n: number) =>
      InboxFixtureItem.parse({
        procurement: {
          title: `Карточка ${n}`,
          status: "accepting_bids",
          url: `https://goszakupki.by/auction/view/r37-${n}`,
          sourceProcurementId: `auction/r37-${n}`,
        },
        change: {
          id: `00000000-0000-4000-8000-00000000096${n}`,
          procurementId: `00000000-0000-4000-8000-00000000095${n}`,
          kind: "procedure_found",
          previous: null,
          current: `Карточка ${n}`,
          detectedAt: "2026-09-01T10:00:00.000Z",
        },
      });

    await store.saveCabinet(state, [cardA, cardB], [inboxItem(4)], workspaceId);
    const stamps = async () => {
      const inbox = await db
        .select({ key: workspaceInbox.eventKey, at: workspaceInbox.updatedAt })
        .from(workspaceInbox)
        .where(eq(workspaceInbox.workspaceId, workspaceId));
      const profiles = await db
        .select({ id: workspaceProfiles.id, at: workspaceProfiles.updatedAt })
        .from(workspaceProfiles)
        .where(eq(workspaceProfiles.workspaceId, workspaceId));
      const cases = await db
        .select({
          src: workspaceProcurements.sourceProcurementId,
          at: workspaceProcurements.updatedAt,
        })
        .from(workspaceProcurements)
        .where(eq(workspaceProcurements.workspaceId, workspaceId));
      const canonical = await db
        .select({ src: procurements.sourceRecordId, at: procurements.updatedAt })
        .from(procurements)
        .where(sql`${procurements.sourceRecordId} like 'auction/r37-%'`);
      const by = <T extends { at: unknown }, K extends keyof T>(rows: T[], key: K) =>
        new Map(rows.map((row) => [String(row[key]), String(row.at)]));
      return {
        inbox: by(inbox, "key"),
        profiles: by(profiles, "id"),
        cases: by(cases, "src"),
        canonical: by(canonical, "src"),
      };
    };
    const before = await stamps();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Same cabinet plus one new inbox row and one changed card.
    const changedB = SpecialistProcurementCard.parse({ ...cardB, title: "Изменённая" });
    await store.saveCabinet(
      state,
      [cardA, changedB],
      [inboxItem(4), inboxItem(5)],
      workspaceId,
    );
    const after = await stamps();

    // Unchanged inbox row, unchanged profile and unchanged case row were not
    // rewritten — their updated_at must be identical to the first save.
    expect(after.inbox.get("00000000-0000-4000-8000-000000000964")).toBe(
      before.inbox.get("00000000-0000-4000-8000-000000000964"),
    );
    expect(after.inbox.has("00000000-0000-4000-8000-000000000965")).toBe(true);
    expect(after.profiles.get(profileId)).toBe(before.profiles.get(profileId));
    expect(after.cases.get(cardA.sourceProcurementId)).toBe(
      before.cases.get(cardA.sourceProcurementId),
    );
    // The canonical row of an unchanged card is not re-upserted.
    expect(after.canonical.get(cardA.sourceProcurementId)).toBe(
      before.canonical.get(cardA.sourceProcurementId),
    );
    // The changed card really was written.
    expect(after.canonical.get(cardB.sourceProcurementId)).not.toBe(
      before.canonical.get(cardB.sourceProcurementId),
    );
    expect((await store.getCase(workspaceId, cardB.id))?.title).toBe("Изменённая");
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
