import { AssistantSuggestion } from "@procurement/contracts";
import { and, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { workspaceAssistantSuggestions } from "./schema.js";

/** Every read and write is scoped by workspace. */
export interface AssistantSuggestionStore {
  /** All offers of the cabinet, any state: they are the "already offered" memory. */
  list(workspaceId: string): Promise<AssistantSuggestion[]>;
  /** False when this (profile, term) was offered before. */
  offer(workspaceId: string, suggestion: AssistantSuggestion): Promise<boolean>;
  /** Closes an open offer; undefined when it is unknown or already closed. */
  resolve(
    workspaceId: string,
    id: string,
    state: "accepted" | "dismissed",
    resolvedAt: string,
  ): Promise<AssistantSuggestion | undefined>;
}

type Row = typeof workspaceAssistantSuggestions.$inferSelect;

function toSuggestion(row: Row): AssistantSuggestion {
  return AssistantSuggestion.parse({
    id: row.id,
    profileId: row.profileId,
    termKey: row.termKey,
    label: row.label,
    rejectCount: row.rejectCount,
    examples: row.examples,
    state: row.state,
    createdAt: new Date(row.createdAt).toISOString(),
  });
}

export function createPostgresAssistantSuggestionStore(db: Database): AssistantSuggestionStore {
  return {
    async list(workspaceId) {
      const rows = await db
        .select()
        .from(workspaceAssistantSuggestions)
        .where(eq(workspaceAssistantSuggestions.workspaceId, workspaceId));
      return rows.map(toSuggestion);
    },
    async offer(workspaceId, suggestion) {
      const row = AssistantSuggestion.parse(suggestion);
      const inserted = await db
        .insert(workspaceAssistantSuggestions)
        .values({
          id: row.id,
          workspaceId,
          profileId: row.profileId,
          termKey: row.termKey,
          label: row.label,
          rejectCount: row.rejectCount,
          examples: row.examples,
          state: row.state,
          createdAt: row.createdAt,
        })
        .onConflictDoNothing()
        .returning({ id: workspaceAssistantSuggestions.id });
      return inserted.length > 0;
    },
    async resolve(workspaceId, id, state, resolvedAt) {
      const rows = await db
        .update(workspaceAssistantSuggestions)
        .set({ state, resolvedAt })
        .where(
          and(
            eq(workspaceAssistantSuggestions.workspaceId, workspaceId),
            eq(workspaceAssistantSuggestions.id, id),
            eq(workspaceAssistantSuggestions.state, "open"),
          ),
        )
        .returning();
      const row = rows[0];
      return row === undefined ? undefined : toSuggestion(row);
    },
  };
}
