import {
  createDatabase,
  createSpecialistStore,
  postgresErrorMessage,
  type Database,
} from "@procurement/db";
import {
  createMemoryAdminJournal,
  createPostgresAdminJournal,
  recordJournal,
  type AdminJournalPort,
} from "./admin/journal.js";
import type { AuthDirectory } from "./auth/directory.js";
import { createMemoryAuthDirectory } from "./auth/memory-directory.js";
import { createPostgresAuthDirectory } from "./auth/postgres-directory.js";
import type { SpecialistCatalog } from "@procurement/domain";
import { SpecialistWorkspace } from "@procurement/domain";
import type { Logger } from "@procurement/observability";
import type {
  InboxFixtureItem,
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
  persistInbox: (items: readonly InboxFixtureItem[]) => Promise<void>;
  removeCases: (ids: readonly string[]) => Promise<void>;
  journal: AdminJournalPort;
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

  const journal =
    connected === undefined
      ? createMemoryAdminJournal()
      : createPostgresAdminJournal(connected.db);
  const configuredUrl = options.databaseUrl?.trim() ?? "";
  if (configuredUrl.length > 0 && connected === undefined) {
    await recordJournal(journal, {
      kind: "platform",
      level: "error",
      message: "PostgreSQL недоступен. Состояние консоли остаётся на диске.",
    });
  }

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
      await recordJournal(journal, {
        kind: "platform",
        level: "error",
        message: "Не удалось записать профиль в PostgreSQL. Копия на диске сохранена.",
      });
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
      await recordJournal(journal, {
        kind: "platform",
        level: "error",
        message: persistCaseErrorMessage(error),
      });
    }
  };

  const persistInbox = async (items: readonly InboxFixtureItem[]): Promise<void> => {
    if (store === undefined) return;
    try {
      await store.saveInbox(items);
    } catch (error) {
      options.logger.error("PostgreSQL inbox save failed", error);
      await recordJournal(journal, {
        kind: "platform",
        level: "error",
        message: "Не удалось записать Входящие в PostgreSQL.",
      });
    }
  };

  const removeCases = async (ids: readonly string[]): Promise<void> => {
    if (store === undefined) return;
    try {
      await store.removeCases(ids);
    } catch (error) {
      options.logger.error("PostgreSQL case removal failed", error);
      await recordJournal(journal, {
        kind: "platform",
        level: "error",
        message: "Не удалось удалить устаревшие карточки из PostgreSQL.",
      });
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
      let inbox: InboxFixtureItem[];
      try {
        inbox = await store.loadInbox();
      } catch (error) {
        // A half-migrated database must not silently drop to disk: the cases
        // above already came from PostgreSQL. Stop and ask for the migration.
        options.logger.error("PostgreSQL specialist_inbox missing; run npm run db:migrate", error);
        throw error;
      }
      for (const item of inbox) {
        catalog.record(item);
      }
    },
    persistWorkspace,
    persistCases,
    persistInbox,
    removeCases,
    journal,
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

function persistCaseErrorMessage(error: unknown): string {
  const detail = postgresErrorMessage(error).replaceAll(/\s+/g, " ").trim();
  const prefix = "Не удалось записать карточку закупки в PostgreSQL.";
  if (detail.length === 0) return prefix;
  return `${prefix} ${detail}`.slice(0, 2000);
}
