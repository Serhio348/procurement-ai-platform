import { sql } from "drizzle-orm";
import type { Database } from "./client.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function withWorkspace<T>(
  db: Database,
  workspaceId: string,
  fn: (tx: Transaction) => Promise<T>,
  userId?: string,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    if (userId !== undefined) {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    }
    return fn(tx);
  });
}

/**
 * Same as withWorkspace, but takes a transaction-scoped advisory lock so
 * writers for one cabinet cannot interleave and deadlock on inbox/cases rows.
 */
export async function withWorkspaceWrite<T>(
  db: Database,
  workspaceId: string,
  fn: (tx: Transaction) => Promise<T>,
  userId?: string,
): Promise<T> {
  return withWorkspace(
    db,
    workspaceId,
    async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workspaceId}))`);
      return fn(tx);
    },
    userId,
  );
}

export async function withUser<T>(
  db: Database,
  userId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

export async function withRlsBypass<T>(
  db: Database,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.rls_bypass', 'on', true)`);
    return fn(tx);
  });
}
