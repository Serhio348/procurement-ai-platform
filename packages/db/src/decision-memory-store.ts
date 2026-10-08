import { DecisionMemoryEntry } from "@procurement/contracts";
import { and, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { workspaceDecisionMemory } from "./schema.js";

/**
 * Background decision memory of the cabinet assistant. Every read and write
 * is scoped by workspace: one cabinet's decisions never reach another's.
 */
export interface DecisionMemoryStore {
  /** Latest decision wins: re-deciding a procedure replaces its entry. */
  record(workspaceId: string, entry: DecisionMemoryEntry): Promise<void>;
  /** «Вернуть» withdraws the decision, so the memory forgets it too. */
  forget(workspaceId: string, sourceProcurementId: string): Promise<void>;
  list(workspaceId: string): Promise<DecisionMemoryEntry[]>;
}

export function createPostgresDecisionMemoryStore(db: Database): DecisionMemoryStore {
  return {
    async record(workspaceId, entry) {
      const row = DecisionMemoryEntry.parse(entry);
      const values = {
        kind: row.kind,
        profileIds: row.profileIds,
        title: row.title,
        lotTitles: row.lotTitles,
        decidedAt: row.decidedAt,
      };
      await db
        .insert(workspaceDecisionMemory)
        .values({ workspaceId, sourceProcurementId: row.sourceProcurementId, ...values })
        .onConflictDoUpdate({
          target: [workspaceDecisionMemory.workspaceId, workspaceDecisionMemory.sourceProcurementId],
          set: values,
        });
    },
    async forget(workspaceId, sourceProcurementId) {
      await db
        .delete(workspaceDecisionMemory)
        .where(
          and(
            eq(workspaceDecisionMemory.workspaceId, workspaceId),
            eq(workspaceDecisionMemory.sourceProcurementId, sourceProcurementId),
          ),
        );
    },
    async list(workspaceId) {
      const rows = await db
        .select()
        .from(workspaceDecisionMemory)
        .where(eq(workspaceDecisionMemory.workspaceId, workspaceId));
      return rows.map((row) =>
        DecisionMemoryEntry.parse({
          sourceProcurementId: row.sourceProcurementId,
          kind: row.kind,
          profileIds: row.profileIds,
          title: row.title,
          lotTitles: row.lotTitles,
          decidedAt: new Date(row.decidedAt).toISOString(),
        }),
      );
    },
  };
}
