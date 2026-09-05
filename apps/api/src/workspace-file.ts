import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  await writeFile(filePath, `${JSON.stringify(workspace.snapshot(), null, 2)}\n`, "utf8");
}
