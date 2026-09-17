import {
  countCabinetCases,
  isPrunableUndecidedCase,
  isWatchedTriage,
  pageListedCases,
  SpecialistCatalog,
  SpecialistWorkspace,
} from "@procurement/domain";
import type {
  InboxFixtureItem,
  SpecialistCaseDocument,
  SpecialistProcurementCard as SpecialistProcurementCardValue,
  SpecialistProcurementListTab,
  SpecialistWorkspaceState,
} from "@procurement/contracts";
import { randomUUID } from "node:crypto";

export const TEST_WORKSPACE_ID = "00000000-0000-4000-8000-000000000010";

export interface SpecialistCabinet {
  workspaceId: string;
  workspace: SpecialistWorkspace;
  catalog: SpecialistCatalog;
}

export interface SpecialistCaseListQuery {
  tab?: SpecialistProcurementListTab;
  limit?: number;
  offset?: number;
  liveOnly?: boolean;
  rejectedSourceIds?: ReadonlySet<string>;
}

export interface SpecialistCaseListPage {
  items: SpecialistProcurementCardValue[];
  total: number;
}

export interface CabinetSummaryCounts {
  profileCount: number;
  mineCount: number;
  archiveCount: number;
  trashCount: number;
}

export const EMPTY_CABINET_COUNTS: CabinetSummaryCounts = {
  profileCount: 0,
  mineCount: 0,
  archiveCount: 0,
  trashCount: 0,
};

export interface CabinetRegistry {
  workspaceIdFor: (userId: string) => Promise<string>;
  /** Looks up a personal workspace without creating one. */
  findWorkspaceId: (userId: string) => Promise<string | undefined>;
  ensurePersonalWorkspace: (userId: string, name?: string) => Promise<string>;
  open: (workspaceId: string) => Promise<SpecialistCabinet>;
  listIds: () => Promise<string[]>;
  persist: (cabinet: SpecialistCabinet) => Promise<void>;
  persistWorkspaceOnly: (cabinet: SpecialistCabinet) => Promise<void>;
  deleteProfile: (cabinet: SpecialistCabinet, profileId: string) => Promise<void>;
  persistProgress: (
    cabinet: SpecialistCabinet,
    caseIds: readonly string[],
  ) => Promise<void>;
  removeCases: (workspaceId: string, ids: readonly string[]) => Promise<void>;
  listTrashIds: (workspaceId: string) => Promise<string[]>;
  listCases: (workspaceId: string, query?: SpecialistCaseListQuery) => Promise<SpecialistCaseListPage>;
  summarizeCabinets: (
    workspaceIds: readonly string[],
  ) => Promise<Map<string, CabinetSummaryCounts>>;
  getCase: (workspaceId: string, id: string) => Promise<SpecialistProcurementCardValue | undefined>;
  findCaseBySource: (
    workspaceId: string,
    sourceProcurementId: string,
  ) => Promise<SpecialistProcurementCardValue | undefined>;
  loadCasesBySources: (
    workspaceId: string,
    sourceIds: readonly string[],
  ) => Promise<Map<string, SpecialistProcurementCardValue>>;
  listWatchedCases: (workspaceId: string, limit: number) => Promise<SpecialistProcurementCardValue[]>;
  listStaleUndecidedIds: (
    workspaceId: string,
    cutoffIso: string,
    keepSourceIds: readonly string[],
    keepIds?: readonly string[],
  ) => Promise<string[]>;
  findDocument: (workspaceId: string, hash: string) => Promise<SpecialistCaseDocument | undefined>;
  hasDocumentHash?: (workspaceId: string, hash: string) => Promise<boolean>;
}

