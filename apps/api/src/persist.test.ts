import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SpecialistCatalog, SpecialistWorkspace, inboxItemFromFoundCard } from "@procurement/domain";
import { authUsers, migrateDatabase } from "@procurement/db";
import { eq } from "drizzle-orm";
import { buildSpecialistApi } from "./app.js";
import { SearchHit, SpecialistProcurementCard } from "@procurement/contracts";
import { silentLogger } from "@procurement/observability";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_WORKSPACE_ID } from "./cabinets.js";
import { openSpecialistPersistence } from "./persist.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

describe.skipIf(process.env["TEST_DATABASE_URL"] === undefined)("PostgreSQL trash persistence", () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])(
    "does not resurrect emptied trash after another save and restart (cold=%s, bulk=%s)",
    async (cold, bulk) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "trash-postgres-"));
    tmpDirs.push(directory);
    const databaseUrl = process.env["TEST_DATABASE_URL"]!;
    await migrateDatabase(databaseUrl);
    const options = { workspacePath: path.join(directory, "workspace.json"), databaseUrl, logger: silentLogger };
    let persistence = await openSpecialistPersistence(options);
    let app: Awaited<ReturnType<typeof buildSpecialistApi>> | undefined;
    try {
      const email = `trash-${crypto.randomUUID()}@test.local`;
      const password = "trash-regression-password";
      const user = await persistence.authDirectory.signUp({ email, password, name: "Trash regression" });
      await persistence.db!.update(authUsers)
        .set({ role: "specialist", accessStatus: "active" })
        .where(eq(authUsers.id, user.id));
      const workspaceId = await persistence.cabinets.ensurePersonalWorkspace(user.id);
      const cabinet = await persistence.cabinets.open(workspaceId);
      const profileId = cabinet.workspace.profile().id;
      cabinet.workspace.replaceProfile({ ...cabinet.workspace.profile(), name: "Кабель", keywords: ["кабель"] });
      cabinet.workspace.setWatch(true);
      const cards = ["reject", "reject", "monitor"].map((triage, index) => SpecialistProcurementCard.parse({
        id: crypto.randomUUID(),
        title: `Кабель ${index}`,
        status: "accepting_bids",
        statusLabel: "Приём предложений",
        url: `https://goszakupki.by/auction/view/trash-${index}`,
        sourceProcurementId: `auction/trash-${workspaceId}-${index}`,
        triage,
        live: true,
        profileIds: [profileId],
      }));
      for (const card of cards) {
        cabinet.catalog.upsertCase(card);
        cabinet.workspace.recordDecision(card.sourceProcurementId, card.triage!, "2026-09-20T10:00:00.000Z");
        if (card.triage === "reject") {
          cabinet.catalog.record(inboxItemFromFoundCard(card, "2026-09-19T10:00:00.000Z"));
          cabinet.workspace.appendSearchId(profileId, card.id);
        }
      }
      await persistence.cabinets.persist(cabinet);
      const otherUser = await persistence.authDirectory.signUp({
        email: `other-${crypto.randomUUID()}@test.local`, password, name: "Other cabinet",
      });
      const otherWorkspaceId = await persistence.cabinets.ensurePersonalWorkspace(otherUser.id);
      const otherCabinet = await persistence.cabinets.open(otherWorkspaceId);
      for (const card of cards.filter((item) => item.triage === "reject")) {
        otherCabinet.catalog.upsertCase({ ...card, profileIds: [otherCabinet.workspace.profile().id] });
      }
      await persistence.cabinets.persist(otherCabinet);
      const openApi = () => buildSpecialistApi({
        cabinets: persistence.cabinets,
        authDirectory: persistence.authDirectory,
        searchHits: { search: async () => cards.map((card) => SearchHit.parse({ ...card, sourceId: "goszakupki_by" })) },
      });
      if (cold) {
        await persistence.close();
        persistence = await openSpecialistPersistence(options);
      }
      app = await openApi();
      const signed = await app.inject({ method: "POST", url: "/api/auth/sign-in", payload: { email, password } });
      expect(signed.statusCode).toBe(200);
      const rawCookie = signed.headers["set-cookie"];
      const cookie = (Array.isArray(rawCookie) ? rawCookie[0] : rawCookie)?.split(";")[0] ?? "";
      const headers = { cookie };
      const targets = bulk ? ["trash"] : cards.filter((card) => card.triage === "reject").map((card) => card.id);
      for (const target of targets) {
        const emptied = await app.inject({ method: "DELETE", url: `/api/procurements/${target}`, headers });
        expect(emptied.statusCode).toBe(204);
      }
      expect((await persistence.cabinets.listCases(workspaceId, { tab: "trash" })).items).toEqual([]);
      const current = await persistence.cabinets.open(workspaceId);
      await persistence.cabinets.persist(current);
      expect((await persistence.cabinets.listCases(workspaceId, { tab: "trash" })).items).toEqual([]);
      expect(current.catalog.urgentInbox()).toEqual([]);
      expect(current.workspace.searchIds(profileId)).toEqual([]);
      await app.close();
      app = undefined;
      await persistence.close();
      persistence = await openSpecialistPersistence(options);
      const reopened = await persistence.cabinets.open(workspaceId);
      expect((await persistence.cabinets.listCases(workspaceId, { tab: "trash" })).items).toEqual([]);
      expect(reopened.catalog.urgentInbox()).toEqual([]);
      expect(reopened.workspace.rejectedSourceIds().size).toBe(2);
      expect((await persistence.cabinets.listCases(workspaceId, { tab: "monitor" })).items.map((card) => card.id)).toEqual([cards[2]!.id]);
      app = await openApi();
      const discovery = await app.inject({ method: "POST", url: "/api/profile/discovery", headers, payload: {} });
      expect(discovery.statusCode).toBe(200);
      expect(discovery.json().skippedDecidedCount).toBe(3);
      const manual = await app.inject({ method: "POST", url: "/api/procurements/search", headers, payload: { profileId } });
      expect(manual.statusCode).toBe(200);
      expect(manual.json().items).toEqual([]);
      expect((await persistence.cabinets.listCases(workspaceId, { tab: "trash" })).items).toEqual([]);
      expect((await app.inject({ method: "GET", url: "/api/inbox", headers })).json().items).toEqual([]);
      expect((await persistence.cabinets.listCases(otherWorkspaceId, { tab: "trash" })).items.map((card) => card.id).sort())
        .toEqual(cards.filter((card) => card.triage === "reject").map((card) => card.id).sort());
    } finally {
      await app?.close();
      await persistence.close();
    }
    },
    // Real PostgreSQL round-trips under parallel suite load outgrow the 15s default.
    60_000,
  );
});

