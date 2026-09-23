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
  isPersistableCabinetCase,
  isPrunableUndecidedCase,
  isWatchedTriage,
  pageListedCases,
  SpecialistCatalog,
  SpecialistWorkspace,
} from "@procurement/domain";
import type { Logger } from "@procurement/observability";
import {
  SpecialistWorkspaceState,
  type InboxFixtureItem,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SpecialistPersistence {
  workspace: SpecialistWorkspace;
  postgres: boolean;
  /** DATABASE_URL was set — PostgreSQL is the required system of record. */
  postgresConfigured: boolean;
  /** Live reachability check: the boot flag alone lies after a later outage. */
  ping: () => Promise<boolean>;
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

function persistableCabinetCases(cabinet: SpecialistCabinet): SpecialistProcurementCardValue[] {
  const keep = new Set(
    cabinet.workspace.profiles().flatMap((profile) => [...cabinet.workspace.searchIds(profile.id)]),
  );
  return cabinet.catalog
    .storedCases()
    .filter((card) => isPersistableCabinetCase(card, keep));
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
  const configuredUrl = options.databaseUrl?.trim() ?? "";
  let connected = await connectSpecialistDatabase(options.databaseUrl, options.logger);
  // Fail closed: a configured DATABASE_URL makes PostgreSQL the required
  // system of record. Serving files plus a memory auth directory under the
  // same address would silently show a different, empty cabinet (R20).
  if (configuredUrl.length > 0 && connected === undefined) {
    throw new Error(
      "DATABASE_URL задан, но PostgreSQL недоступен. Файловый режим в этом случае отключён: " +
        "проверьте подключение и запустите сервис снова.",
    );
  }
  let store = connected === undefined ? undefined : createSpecialistStore(connected.db);
  const journal =
    connected === undefined
      ? createMemoryAdminJournal()
      : createPostgresAdminJournal(connected.db);

  const memoryCabinets = createMemoryCabinetRegistry();
  /** Single-flight: the promise enters the map before the load awaits, so two
   * first-time opens of one workspace share one cabinet object (R26). */
  const cache = new Map<string, Promise<SpecialistCabinet>>();
  /** Profile ids removed in-process; scrub stale search snapshots so they cannot resurrect. */
  const deletedProfileIds = new Map<string, Set<string>>();

  function rememberDeletedProfile(workspaceId: string, profileId: string): void {
    const set = deletedProfileIds.get(workspaceId) ?? new Set<string>();
    set.add(profileId);
    deletedProfileIds.set(workspaceId, set);
  }

  function scrubDeletedProfiles(
    workspaceId: string,
    snapshot: SpecialistWorkspaceState,
  ): SpecialistWorkspaceState {
    const banned = deletedProfileIds.get(workspaceId);
    if (banned === undefined || banned.size === 0) return snapshot;
    const profiles = snapshot.profiles.filter((item) => !banned.has(item.id));
    if (profiles.length === snapshot.profiles.length) return snapshot;
    if (profiles.length === 0) return snapshot;
    const activeProfileId = profiles.some((item) => item.id === snapshot.activeProfileId)
      ? snapshot.activeProfileId
      : profiles[0]!.id;
    const searchIdsByProfile = Object.fromEntries(
      Object.entries(snapshot.searchIdsByProfile).filter(([id]) => !banned.has(id)),
    );
    const reviewedIrrelevant = snapshot.reviewedIrrelevant.filter(
      (item) => !banned.has(item.profileId),
    );
    const searchRuns = Object.fromEntries(
      Object.entries(snapshot.searchRuns).filter(([id]) => !banned.has(id)),
    );
    return SpecialistWorkspaceState.parse({
      ...snapshot,
      profiles,
      activeProfileId,
      searchIdsByProfile,
      reviewedIrrelevant,
      searchRuns,
    });
  }
  /** One writer chain per cabinet so profile/inbox/cases saves do not deadlock. */
  const workspaceWriteTail = new Map<string, Promise<unknown>>();

  const enqueueWorkspaceWrite = async <T>(
    workspaceId: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    const previous = workspaceWriteTail.get(workspaceId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    workspaceWriteTail.set(
      workspaceId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  };

  const defaultWorkspaceId = TEST_WORKSPACE_ID;

  /**
   * In PostgreSQL mode the database is the only authoritative record; the
   * JSON files are a diagnostic mirror. Their failures are logged but must
   * not fail the caller — and vice versa the database failure must reach
   * the caller instead of being masked by the disk copy (R19).
   */
  const mirrorToDisk = async (label: string, write: () => Promise<void>): Promise<void> => {
    try {
      await write();
    } catch (error) {
      options.logger.warn(`Disk copy ${label} failed; PostgreSQL remains authoritative`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const persistWorkspaceMeta = async (
    state: SpecialistWorkspaceState,
    workspaceId = defaultWorkspaceId,
  ): Promise<void> => {
    const durable = SpecialistWorkspace.parse(state);
    if (store !== undefined) {
      await mirrorToDisk("workspace", () =>
        saveWorkspaceFile(workspaceFilePath(options.workspacePath, workspaceId), durable),
      );
      try {
        await store.saveWorkspaceMeta(durable.snapshot(), workspaceId);
      } catch (error) {
        options.logger.error("PostgreSQL workspace meta save failed", error);
        await recordJournal(journal, {
          kind: "platform",
          level: "error",
          message: persistWorkspaceErrorMessage(error),
        });
        throw error;
      }
      return;
    }
    await saveWorkspaceFile(workspaceFilePath(options.workspacePath, workspaceId), durable);
  };

  const persistWorkspace = async (
    state: SpecialistWorkspaceState,
    workspaceId = defaultWorkspaceId,
  ): Promise<void> => {
    const durable = SpecialistWorkspace.parse(state);
    if (store !== undefined) {
      await mirrorToDisk("workspace", () =>
        saveWorkspaceFile(workspaceFilePath(options.workspacePath, workspaceId), durable),
      );
      try {
        await store.saveWorkspace(durable.snapshot(), workspaceId);
      } catch (error) {
        options.logger.error("PostgreSQL workspace save failed", error);
        await recordJournal(journal, {
          kind: "platform",
          level: "error",
          message: persistWorkspaceErrorMessage(error),
        });
        throw error;
      }
      return;
    }
    await saveWorkspaceFile(workspaceFilePath(options.workspacePath, workspaceId), durable);
  };

  const persistCases = async (
    cards: readonly SpecialistProcurementCardValue[],
    workspaceId = defaultWorkspaceId,
  ): Promise<void> => {
    if (store !== undefined) {
      await mirrorToDisk("cases", () =>
        writeJson(casesFilePath(options.workspacePath, workspaceId), cards),
      );
      try {
        await store.saveCases(cards, workspaceId);
      } catch (error) {
        options.logger.error("PostgreSQL case save failed", error);
        await recordJournal(journal, {
          kind: "platform",
          level: "error",
          message: persistCaseErrorMessage(error),
        });
        throw error;
      }
      return;
    }
    await writeJson(casesFilePath(options.workspacePath, workspaceId), cards);
  };

  const persistInbox = async (
    items: readonly InboxFixtureItem[],
    workspaceId = defaultWorkspaceId,
    dismissedChangeIds: readonly string[] = [],
  ): Promise<void> => {
    if (store !== undefined) {
      await mirrorToDisk("inbox", () =>
        writeJson(inboxFilePath(options.workspacePath, workspaceId), items),
      );
      try {
        await store.saveInbox(items, workspaceId, dismissedChangeIds);
      } catch (error) {
        options.logger.error("PostgreSQL inbox save failed", error);
        await recordJournal(journal, {
          kind: "platform",
          level: "error",
          message: persistInboxErrorMessage(error),
        });
        throw error;
      }
      return;
    }
    await writeJson(inboxFilePath(options.workspacePath, workspaceId), items);
  };

  const removeCases = async (
    ids: readonly string[],
    workspaceId = defaultWorkspaceId,
  ): Promise<void> => {
    return enqueueWorkspaceWrite(workspaceId, async () => {
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
        // Postgres is the system of record. Rewriting the leftover cases dump
        // would read every card on each trash delete.
        return;
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
    });
  };

  const openCabinet = async (workspaceId: string): Promise<SpecialistCabinet> => {
    const cached = cache.get(workspaceId);
    if (cached !== undefined) return cached;
    const promise = (async (): Promise<SpecialistCabinet> => {
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
        const fromFile = await loadWorkspaceFile(
          workspaceFilePath(options.workspacePath, workspaceId),
        );
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
      return cabinet;
    })();
    cache.set(workspaceId, promise);
    try {
      return await promise;
    } catch (error) {
      cache.delete(workspaceId);
      throw error;
    }
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
      return enqueueWorkspaceWrite(cabinet.workspaceId, async () => {
        cache.set(cabinet.workspaceId, Promise.resolve(cabinet));
        const cards = persistableCabinetCases(cabinet);
        const inbox = cabinet.catalog.inboxItems();
        // Re-read workspace after the slow case write so a concurrent profile
        // delete is not resurrected from a stale snapshot.
        const snapshot = scrubDeletedProfiles(
          cabinet.workspaceId,
          cabinet.workspace.snapshot(),
        );
        const durable = SpecialistWorkspace.parse(snapshot);
        if (store !== undefined) {
          await mirrorToDisk("cabinet", async () => {
            await writeJson(casesFilePath(options.workspacePath, cabinet.workspaceId), cards);
            await writeJson(inboxFilePath(options.workspacePath, cabinet.workspaceId), inbox);
            await saveWorkspaceFile(
              workspaceFilePath(options.workspacePath, cabinet.workspaceId),
              durable,
            );
          });
          try {
            await store.saveCabinet(snapshot, cards, inbox, cabinet.workspaceId);
          } catch (error) {
            options.logger.error("PostgreSQL cabinet save failed", error);
            await recordJournal(journal, {
              kind: "platform",
              level: "error",
              message: persistWorkspaceErrorMessage(error),
            });
            throw error;
          }
          return;
        }
        await writeJson(casesFilePath(options.workspacePath, cabinet.workspaceId), cards);
        await writeJson(inboxFilePath(options.workspacePath, cabinet.workspaceId), inbox);
        await saveWorkspaceFile(
          workspaceFilePath(options.workspacePath, cabinet.workspaceId),
          durable,
        );
      });
    },
    async persistProgress(cabinet, caseIds) {
      return enqueueWorkspaceWrite(cabinet.workspaceId, async () => {
        cache.set(cabinet.workspaceId, Promise.resolve(cabinet));
        const wanted = new Set(caseIds);
        const cards = persistableCabinetCases(cabinet).filter((card) => wanted.has(card.id));
        const inbox = cabinet.catalog.inboxItems();
        // Fresh workspace snapshot after the slow case write — and scrub tombstones —
        // so a concurrent profile × cannot be resurrected.
        const snapshot = scrubDeletedProfiles(
          cabinet.workspaceId,
          cabinet.workspace.snapshot(),
        );
        const durable = SpecialistWorkspace.parse(snapshot);
        if (store !== undefined) {
          await mirrorToDisk("cabinet", async () => {
            // Merge write of touched cards only is unsafe; write the full
            // persistable set for durability of the search queue.
            const allPersistable = persistableCabinetCases(cabinet);
            await writeJson(
              casesFilePath(options.workspacePath, cabinet.workspaceId),
              allPersistable,
            );
            await writeJson(inboxFilePath(options.workspacePath, cabinet.workspaceId), inbox);
            await saveWorkspaceFile(
              workspaceFilePath(options.workspacePath, cabinet.workspaceId),
              durable,
            );
          });
          try {
            await store.saveCabinet(snapshot, cards, inbox, cabinet.workspaceId);
          } catch (error) {
            options.logger.error("PostgreSQL cabinet progress save failed", error);
            await recordJournal(journal, {
              kind: "platform",
              level: "error",
              message: persistWorkspaceErrorMessage(error),
            });
            throw error;
          }
          return;
        }
        const allPersistable = persistableCabinetCases(cabinet);
        await writeJson(casesFilePath(options.workspacePath, cabinet.workspaceId), allPersistable);
        await writeJson(inboxFilePath(options.workspacePath, cabinet.workspaceId), inbox);
        await saveWorkspaceFile(
          workspaceFilePath(options.workspacePath, cabinet.workspaceId),
          durable,
        );
      });
    },
    async persistWorkspaceOnly(cabinet) {
      return enqueueWorkspaceWrite(cabinet.workspaceId, async () => {
        cache.set(cabinet.workspaceId, Promise.resolve(cabinet));
        await persistWorkspaceMeta(
          scrubDeletedProfiles(cabinet.workspaceId, cabinet.workspace.snapshot()),
          cabinet.workspaceId,
        );
      });
    },
    async deleteProfile(cabinet, profileId) {
      // Must not wait on the search/cabinet write queue — that is why × hung
      // and the row came back after reload.
      rememberDeletedProfile(cabinet.workspaceId, profileId);
      cache.set(cabinet.workspaceId, Promise.resolve(cabinet));
      const snapshot = scrubDeletedProfiles(
        cabinet.workspaceId,
        cabinet.workspace.snapshot(),
      );
      const durable = SpecialistWorkspace.parse(snapshot);
      if (store !== undefined) {
        await mirrorToDisk("workspace", () =>
          saveWorkspaceFile(workspaceFilePath(options.workspacePath, cabinet.workspaceId), durable),
        );
        await store.deleteWorkspaceProfile(
          cabinet.workspaceId,
          profileId,
          durable.snapshot().activeProfileId,
          durable.snapshot().searchIdsByProfile,
        );
        return;
      }
      await saveWorkspaceFile(
        workspaceFilePath(options.workspacePath, cabinet.workspaceId),
        durable,
      );
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
    async loadCasesByIds(workspaceId, ids) {
      if (store !== undefined) return store.loadCasesByIds(workspaceId, ids);
      const wanted = new Set(ids);
      const found = new Map<string, SpecialistProcurementCardValue>();
      const cabinet = await openCabinet(workspaceId);
      for (const card of cabinet.catalog.procurements()) {
        if (wanted.has(card.id)) found.set(card.id, card);
      }
      return found;
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
    async listIngestingCases(workspaceId) {
      if (store !== undefined) return store.listIngestingCases(workspaceId);
      const cases = await readJson<SpecialistProcurementCardValue[]>(
        casesFilePath(options.workspacePath, workspaceId),
        [],
      );
      return cases.filter((card) => card.ingesting !== undefined);
    },
    async listStaleUndecidedIds(workspaceId, cutoffIso, keepSourceIds, keepIds = []) {
      if (store !== undefined) {
        return store.listStaleUndecidedIds(workspaceId, cutoffIso, keepSourceIds, keepIds);
      }
      const cabinet = await openCabinet(workspaceId);
      const cutoff = Date.parse(cutoffIso);
      const keep = new Set(keepSourceIds);
      const keepCases = new Set(keepIds);
      return cabinet.catalog
        .storedCases()
        .filter((card) => isPrunableUndecidedCase(card, cutoff, keep, keepCases))
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
      if (configuredUrl.length > 0) {
        if (connected !== undefined) await connected.pool.end();
        throw new Error(
          "Схема specialist отсутствует в PostgreSQL. Выполните npm run db:migrate и запустите сервис снова.",
          { cause: error },
        );
      }
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
    postgresConfigured: configuredUrl.length > 0,
    async ping() {
      if (connected === undefined) return configuredUrl.length === 0;
      try {
        await connected.pool.query("select 1");
        return true;
      } catch {
        return false;
      }
    },
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
  // tmp + rename: a crashed write leaves the previous whole file, not a
  // half-written JSON that breaks the next boot (R21).
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temporary, filePath);
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

function persistWorkspaceErrorMessage(error: unknown): string {
  const detail = postgresErrorMessage(error).replaceAll(/\s+/g, " ").trim();
  const prefix = "Не удалось записать профиль в PostgreSQL. Копия на диске сохранена.";
  if (detail.length === 0) return prefix;
  return `${prefix} ${detail}`.slice(0, 2000);
}

function persistInboxErrorMessage(error: unknown): string {
  const detail = postgresErrorMessage(error).replaceAll(/\s+/g, " ").trim();
  const prefix = "Не удалось записать Входящие в PostgreSQL.";
  if (detail.length === 0) return prefix;
  return `${prefix} ${detail}`.slice(0, 2000);
}