export function createMemoryCabinetRegistry(options: {
  defaultCabinet?: SpecialistCabinet;
  singleton?: boolean;
} = {}): CabinetRegistry {
  const byId = new Map<string, SpecialistCabinet>();
  const byUser = new Map<string, string>();
  const singleton = options.singleton === true;
  if (options.defaultCabinet !== undefined) {
    byId.set(options.defaultCabinet.workspaceId, options.defaultCabinet);
  }

  const openFresh = (workspaceId: string): SpecialistCabinet => {
    const existing = byId.get(workspaceId);
    if (existing !== undefined) return existing;
    if (singleton && options.defaultCabinet !== undefined) return options.defaultCabinet;
    const created: SpecialistCabinet = {
      workspaceId,
      workspace: new SpecialistWorkspace(),
      catalog: new SpecialistCatalog(),
    };
    created.catalog.dismissMany(created.workspace.dismissedInboxIds());
    byId.set(workspaceId, created);
    return created;
  };

  const casesOf = (workspaceId: string): SpecialistProcurementCardValue[] =>
    openFresh(workspaceId).catalog.procurements();

  return {
    async workspaceIdFor(userId) {
      if (singleton && options.defaultCabinet !== undefined) return options.defaultCabinet.workspaceId;
      const existing = byUser.get(userId);
      if (existing !== undefined) return existing;
      return this.ensurePersonalWorkspace(userId);
    },
    async findWorkspaceId(userId) {
      if (singleton && options.defaultCabinet !== undefined) return options.defaultCabinet.workspaceId;
      return byUser.get(userId);
    },
    async ensurePersonalWorkspace(userId) {
      const existing = byUser.get(userId);
      if (existing !== undefined) return existing;
      if (singleton && options.defaultCabinet !== undefined) {
        byUser.set(userId, options.defaultCabinet.workspaceId);
        return options.defaultCabinet.workspaceId;
      }
      const workspaceId = randomUUID();
      byUser.set(userId, workspaceId);
      openFresh(workspaceId);
      return workspaceId;
    },
    async open(workspaceId) {
      return openFresh(workspaceId);
    },
    async listIds() {
      if (singleton && options.defaultCabinet !== undefined) return [options.defaultCabinet.workspaceId];
      return [...byId.keys()];
    },
    async persist() {
      // Memory is the store.
    },
    async persistWorkspaceOnly() {
      // Memory is the store.
    },
    async deleteProfile() {
      // Memory is the store.
    },
    async persistProgress() {
      // Memory is the store.
    },
    async removeCases() {
      // The in-memory catalog is already pruned by the request that called this.
    },
    async listTrashIds(workspaceId) {
      return casesOf(workspaceId)
        .filter((item) => item.triage === "reject")
        .map((item) => item.id);
    },
    async listCases(workspaceId, query = {}) {
      return pageListedCases(casesOf(workspaceId), query);
    },
    async summarizeCabinets(workspaceIds) {
      const summaries = new Map<string, CabinetSummaryCounts>();
      for (const workspaceId of workspaceIds) {
        const cabinet = openFresh(workspaceId);
        const counted = countCabinetCases(cabinet.catalog.storedCases());
        summaries.set(workspaceId, {
          profileCount: cabinet.workspace.profiles().length,
          ...counted,
        });
      }
      return summaries;
    },
    async getCase(workspaceId, id) {
      return casesOf(workspaceId).find((item) => item.id === id);
    },
    async findCaseBySource(workspaceId, sourceProcurementId) {
      return casesOf(workspaceId).find((item) => item.sourceProcurementId === sourceProcurementId);
    },
    async loadCasesBySources(workspaceId, sourceIds) {
      const wanted = new Set(sourceIds);
      const found = new Map<string, SpecialistProcurementCardValue>();
      for (const card of casesOf(workspaceId)) {
        if (wanted.has(card.sourceProcurementId)) found.set(card.sourceProcurementId, card);
      }
      return found;
    },
    async listWatchedCases(workspaceId, limit) {
      if (limit <= 0) return [];
      return casesOf(workspaceId)
        .filter((item) => item.live && item.archived !== true && isWatchedTriage(item))
        .sort((left, right) => watchOrder(left) - watchOrder(right))
        .slice(0, limit);
    },
    async listStaleUndecidedIds(workspaceId, cutoffIso, keepSourceIds, keepIds = []) {
      const cutoff = Date.parse(cutoffIso);
      const keep = new Set(keepSourceIds);
      const keepCases = new Set(keepIds);
      return openFresh(workspaceId)
        .catalog.storedCases()
        .filter((card) => isPrunableUndecidedCase(card, cutoff, keep, keepCases))
        .map((card) => card.id);
    },
    async findDocument(workspaceId, hash) {
      for (const card of casesOf(workspaceId)) {
        const document = card.documents.find((item) => item.hash === hash);
        if (document !== undefined) return document;
      }
      return undefined;
    },
  };
}

export async function hydrateCabinet(
  cabinet: SpecialistCabinet,
  input: {
    workspace?: SpecialistWorkspaceState;
    cases?: readonly SpecialistProcurementCardValue[];
    inbox?: readonly InboxFixtureItem[];
  },
): Promise<void> {
  if (input.workspace !== undefined) {
    const parsed = SpecialistWorkspace.parse(input.workspace);
    cabinet.workspace = parsed;
  }
  if (input.cases !== undefined) {
    for (const card of input.cases) {
      cabinet.catalog.upsertCase(card);
    }
  }
  if (input.inbox !== undefined) {
    for (const item of input.inbox) {
      cabinet.catalog.record(item);
    }
  }
  cabinet.catalog.dismissMany(cabinet.workspace.dismissedInboxIds());
}

export function watchOrder(card: SpecialistProcurementCardValue): number {
  const at = card.watchSnapshot?.capturedAt;
  if (at === undefined) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
