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
import {
  countCabinetCases,
  isWatchedTriage,
  pageListedCases,
  SpecialistCatalog,
  SpecialistWorkspace,
} from "@procurement/domain";
import type { Logger } from "@procurement/observability";
import type {
  InboxFixtureItem,
  SpecialistProcurementCard as SpecialistProcurementCardValue,
  SpecialistWorkspaceState,
} from "@procurement/contracts";
import { loadWorkspaceFile, saveWorkspaceFile } from "./workspace-file.js";
import {
  createMemoryCabinetRegistry,
  hydrateCabinet,
  TEST_WORKSPACE_ID,
  watchOrder,
  type CabinetRegistry,
  type CabinetSummaryCounts,
  type SpecialistCabinet,
} from "./cabinets.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SpecialistPersistence {
  workspace: SpecialistWorkspace;
  postgres: boolean;
  authDirectory: AuthDirectory;
  cabinets: CabinetRegistry;
  hydrateCatalog: (catalog: SpecialistCatalog) => Promise<void>;
  persistWorkspace: (state: SpecialistWorkspaceState, workspaceId?: string) => Promise<void>;
  persistCases: (
    cards: readonly SpecialistProcurementCardValue[],
    workspaceId?: string,
  ) => Promise<void>;
  persistInbox: (items: readonly InboxFixtureItem[], workspaceId?: string) => Promise<void>;
  removeCases: (ids: readonly string[], workspaceId?: string) => Promise<void>;
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

  const memoryCabinets = createMemoryCabinetRegistry();
  const cache = new Map<string, SpecialistCabinet>();

  const defaultWorkspaceId = TEST_WORKSPACE_ID;

  const persistWorkspace = async (
    state: SpecialistWorkspaceState,
    workspaceId = defaultWorkspaceId,
  ): Promise<void> => {
    await saveWorkspaceFile(
      workspaceFilePath(options.workspacePath, workspaceId),
      SpecialistWorkspace.parse(state),
    );
    if (store === undefined) return;
    try {
      await store.saveWorkspace(state, workspaceId);
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
    workspaceId = defaultWorkspaceId,
  ): Promise<void> => {
    await writeJson(casesFilePath(options.workspacePath, workspaceId), cards);
    if (store === undefined) return;
    try {
      await store.saveCases(cards, workspaceId);
    } catch (error) {
      options.logger.error("PostgreSQL case save failed", error);
      await recordJournal(journal, {
        kind: "platform",
        level: "error",
        message: persistCaseErrorMessage(error),
      });
    }
  };

  const persistInbox = async (
    items: readonly InboxFixtureItem[],
    workspaceId = defaultWorkspaceId,
  ): Promise<void> => {
    await writeJson(inboxFilePath(options.workspacePath, workspaceId), items);
    if (store === undefined) return;
    try {
      await store.saveInbox(items, workspaceId);
    } catch (error) {
      options.logger.error("PostgreSQL inbox save failed", error);
      await recordJournal(journal, {
        kind: "platform",
        level: "error",
        message: "Не удалось записать Входящие в PostgreSQL.",
      });
    }
  };

  const removeCases = async (
    ids: readonly string[],
    workspaceId = defaultWorkspaceId,
  ): Promise<void> => {
    if (store !== undefined) {
      try {
        await store.removeCases(ids, workspaceId);
      } catch (error) {
        options.logger.error("PostgreSQL case removal failed", error);
        await recordJournal(journal, {
          kind: "platform",
          level: "error",
          message: "Не удалось удалить устаревшие карточки из PostgreSQL.",
        });
        throw error;
      }
    }
    const wanted = new Set(ids);
    const cards = await readJson<SpecialistProcurementCardValue[]>(
      casesFilePath(options.workspacePath, workspaceId),
      [],
    );
    await writeJson(
      casesFilePath(options.workspacePath, workspaceId),
      cards.filter((card) => !wanted.has(card.id)),
    );
  };

  const openCabinet = async (workspaceId: string): Promise<SpecialistCabinet> => {
    const cached = cache.get(workspaceId);
    if (cached !== undefined) return cached;
    const cabinet: SpecialistCabinet = {
      workspaceId,
      workspace: new SpecialistWorkspace(),
      catalog: new SpecialistCatalog(),
    };
    if (store !== undefined) {
      const fromDb = await store.loadWorkspace(workspaceId);
      let inbox: InboxFixtureItem[] = [];
      try {
        inbox = await store.loadInbox(workspaceId);
      } catch (error) {
        options.logger.error("PostgreSQL workspace inbox missing; run npm run db:migrate", error);
        throw error;
      }
      await hydrateCabinet(cabinet, {
        ...(fromDb === undefined ? {} : { workspace: fromDb }),
        inbox,
      });
    } else {
      const fromFile = await loadWorkspaceFile(workspaceFilePath(options.workspacePath, workspaceId));
      const cases = await readJson<SpecialistProcurementCardValue[]>(
        casesFilePath(options.workspacePath, workspaceId),
        [],
      );
      const inbox = await readJson<InboxFixtureItem[]>(
        inboxFilePath(options.workspacePath, workspaceId),
        [],
      );
      await hydrateCabinet(cabinet, {
        workspace: fromFile.snapshot(),
        cases,
        inbox,
      });
    }
    cache.set(workspaceId, cabinet);
    return cabinet;
  };

  const cabinets: CabinetRegistry = {
    async workspaceIdFor(userId) {
      if (store === undefined) return memoryCabinets.workspaceIdFor(userId);
      const existing = await store.personalWorkspaceId(userId);
      if (existing !== undefined) return existing;
      return store.ensurePersonalWorkspace(userId);
    },
    async findWorkspaceId(userId) {
      if (store === undefined) return memoryCabinets.findWorkspaceId(userId);
      return store.personalWorkspaceId(userId);
    },
    async ensurePersonalWorkspace(userId, name) {
      if (store === undefined) return memoryCabinets.ensurePersonalWorkspace(userId, name);
      return store.ensurePersonalWorkspace(userId, name);
    },
    async open(workspaceId) {
      return openCabinet(workspaceId);
    },
    async listIds() {
      if (store === undefined) return memoryCabinets.listIds();
      return store.listWorkspaceIds();
    },
    async persist(cabinet) {
      cache.set(cabinet.workspaceId, cabinet);
      await persistWorkspace(cabinet.workspace.snapshot(), cabinet.workspaceId);
      await persistCases(cabinet.catalog.storedCases(), cabinet.workspaceId);
      await persistInbox(cabinet.catalog.inboxItems(), cabinet.workspaceId);
    },
    async persistWorkspaceOnly(cabinet) {
      cache.set(cabinet.workspaceId, cabinet);
      await persistWorkspace(cabinet.workspace.snapshot(), cabinet.workspaceId);
    },
    async removeCases(workspaceId, ids) {
      await removeCases(ids, workspaceId);
    },
    async listTrashIds(workspaceId) {
      if (store !== undefined) return store.listTrashIds(workspaceId);
      const cabinet = await openCabinet(workspaceId);
      return cabinet.catalog
        .storedCases()
        .filter((item) => item.triage === "reject")
        .map((item) => item.id);
    },
    async listCases(workspaceId, query = {}) {
      if (store !== undefined) {
        return store.listCases(workspaceId, {
          ...(query.tab === undefined ? {} : { tab: query.tab }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          ...(query.offset === undefined ? {} : { offset: query.offset }),
          ...(query.liveOnly === undefined ? {} : { liveOnly: query.liveOnly }),
          ...(query.rejectedSourceIds === undefined
            ? {}
            : { rejectedSourceIds: [...query.rejectedSourceIds] }),
        });
      }
      const cabinet = await openCabinet(workspaceId);
      return pageListedCases(cabinet.catalog.procurements(), query);
    },
    async summarizeCabinets(workspaceIds) {
      if (store !== undefined) return store.summarizeCabinets(workspaceIds);
      const summaries = new Map<string, CabinetSummaryCounts>();
      for (const workspaceId of workspaceIds) {
        const cabinet = await openCabinet(workspaceId);
        summaries.set(workspaceId, {
          profileCount: cabinet.workspace.profiles().length,
          ...countCabinetCases(cabinet.catalog.storedCases()),
        });
      }
      return summaries;
    },
    async getCase(workspaceId, id) {
      if (store !== undefined) return store.getCase(workspaceId, id);
      const cabinet = await openCabinet(workspaceId);
      return cabinet.catalog.procurements().find((item) => item.id === id);
    },
    async findCaseBySource(workspaceId, sourceProcurementId) {
      if (store !== undefined) return store.findCaseBySource(workspaceId, sourceProcurementId);
      const cabinet = await openCabinet(workspaceId);
      return cabinet.catalog
        .procurements()
        .find((item) => item.sourceProcurementId === sourceProcurementId);
    },
    async loadCasesBySources(workspaceId, sourceIds) {
      if (store !== undefined) return store.loadCasesBySources(workspaceId, sourceIds);
      const wanted = new Set(sourceIds);
      const found = new Map<string, SpecialistProcurementCardValue>();
      const cabinet = await openCabinet(workspaceId);
      for (const card of cabinet.catalog.procurements()) {
        if (wanted.has(card.sourceProcurementId)) found.set(card.sourceProcurementId, card);
      }
      return found;
    },
    async listWatchedCases(workspaceId, limit) {
      if (store !== undefined) return store.listWatchedCases(workspaceId, limit);
      const cabinet = await openCabinet(workspaceId);
      if (limit <= 0) return [];
      return cabinet.catalog
        .procurements()
        .filter((item) => item.live === true && item.archived !== true && isWatchedTriage(item))
        .sort((left, right) => watchOrder(left) - watchOrder(right))
        .slice(0, limit);
    },
    async listStaleUndecidedIds(workspaceId, cutoffIso, keepSourceIds) {
      if (store !== undefined) {
        return store.listStaleUndecidedIds(workspaceId, cutoffIso, keepSourceIds);
      }
      const cabinet = await openCabinet(workspaceId);
      const cutoff = Date.parse(cutoffIso);
      const keep = new Set(keepSourceIds);
      return cabinet.catalog
        .procurements()
        .filter((card) => {
          if (card.live !== true || card.triage !== undefined) return false;
          if (keep.has(card.sourceProcurementId)) return false;
          const seen = card.lastSeenAt === undefined ? Number.NaN : Date.parse(card.lastSeenAt);
          if (Number.isFinite(seen) && seen >= cutoff) return false;
          return true;
        })
        .map((card) => card.id);
    },
    async findDocument(workspaceId, hash) {
      if (store !== undefined) return store.findDocument(workspaceId, hash);
      const cabinet = await openCabinet(workspaceId);
      for (const card of cabinet.catalog.procurements()) {
        const document = card.documents.find((item) => item.hash === hash);
        if (document !== undefined) return document;
      }
      return undefined;
    },
    async hasDocumentHash(workspaceId, hash) {
      if (store === undefined) {
        const cabinet = await openCabinet(workspaceId);
        return cabinet.catalog.procurements().some((card) =>
          card.documents.some((document) => document.hash === hash),
        );
      }
      return store.hasDocumentHash(workspaceId, hash);
    },
  };

  if (store !== undefined) {
    try {
      await store.loadWorkspace(defaultWorkspaceId);
    } catch (error) {
      options.logger.warn("PostgreSQL specialist schema missing; run npm run db:migrate", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (connected !== undefined) await connected.pool.end();
      connected = undefined;
      store = undefined;
    }
  }

  return {
    workspace: fileWorkspace,
    postgres: store !== undefined,
    authDirectory:
      connected === undefined
        ? createMemoryAuthDirectory()
        : createPostgresAuthDirectory(connected.db),
    cabinets,
    async hydrateCatalog(catalog) {
      const cabinet = await openCabinet(defaultWorkspaceId);
      for (const card of cabinet.catalog.storedCases()) {
        catalog.upsertCase(card);
      }
      for (const item of cabinet.catalog.inboxItems()) {
        catalog.record(item);
      }
      catalog.dismissMany(cabinet.workspace.dismissedInboxIds());
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

function workspaceFilePath(base: string, workspaceId: string): string {
  if (workspaceId === TEST_WORKSPACE_ID) return base;
  return path.join(path.dirname(base), "workspaces", `${workspaceId}.json`);
}

function casesFilePath(base: string, workspaceId: string): string {
  return path.join(path.dirname(base), "workspaces", `${workspaceId}.cases.json`);
}

function inboxFilePath(base: string, workspaceId: string): string {
  return path.join(path.dirname(base), "workspaces", `${workspaceId}.inbox.json`);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
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