describe("openSpecialistPersistence", () => {
  it("keeps the workspace on disk when DATABASE_URL is absent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "workspace-"));
    tmpDirs.push(directory);
    const workspacePath = path.join(directory, "specialist-workspace.json");
    const persistence = await openSpecialistPersistence({
      workspacePath,
      databaseUrl: undefined,
      logger: silentLogger,
    });
    const workspace = new SpecialistWorkspace();
    workspace.replaceProfile({
      name: "Кабель",
      purpose: "",
      description: "кабель",
      keywords: ["кабель"],
      excludeKeywords: [],
      statuses: ["accepting_bids"],
      excludeSingleSource: false,
      filters: {},
    });

    await persistence.persistWorkspace(workspace.snapshot());
    await persistence.persistCases([]);
    const catalog = new SpecialistCatalog();
    await persistence.hydrateCatalog(catalog);
    const saved = JSON.parse(await readFile(workspacePath, "utf8")) as {
      profiles: Array<{ name: string }>;
    };

    expect(persistence.postgres).toBe(false);
    expect(catalog.procurements()).toEqual([]);
    expect(saved.profiles[0]?.name).toBe("Кабель");

    await persistence.close();
  });

  it("restores the search queue after a disk restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "workspace-"));
    tmpDirs.push(directory);
    const workspacePath = path.join(directory, "specialist-workspace.json");
    const persistence = await openSpecialistPersistence({
      workspacePath,
      databaseUrl: undefined,
      logger: silentLogger,
    });
    const workspace = new SpecialistWorkspace();
    workspace.replaceSearchIds(workspace.profile().id, [
      "00000000-0000-4000-8000-000000000701",
    ]);
    await persistence.persistWorkspace(workspace.snapshot());
    await persistence.close();

    const saved = JSON.parse(await readFile(workspacePath, "utf8")) as {
      searchIdsByProfile: Record<string, string[]>;
    };
    expect(saved.searchIdsByProfile).toEqual({
      [workspace.profile().id]: ["00000000-0000-4000-8000-000000000701"],
    });

    const restarted = await openSpecialistPersistence({
      workspacePath,
      databaseUrl: undefined,
      logger: silentLogger,
    });
    const cabinet = await restarted.cabinets.open(TEST_WORKSPACE_ID);
    expect(cabinet.workspace.searchIds(cabinet.workspace.profile().id)).toEqual([
      "00000000-0000-4000-8000-000000000701",
    ]);
    await restarted.close();
  });

  it("refuses to start on a configured but unreachable DATABASE_URL", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "workspace-"));
    tmpDirs.push(directory);
    const workspacePath = path.join(directory, "specialist-workspace.json");
    // Port 1 is closed: a configured PostgreSQL is required, file fallback
    // would silently serve a different cabinet (R20).
    await expect(
      openSpecialistPersistence({
        workspacePath,
        databaseUrl: "postgres://127.0.0.1:1/procurement",
        logger: silentLogger,
      }),
    ).rejects.toThrow(/PostgreSQL недоступен/);
  });

  it("ignores a crashed temp write and still loads the last whole snapshot", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "workspace-"));
    tmpDirs.push(directory);
    const workspacePath = path.join(directory, "specialist-workspace.json");
    const persistence = await openSpecialistPersistence({
      workspacePath,
      databaseUrl: undefined,
      logger: silentLogger,
    });
    const workspace = new SpecialistWorkspace();
    workspace.replaceProfile({
      name: "Кабель",
      purpose: "",
      description: "кабель",
      keywords: ["кабель"],
      excludeKeywords: [],
      statuses: ["accepting_bids"],
      excludeSingleSource: false,
      filters: {},
    });
    await persistence.persistWorkspace(workspace.snapshot());
    // A write interrupted mid-way leaves a .tmp-* sibling, never a torn target.
    await writeFile(`${workspacePath}.tmp-999`, "{corrupted json", "utf8");
    const restarted = await openSpecialistPersistence({
      workspacePath,
      databaseUrl: undefined,
      logger: silentLogger,
    });
    const cabinet = await restarted.cabinets.open(TEST_WORKSPACE_ID);
    expect(cabinet.workspace.profiles()[0]?.name).toBe("Кабель");
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".tmp-999")),
    ).toHaveLength(1);
    await restarted.close();
    await persistence.close();
  });

  it("opens one cabinet for two concurrent first requests", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "workspace-"));
    tmpDirs.push(directory);
    const persistence = await openSpecialistPersistence({
      workspacePath: path.join(directory, "specialist-workspace.json"),
      databaseUrl: undefined,
      logger: silentLogger,
    });
    const [first, second] = await Promise.all([
      persistence.cabinets.open(TEST_WORKSPACE_ID),
      persistence.cabinets.open(TEST_WORKSPACE_ID),
    ]);
    expect(first).toBe(second);
    await persistence.close();
  });

  it("drops a purged case from the disk copy so a restart cannot restore trash", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "workspace-"));
    tmpDirs.push(directory);
    const workspacePath = path.join(directory, "specialist-workspace.json");
    const persistence = await openSpecialistPersistence({
      workspacePath,
      databaseUrl: undefined,
      logger: silentLogger,
    });
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000901",
      title: "Кабель из корзины",
      status: "accepting_bids",
      statusLabel: "приём",
      url: "https://goszakupki.by/auction/view/901",
      sourceProcurementId: "auction/901",
      triage: "reject",
    });
    await persistence.persistCases([card]);
    await persistence.removeCases([card.id]);
    const catalog = new SpecialistCatalog();
    await persistence.hydrateCatalog(catalog);
    expect(catalog.storedCases()).toEqual([]);
    await persistence.close();
  });
});
