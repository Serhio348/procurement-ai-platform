import {
  SpecialistProcurementCard,
  SpecialistWorkspaceState,
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
      return rows.map((row) => SpecialistProcurementCard.parse(row.card));
    },

    async saveCases(cards: readonly SpecialistProcurementCardValue[]): Promise<void> {
      for (const card of cards) {
        await saveSpecialistCase(db, card);
      }
    },

    /** Removes console cards only; the normalized procurements row stays as history. */
    async removeCases(ids: readonly string[]): Promise<void> {
      if (ids.length === 0) return;
      await db.delete(specialistCases).where(inArray(specialistCases.id, [...ids]));
    },
  };
}

async function saveSpecialistCase(db: Database, card: SpecialistProcurementCardValue): Promise<void> {
  const parsed = SpecialistProcurementCard.parse(card);
  const now = new Date().toISOString();
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
  await upsertProcurementHashes(db, parsed, now);
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
        sizeBytes: document.sizeBytes,
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
        sizeBytes: document.sizeBytes,
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
      sizeBytes: document.sizeBytes ?? 0,
      downloadedAt: now,
      storageKey: blobStorageKey(hash),
      pageCount: document.extraction?.pageCount,
      extractedTextLength: document.extraction?.letterCount,
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
      sizeBytes: document.sizeBytes,
      status: document.status,
      ...(versionId === undefined ? {} : { currentVersionId: versionId }),
    })
    .where(eq(documents.id, documentId));
}
