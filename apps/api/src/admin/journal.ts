import {
  AdminJournalEntry,
  AdminJournalListResponse,
  AdminJournalWrite,
  type AdminJournalEntry as AdminJournalEntryValue,
  type AdminJournalWrite as AdminJournalWriteValue,
} from "@procurement/contracts";
import { adminJournal, type Database } from "@procurement/db";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { toIsoDateTime } from "../auth/instant.js";

export const ADMIN_JOURNAL_LIST_LIMIT = 200;
export const ADMIN_ERROR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface AdminJournalPort {
  record: (input: AdminJournalWriteValue) => Promise<void>;
  list: (limit?: number) => Promise<AdminJournalEntryValue[]>;
  errorCount: () => Promise<number>;
  /** Clears the error badge without erasing history. Returns how many rows stopped being active. */
  acknowledgeErrors: (at?: string) => Promise<number>;
}

export function listedJournal(items: readonly AdminJournalEntryValue[], errorCount: number) {
  return AdminJournalListResponse.parse({ items, errorCount });
}

export function createMemoryAdminJournal(): AdminJournalPort {
  const items: AdminJournalEntryValue[] = [];
  return {
    async record(input) {
      const parsed = AdminJournalWrite.parse(input);
      items.unshift(
        AdminJournalEntry.parse({
          id: crypto.randomUUID(),
          at: parsed.at ?? new Date().toISOString(),
          kind: parsed.kind,
          level: parsed.level,
          message: parsed.message,
          ...(parsed.actorName === undefined ? {} : { actorName: parsed.actorName }),
          ...(parsed.actorEmail === undefined ? {} : { actorEmail: parsed.actorEmail }),
          ...(parsed.sourceProcurementId === undefined
            ? {}
            : { sourceProcurementId: parsed.sourceProcurementId }),
        }),
      );
      if (items.length > 500) items.length = 500;
    },
    async list(limit = ADMIN_JOURNAL_LIST_LIMIT) {
      return items.slice(0, limit);
    },
    async errorCount() {
      const since = Date.now() - ADMIN_ERROR_WINDOW_MS;
      return items.filter((item) => isOpenError(item, since)).length;
    },
    async acknowledgeErrors(at = new Date().toISOString()) {
      let cleared = 0;
      for (const [index, item] of items.entries()) {
        if (item.level !== "error" || item.acknowledgedAt !== undefined) continue;
        items[index] = AdminJournalEntry.parse({ ...item, acknowledgedAt: at });
        cleared += 1;
      }
      return cleared;
    },
  };
}

/** An error is active while it is inside the badge window and nobody has cleared it. */
export function isOpenError(item: AdminJournalEntryValue, since: number): boolean {
  if (item.level !== "error") return false;
  if (item.acknowledgedAt !== undefined) return false;
  return Date.parse(item.at) >= since;
}

export function createPostgresAdminJournal(db: Database): AdminJournalPort {
  return {
    async record(input) {
      const parsed = AdminJournalWrite.parse(input);
      await db.insert(adminJournal).values({
        at: parsed.at ?? new Date().toISOString(),
        kind: parsed.kind,
        level: parsed.level,
        message: parsed.message,
        actorName: parsed.actorName,
        actorEmail: parsed.actorEmail,
        sourceProcurementId: parsed.sourceProcurementId,
      });
    },
    async list(limit = ADMIN_JOURNAL_LIST_LIMIT) {
      const rows = await db
        .select()
        .from(adminJournal)
        .orderBy(desc(adminJournal.at))
        .limit(limit);
      return rows.map(rowToEntry);
    },
    async errorCount() {
      const since = new Date(Date.now() - ADMIN_ERROR_WINDOW_MS).toISOString();
      const rows = await db
        .select({ id: adminJournal.id })
        .from(adminJournal)
        .where(
          and(
            eq(adminJournal.level, "error"),
            gte(adminJournal.at, since),
            isNull(adminJournal.acknowledgedAt),
          ),
        );
      return rows.length;
    },
    async acknowledgeErrors(at = new Date().toISOString()) {
      const rows = await db
        .update(adminJournal)
        .set({ acknowledgedAt: at })
        .where(and(eq(adminJournal.level, "error"), isNull(adminJournal.acknowledgedAt)))
        .returning({ id: adminJournal.id });
      return rows.length;
    },
  };
}

export async function recordJournal(
  journal: AdminJournalPort | undefined,
  input: AdminJournalWriteValue,
): Promise<void> {
  if (journal === undefined) return;
  try {
    await journal.record(input);
  } catch {
    // Journal must not hide the specialist or admin action that produced it.
  }
}

function rowToEntry(row: typeof adminJournal.$inferSelect): AdminJournalEntryValue {
  return AdminJournalEntry.parse({
    id: row.id,
    at: toIsoDateTime(row.at),
    kind: row.kind,
    level: row.level,
    message: row.message,
    ...(row.actorName === null || row.actorName.length === 0 ? {} : { actorName: row.actorName }),
    ...(row.actorEmail === null || row.actorEmail.length === 0 ? {} : { actorEmail: row.actorEmail }),
    ...(row.sourceProcurementId === null || row.sourceProcurementId.length === 0
      ? {}
      : { sourceProcurementId: row.sourceProcurementId }),
    ...(row.acknowledgedAt === null
      ? {}
      : { acknowledgedAt: toIsoDateTime(row.acknowledgedAt) }),
  });
}
