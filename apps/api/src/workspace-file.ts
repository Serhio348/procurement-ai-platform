import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { SpecialistWorkspace } from "@procurement/domain";

export async function loadWorkspaceFile(filePath: string): Promise<SpecialistWorkspace> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return SpecialistWorkspace.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new SpecialistWorkspace();
    }
    throw error;
  }
}

export async function saveWorkspaceFile(
  filePath: string,
  workspace: SpecialistWorkspace,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  // tmp + rename keeps the last complete snapshot on crash (R21).
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(workspace.snapshot(), null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}
