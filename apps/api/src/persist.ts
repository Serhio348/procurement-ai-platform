import {
  createDatabase,
  createSpecialistStore,
  type Database,
} from "@procurement/db";
import type { AuthDirectory } from "./auth/directory.js";
import { createMemoryAuthDirectory } from "./auth/memory-directory.js";
import { createPostgresAuthDirectory } from "./auth/postgres-directory.js";
import type { SpecialistCatalog } from "@procurement/domain";
import { SpecialistWorkspace } from "@procurement/domain";
import type { Logger } from "@procurement/observability";
import type {
  SpecialistProcurementCard as SpecialistProcurementCardValue,
  SpecialistWorkspaceState,
} from "@procurement/contracts";
import { loadWorkspaceFile, saveWorkspaceFile } from "./workspace-file.js";

export interface SpecialistPersistence {
  workspace: SpecialistWorkspace;
  postgres: boolean;
  authDirectory: AuthDirectory;
  hydrateCatalog: (catalog: SpecialistCatalog) => Promise<void>;
  persistWorkspace: (state: SpecialistWorkspaceState) => Promise<void>;
  persistCases: (cards: readonly SpecialistProcurementCardValue[]) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * PostgreSQL is the system of record when DATABASE_URL answers.
 * The workspace JSON file stays as the offline / CI fallback.
 */
export async function openSpecialistPersistence(options: {
  workspacePath: string;
  databaseUrl: string | undefined;
  logger: Logger;
}): Promise<SpecialistPersistence> {
  const fileWorkspace = await loadWorkspaceFile(options.workspacePath);
  let connected = await connectSpecialistDatabase(options.databaseUrl, options.logger);
  let store = connected === undefined ? undefined : createSpecialistStore(connected.db);
  let fromDb: SpecialistWorkspaceState | undefined;
  try {
    fromDb = store === undefined ? undefined : await store.loadWorkspace();
  } catch (error) {
    options.logger.warn("PostgreSQL specialist schema missing; run npm run db:migrate", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (connected !== undefined) await connected.pool.end();
    connected = undefined;
    store = undefined;
  }
  const workspace =
    fromDb === undefined ? fileWorkspace : SpecialistWorkspace.parse(fromDb);

  if (store !== undefined && fromDb === undefined) {
    await store.saveWorkspace(workspace.snapshot());
  }

  const persistWorkspace = async (state: SpecialistWorkspaceState): Promise<void> => {
    await saveWorkspaceFile(options.workspacePath, SpecialistWorkspace.parse(state));
    if (store === undefined) return;
    try {
      await store.saveWorkspace(state);
    } catch (error) {
      options.logger.error("PostgreSQL workspace save failed; disk copy remains", error);
    }
  };

  const persistCases = async (
    cards: readonly SpecialistProcurementCardValue[],
  ): Promise<void> => {
    if (store === undefined) return;
    try {
      await store.saveCases(cards);
    } catch (error) {
      options.logger.error("PostgreSQL case save failed", error);
    }
  };

  return {
    workspace,
    postgres: store !== undefined,
    authDirectory:
      connected === undefined
        ? createMemoryAuthDirectory()
        : createPostgresAuthDirectory(connected.db),
    async hydrateCatalog(catalog) {
      if (store === undefined) return;
      const cards = await store.loadCases();
      for (const card of cards) {
        catalog.upsertCase(card);
      }
    },
    persistWorkspace,
    persistCases,
    async close() {
      if (connected !== undefined) await connected.pool.end();
    },
  };
}

async function connectSpecialistDatabase(
  databaseUrl: string | undefined,
  logger: Logger,
): Promise<{ db: Database; pool: ReturnType<typeof createDatabase>["pool"] } | undefined> {
  const url = databaseUrl?.trim() ?? "";
  if (url.length === 0) return undefined;
  const created = createDatabase(url);
  try {
    await created.pool.query("select 1");
    return created;
  } catch (error) {
    logger.warn("PostgreSQL unavailable; specialist state stays on disk", {
      error: error instanceof Error ? error.message : String(error),
    });
    await created.pool.end();
    return undefined;
  }
}
