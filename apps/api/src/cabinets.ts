import { SpecialistCatalog, SpecialistWorkspace } from "@procurement/domain";
import type {
  InboxFixtureItem,
  SpecialistProcurementCard as SpecialistProcurementCardValue,
  SpecialistWorkspaceState,
} from "@procurement/contracts";
import { randomUUID } from "node:crypto";

export const TEST_WORKSPACE_ID = "00000000-0000-4000-8000-000000000010";

export interface SpecialistCabinet {
  workspaceId: string;
  workspace: SpecialistWorkspace;
  catalog: SpecialistCatalog;
}

export interface CabinetRegistry {
  workspaceIdFor: (userId: string) => Promise<string>;
  ensurePersonalWorkspace: (userId: string, name?: string) => Promise<string>;
  open: (workspaceId: string) => Promise<SpecialistCabinet>;
  listIds: () => Promise<string[]>;
  persist: (cabinet: SpecialistCabinet) => Promise<void>;
  removeCases: (workspaceId: string, ids: readonly string[]) => Promise<void>;
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

  return {
    async workspaceIdFor(userId) {
      if (singleton && options.defaultCabinet !== undefined) return options.defaultCabinet.workspaceId;
      const existing = byUser.get(userId);
      if (existing !== undefined) return existing;
      return this.ensurePersonalWorkspace(userId);
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
    async removeCases() {
      // The in-memory catalog is already pruned by the request that called this.
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
