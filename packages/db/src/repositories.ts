import type { ChangeEvent, JobRun, ProcedureCard, RawArtifact } from "@procurement/contracts";
import { and, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  changeEvents,
  domainProfiles,
  jobRuns,
  procurements,
  rawArtifacts,
} from "./schema.js";

export function createRepositories(db: Database) {
  return {
    domainProfiles: {
      listActive: async (companyId: string) =>
        db
          .select()
          .from(domainProfiles)
          .where(
            and(
              eq(domainProfiles.companyId, companyId),
              eq(domainProfiles.enabled, true),
              eq(domainProfiles.archived, false),
            ),
          ),
    },
    procurements: {
      upsertCard: async (card: ProcedureCard) => {
        const rows = await db
          .insert(procurements)
          .values({
            sourceId: card.sourceId,
            sourceRecordId: card.sourceProcurementId,
            canonicalUrl: card.url,
            pageFamily: card.pageFamily,
            title: card.title,
            kind: card.kind,
            status: card.status,
            sourceStatus: card.sourceStatus,
            amount: card.amount,
            publishedAt: card.publishedAt,
            bidsDeadline: card.bidsDeadline,
            rawFields: card.rawFields,
            lastSeenAt: card.fetchedAt,
          })
          .onConflictDoUpdate({
            target: [procurements.sourceId, procurements.sourceRecordId],
            set: {
              canonicalUrl: card.url,
              pageFamily: card.pageFamily,
              title: card.title,
              kind: card.kind,
              status: card.status,
              sourceStatus: card.sourceStatus,
              amount: card.amount,
              publishedAt: card.publishedAt,
              bidsDeadline: card.bidsDeadline,
              rawFields: card.rawFields,
              lastSeenAt: card.fetchedAt,
              updatedAt: card.fetchedAt,
            },
          })
          .returning();
        const row = rows[0];
        if (row === undefined) throw new Error("procurement upsert returned no row");
        return row;
      },
      addRawArtifact: async (artifact: RawArtifact) =>
        db.insert(rawArtifacts).values({
          id: artifact.id,
          procurementId: artifact.procurementId,
          kind: artifact.kind,
          hash: artifact.hash,
          storageKey: artifact.storageKey,
          contentType: artifact.contentType,
          pageFamily: artifact.pageFamily,
          capturedAt: artifact.capturedAt,
        }).onConflictDoNothing(),
      appendChange: async (eventKey: string, event: ChangeEvent) =>
        db
          .insert(changeEvents)
          .values({
            id: event.id,
            eventKey,
            procurementId: event.procurementId,
            kind: event.kind,
            field: event.field,
            previous: event.previous,
            current: event.current,
            documentId: event.documentId,
            previousVersionId: event.previousVersionId,
            currentVersionId: event.currentVersionId,
            detectedAt: event.detectedAt,
            urgent: event.urgent,
          })
          .onConflictDoNothing(),
    },
    jobs: {
      createOnce: async (job: JobRun) =>
        db
          .insert(jobRuns)
          .values({
            id: job.id,
            kind: job.kind,
            status: job.status,
            idempotencyKey: job.idempotencyKey,
            payload: job.payload,
            result: job.result,
            error: job.error,
            attempt: job.attempt,
            checkpoint: job.checkpoint,
            requestId: job.requestId,
            taskId: job.taskId,
            intentId: job.intentId,
            domainProfileId: job.domainProfileId,
            procurementId: job.procurementId,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
          })
          .onConflictDoNothing({ target: jobRuns.idempotencyKey })
          .returning(),
    },
  };
}
