import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SpecialistCatalog, SpecialistWorkspace } from "@procurement/domain";
import { SpecialistProcurementCard } from "@procurement/contracts";
import { silentLogger } from "@procurement/observability";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_WORKSPACE_ID } from "./cabinets.js";
import { openSpecialistPersistence } from "./persist.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
