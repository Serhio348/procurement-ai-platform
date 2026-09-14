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
