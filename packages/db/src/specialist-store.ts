import {
  InboxFixtureItem,
  SpecialistProcurementCard,
  SpecialistWorkspaceState,
  type InboxFixtureItem as InboxFixtureItemValue,
  type SpecialistCaseDocument,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
  type SpecialistWorkspaceState as SpecialistWorkspaceStateValue,
} from "@procurement/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  documentVersions,
  documents,
  procurements,
  specialistCases,
  specialistInbox,
  specialistWorkspaces,
} from "./schema.js";

export const DEFAULT_SPECIALIST_WORKSPACE_ID = "console";

/** Object-store key for bytes. The sha256 itself lives on document_versions.hash. */
export function blobStorageKey(hash: string): string {
  return `blobs/${hash}`;
}

export function createSpecialistStore(db: Database) {
  return {
    async loadWorkspace(
      id = DEFAULT_SPECIALIST_WORKSPACE_ID,
    ): Promise<SpecialistWorkspaceStateValue | undefined> {
      const rows = await db
        .select()
        .from(specialistWorkspaces)
        .where(eq(specialistWorkspaces.id, id))
        .limit(1);
      const snapshot = rows[0]?.snapshot;
      if (snapshot === undefined) return undefined;
      return SpecialistWorkspaceState.parse(snapshot);
    },

    async saveWorkspace(
      snapshot: SpecialistWorkspaceStateValue,
      id = DEFAULT_SPECIALIST_WORKSPACE_ID,
    ): Promise<void> {
      const now = new Date().toISOString();
      await db
        .insert(specialistWorkspaces)
        .values({ id, snapshot, updatedAt: now })
        .onConflictDoUpdate({
          target: specialistWorkspaces.id,
          set: { snapshot, updatedAt: now },
        });
    },

    async loadCases(): Promise<SpecialistProcurementCardValue[]> {
      const rows = await db.select().from(specialistCases);
      const cards: SpecialistProcurementCardValue[] = [];
      for (const row of rows) {
        const parsed = SpecialistProcurementCard.safeParse(row.card);
        if (parsed.success) cards.push(parsed.data);
      }
      return cards;
    },

    async saveCases(cards: readonly SpecialistProcurementCardValue[]): Promise<void> {
      const failures: string[] = [];
      for (const card of uniqueBySource(cards)) {
        try {
          await saveSpecialistCase(db, card);
        } catch (error) {
          failures.push(`${card.sourceProcurementId}: ${postgresErrorMessage(error)}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(failures.join("; "));
      }
    },

    /**
     * Removes console cards and their inbox rows; the normalized procurements
     * row stays as history.
     */
    async removeCases(ids: readonly string[]): Promise<void> {
      if (ids.length === 0) return;
      await db.delete(specialistInbox).where(inArray(specialistInbox.procurementId, [...ids]));
      await db.delete(specialistCases).where(inArray(specialistCases.id, [...ids]));
    },

    async loadInbox(): Promise<InboxFixtureItemValue[]> {
      const rows = await db
        .select()
        .from(specialistInbox)
        .orderBy(specialistInbox.detectedAt, specialistInbox.id);
      return rows.map((row) => InboxFixtureItem.parse(row.item));
    },

    async saveInbox(items: readonly InboxFixtureItemValue[]): Promise<void> {
      const now = new Date().toISOString();
      for (const raw of items) {
        const item = InboxFixtureItem.parse(raw);
        await db
          .insert(specialistInbox)
          .values({
            id: item.change.id,
            procurementId: item.change.procurementId,
            item,
            detectedAt: item.change.detectedAt,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: specialistInbox.id,
            set: { procurementId: item.change.procurementId, item, updatedAt: now },
          });
      }
    },
  };
}

/** Drops NUL bytes that PostgreSQL rejects inside jsonb. */
export function jsonbSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) =>
      typeof nested === "string" ? nested.replaceAll("\u0000", "") : nested,
    ),
  ) as T;
}

/**
 * catalog.procurements() can list a case and an inbox stub for the same
 * source. The unique index on source_procurement_id allows only one row.
 */
export function uniqueBySource(
  cards: readonly SpecialistProcurementCardValue[],
): SpecialistProcurementCardValue[] {
  const chosen = new Map<string, SpecialistProcurementCardValue>();
  for (const card of cards) {
    const previous = chosen.get(card.sourceProcurementId);
    if (previous === undefined || preferCase(card, previous)) {
      chosen.set(card.sourceProcurementId, card);
    }
  }
  return [...chosen.values()];
}

function preferCase(
  candidate: SpecialistProcurementCardValue,
  previous: SpecialistProcurementCardValue,
): boolean {
  if (candidate.documents.length !== previous.documents.length) {
    return candidate.documents.length > previous.documents.length;
  }
  return candidate.sourceCard !== undefined && previous.sourceCard === undefined;
}

export function postgresErrorMessage(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === "object") {
      const record = current as {
        code?: unknown;
        constraint?: unknown;
        message?: unknown;
        cause?: unknown;
      };
      const code = typeof record.code === "string" ? record.code : undefined;
      const constraint = typeof record.constraint === "string" ? record.constraint : undefined;
      const message = typeof record.message === "string" ? record.message : undefined;
      if (code !== undefined || constraint !== undefined) {
        return [code, constraint, message]
          .filter((part) => part !== undefined && part.length > 0)
          .join(" ");
      }
      current = record.cause;
      continue;
    }
    break;
  }
  return error instanceof Error ? error.message : String(error);
}

function postgresConstraint(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === "object") {
      const record = current as { constraint?: unknown; cause?: unknown };
      if (typeof record.constraint === "string") return record.constraint;
      current = record.cause;
      continue;
    }
    break;
  }
  return undefined;
}

async function saveSpecialistCase(db: Database, card: SpecialistProcurementCardValue): Promise<void> {
  const parsed = SpecialistProcurementCard.parse(jsonbSafe(card));
  const now = new Date().toISOString();
  try {
    await db
      .insert(specialistCases)
      .values({
        id: parsed.id,
        sourceProcurementId: parsed.sourceProcurementId,
        card: parsed,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: specialistCases.id,
        set: {
          sourceProcurementId: parsed.sourceProcurementId,
          card: parsed,
          updatedAt: now,
        },
      });
  } catch (error) {
    if (postgresConstraint(error) !== "specialist_cases_source_uq") throw error;
    await db
      .update(specialistCases)
      .set({ card: parsed, updatedAt: now })
      .where(eq(specialistCases.sourceProcurementId, parsed.sourceProcurementId));
  }
  try {
    await upsertProcurementHashes(db, parsed, now);
  } catch {
    // Hash tables are derived; a check/enum failure there must not drop the console card.
  }
}

async function upsertProcurementHashes(
  db: Database,
  card: SpecialistProcurementCardValue,
  now: string,
): Promise<void> {
  const sourceId = card.live ? "goszakupki_by" : "fixture";
  const hashed = card.documents.some((item) => item.hash !== undefined);
  const procurementRows = await db
    .insert(procurements)
    .values({
      id: card.id,
      sourceId,
      sourceRecordId: card.sourceProcurementId,
      canonicalUrl: card.url,
      title: card.title,
      kind: "other",
      status: card.status,
      sourceStatus: card.statusLabel,
      stage: hashed ? "documents_downloaded" : "discovered",
      lastSeenAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [procurements.sourceId, procurements.sourceRecordId],
      set: {
        canonicalUrl: card.url,
        title: card.title,
        status: card.status,
        sourceStatus: card.statusLabel,
        stage: hashed ? "documents_downloaded" : "discovered",
        lastSeenAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: procurements.id });
  const procurementId = procurementRows[0]?.id;
  if (procurementId === undefined) return;

  for (const document of card.documents) {
    await upsertDocumentHash(db, procurementId, document, now);
  }
}

function documentMimeType(document: SpecialistCaseDocument): string {
  const note = document.note ?? "";
  return note.includes("/") ? note.slice(0, 255) : "application/octet-stream";
}

async function upsertDocumentHash(
  db: Database,
  procurementId: string,
  document: SpecialistCaseDocument,
  now: string,
): Promise<void> {
  const hash = document.hash;
  if (hash === undefined) return;
  const existing = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.procurementId, procurementId), eq(documents.sourceUrl, document.sourceUrl)))
    .limit(1);
  let documentId = existing[0]?.id;
  if (documentId === undefined) {
    const inserted = await db
      .insert(documents)
      .values({
        procurementId,
        name: document.name,
        sourceUrl: document.sourceUrl,
        mimeType: documentMimeType(document),
        downloadUrl: document.downloadUrl,
        sizeBytes: pgInt(document.sizeBytes),
        status: document.status,
        discoveredAt: now,
      })
      .returning({ id: documents.id });
    documentId = inserted[0]?.id;
  }
  if (documentId === undefined) return;

  const versions = await db
    .select({ version: documentVersions.version, hash: documentVersions.hash })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId));
  if (versions.some((row) => row.hash === hash)) {
    await db
      .update(documents)
      .set({
        name: document.name,
        mimeType: documentMimeType(document),
        downloadUrl: document.downloadUrl,
        sizeBytes: pgInt(document.sizeBytes),
        status: document.status,
      })
      .where(eq(documents.id, documentId));
    return;
  }

  const nextVersion = versions.reduce((max, row) => Math.max(max, row.version), 0) + 1;
  const inserted = await db
    .insert(documentVersions)
    .values({
      documentId,
      version: nextVersion,
      hash,
      sizeBytes: pgInt(document.sizeBytes) ?? 0,
      downloadedAt: now,
      storageKey: blobStorageKey(hash),
      pageCount: pgInt(document.extraction?.pageCount),
      extractedTextLength: pgInt(document.extraction?.letterCount),
      ocrApplied: document.extraction?.ocrApplied ?? false,
    })
    .returning({ id: documentVersions.id });
  const versionId = inserted[0]?.id;
  await db
    .update(documents)
    .set({
      name: document.name,
      mimeType: documentMimeType(document),
      downloadUrl: document.downloadUrl,
      sizeBytes: pgInt(document.sizeBytes),
      status: document.status,
      ...(versionId === undefined ? {} : { currentVersionId: versionId }),
    })
    .where(eq(documents.id, documentId));
}

function pgInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(Math.trunc(value), 0), 2_147_483_647);
}
