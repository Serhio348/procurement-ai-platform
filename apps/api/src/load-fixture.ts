import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SpecialistCatalog } from "@procurement/domain";

export async function loadFixtureCatalog(
  path = fileURLToPath(new URL("../../../tests/fixtures/specialist/inbox.json", import.meta.url)),
): Promise<SpecialistCatalog> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  return SpecialistCatalog.parse(raw);
}
