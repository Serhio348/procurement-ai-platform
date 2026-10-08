import {
  DecisionMemoryEntry,
  type SpecialistProcurementCard,
  type SpecialistTriageKind,
} from "@procurement/contracts";

/** Same contract as the PostgreSQL store; every call is scoped by workspace. */
export interface DecisionMemoryPort {
  record(workspaceId: string, entry: DecisionMemoryEntry): Promise<void>;
  forget(workspaceId: string, sourceProcurementId: string): Promise<void>;
  list(workspaceId: string): Promise<DecisionMemoryEntry[]>;
}

export interface CabinetAssistantOptions {
  memory: DecisionMemoryPort;
  /** Pilot gate: cabinets outside it neither record nor expose memory. */
  enabledFor: (workspaceId: string) => boolean;
}

export function createMemoryDecisionMemory(): DecisionMemoryPort {
  const byWorkspace = new Map<string, Map<string, DecisionMemoryEntry>>();
  return {
    async record(workspaceId, entry) {
      const rows = byWorkspace.get(workspaceId) ?? new Map<string, DecisionMemoryEntry>();
      rows.set(entry.sourceProcurementId, DecisionMemoryEntry.parse(entry));
      byWorkspace.set(workspaceId, rows);
    },
    async forget(workspaceId, sourceProcurementId) {
      byWorkspace.get(workspaceId)?.delete(sourceProcurementId);
    },
    async list(workspaceId) {
      return [...(byWorkspace.get(workspaceId)?.values() ?? [])];
    },
  };
}

/**
 * ASSISTANT_WORKSPACE_IDS: comma-separated cabinet ids, or `*` for every
 * cabinet. Unset or empty keeps the assistant off everywhere.
 */
export function assistantPilotFromEnv(raw: string | undefined): (workspaceId: string) => boolean {
  const ids = (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (ids.includes("*")) return () => true;
  const allowed = new Set(ids);
  return (workspaceId) => allowed.has(workspaceId);
}

/** Lot subjects are kept only when they add words beyond the title. */
export function decisionMemoryEntry(
  card: SpecialistProcurementCard,
  kind: SpecialistTriageKind,
  decidedAt: string,
): DecisionMemoryEntry {
  const title = card.sourceCard?.title ?? card.title;
  const lotTitles = [
    ...new Set(
      (card.sourceCard?.lots ?? [])
        .map((lot) => lot.title.trim())
        .filter((lotTitle) => lotTitle.length > 0 && lotTitle !== title.trim()),
    ),
  ].slice(0, 50);
  return DecisionMemoryEntry.parse({
    sourceProcurementId: card.sourceProcurementId,
    kind,
    profileIds: card.profileIds,
    title,
    lotTitles,
    decidedAt,
  });
}
