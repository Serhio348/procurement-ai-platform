import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SearchHit } from "@procurement/contracts";
import {
  compileSpecialistCase,
  searchHitsFromFixtureDump,
  SpecialistCatalog,
} from "@procurement/domain";

const inboxPath = fileURLToPath(new URL("../../../tests/fixtures/specialist/inbox.json", import.meta.url));
const livePath = fileURLToPath(new URL("../../../tests/fixtures/specialist/live-run.json", import.meta.url));
const procurementFixturePath = fileURLToPath(
  new URL("../../../tests/fixtures/procurement/normalized.json", import.meta.url),
);

export async function loadFixtureCatalog(
  path = inboxPath,
): Promise<SpecialistCatalog> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  const catalog = SpecialistCatalog.parse(raw);
  try {
    const live = JSON.parse(await readFile(livePath, "utf8")) as unknown;
    catalog.upsertCase(compileSpecialistCase(live));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return catalog;
}

export async function loadFixtureSearchHits(
  path = procurementFixturePath,
): Promise<readonly SearchHit[]> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  return searchHitsFromFixtureDump(raw);
}
