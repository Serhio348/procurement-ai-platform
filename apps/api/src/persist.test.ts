import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SpecialistCatalog, SpecialistWorkspace } from "@procurement/domain";
import { silentLogger } from "@procurement/observability";
import { afterEach, describe, expect, it } from "vitest";
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
});
