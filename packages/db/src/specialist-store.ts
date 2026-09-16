import {
  InboxFixtureItem,
  SpecialistProcurementCard,
  SpecialistWorkingProfile,
  SpecialistWorkspaceState,
  type InboxFixtureItem as InboxFixtureItemValue,
  type SpecialistCaseDocument,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
  type SpecialistProcurementListTab,
  type SpecialistTriageKind,
  type SpecialistWorkspaceState as SpecialistWorkspaceStateValue,
} from "@procurement/contracts";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  documentVersions,
  documents,
  procurements,
  workspaceDecisions,
  workspaceInbox,
  workspaceMembers,
  workspaceProcurementProfiles,
  workspaceProcurements,
  workspaceProfiles,
  workspaceReviewVerdicts,
  workspaceSettings,
  workspaces,
} from "./schema.js";
import { withRlsBypass, withUser, withWorkspace } from "./workspace-scope.js";

export const DEFAULT_SPECIALIST_WORKSPACE_ID = "console";
export const PERSONAL_WORKSPACE_BACKFILL_ID = "personal_workspaces.v1";
export const DEFAULT_CASE_LIST_LIMIT = 100;

function searchIdsByProfileFromSettings(
  settings: Record<string, unknown> | null | undefined,
): Record<string, string[]> {
  if (settings === undefined || settings === null) return {};
  const raw = settings["searchIdsByProfile"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [profileId, ids] of Object.entries(raw)) {
    if (!Array.isArray(ids)) continue;
    out[profileId] = ids.filter((item): item is string => typeof item === "string");
  }
  return out;
}

export interface SpecialistCaseListQuery {
  tab?: SpecialistProcurementListTab;
  limit?: number;
  offset?: number;
  liveOnly?: boolean;
  rejectedSourceIds?: readonly string[];
}

export interface SpecialistCaseListPage {
  items: SpecialistProcurementCardValue[];
  total: number;
}

export interface SpecialistCabinetCounts {
  profileCount: number;
  mineCount: number;
  archiveCount: number;
  trashCount: number;
}

/** Object-store key for bytes. The sha256 itself lives on document_versions.hash. */
export function blobStorageKey(hash: string): string {
  return `blobs/${hash}`;
}

export function createSpecialistStore(db: Database) {
  return {
    async personalWorkspaceId(userId: string): Promise<string | undefined> {
      return withUser(db, userId, async (tx) => {
        const rows = await tx
          .select({ id: workspaces.id })
          .from(workspaceMembers)
          .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
          .where(and(eq(workspaceMembers.userId, userId), eq(workspaces.kind, "personal")))
          .limit(1);
        return rows[0]?.id;
      });
    },

    async ensurePersonalWorkspace(userId: string, name = "Личный кабинет"): Promise<string> {
      const existing = await this.personalWorkspaceId(userId);
      if (existing !== undefined) return existing;
      const workspaceId = globalThis.crypto.randomUUID();
      const profileId = globalThis.crypto.randomUUID();
      const now = new Date().toISOString();
      await withWorkspace(db, workspaceId, async (tx) => {
        await tx.insert(workspaces).values({
          id: workspaceId,
          kind: "personal",
          name,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(workspaceMembers).values({
          workspaceId,
          userId,
          role: "owner",
          createdAt: now,
        });
        await tx.insert(workspaceProfiles).values({
          id: profileId,
          workspaceId,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(workspaceSettings).values({
          workspaceId,
          activeProfileId: profileId,
          updatedAt: now,
        });
      }, userId);
      return workspaceId;
    },

    async listWorkspaceIds(): Promise<string[]> {
      return withRlsBypass(db, async (tx) => {
        const rows = await tx.select({ id: workspaces.id }).from(workspaces);
        return rows.map((row) => row.id);
      });
    },

    async summarizeCabinets(
      workspaceIds: readonly string[],
    ): Promise<Map<string, SpecialistCabinetCounts>> {
      const summaries = new Map<string, SpecialistCabinetCounts>();
      for (const workspaceId of workspaceIds) {
        summaries.set(workspaceId, {
          profileCount: 0,
          mineCount: 0,
          archiveCount: 0,
          trashCount: 0,
        });
      }
      if (workspaceIds.length === 0) return summaries;
      const ids = [...workspaceIds];
      return withRlsBypass(db, async (tx) => {
        const profileRows = await tx
          .select({
            workspaceId: workspaceProfiles.workspaceId,
            n: count(),
          })
          .from(workspaceProfiles)
          .where(inArray(workspaceProfiles.workspaceId, ids))
          .groupBy(workspaceProfiles.workspaceId);
        for (const row of profileRows) {
          const current = summaries.get(row.workspaceId);
          if (current !== undefined) current.profileCount = Number(row.n);
        }
        const caseRows = await tx
          .select({
            workspaceId: workspaceProcurements.workspaceId,
            mine: sql<number>`cast(count(*) filter (where ${workspaceProcurements.triage} in ('monitor', 'participate') and ${workspaceProcurements.archived} = false) as integer)`,
            archive: sql<number>`cast(count(*) filter (where ${workspaceProcurements.archived} = true and ${workspaceProcurements.triage} is distinct from 'reject') as integer)`,
            trash: sql<number>`cast(count(*) filter (where ${workspaceProcurements.triage} = 'reject') as integer)`,
          })
          .from(workspaceProcurements)
          .where(inArray(workspaceProcurements.workspaceId, ids))
          .groupBy(workspaceProcurements.workspaceId);
        for (const row of caseRows) {
          const current = summaries.get(row.workspaceId);
          if (current === undefined) continue;
          current.mineCount = Number(row.mine);
          current.archiveCount = Number(row.archive);
          current.trashCount = Number(row.trash);
        }
        return summaries;
      });
    },

    async listWatchingWorkspaceIds(): Promise<string[]> {
      return withRlsBypass(db, async (tx) => {
        const rows = await tx
          .selectDistinct({ workspaceId: workspaceProfiles.workspaceId })
          .from(workspaceProfiles)
          .where(eq(workspaceProfiles.watchNewProcurements, true));
        return rows.map((row) => row.workspaceId);
      });
    },

    async loadWorkspace(workspaceId: string): Promise<SpecialistWorkspaceStateValue | undefined> {
      return withWorkspace(db, workspaceId, async (tx) => {
        const settingRows = await tx
          .select()
          .from(workspaceSettings)
          .where(eq(workspaceSettings.workspaceId, workspaceId))
          .limit(1);
        const profileRows = await tx
          .select()
          .from(workspaceProfiles)
          .where(eq(workspaceProfiles.workspaceId, workspaceId));
        if (profileRows.length === 0) return undefined;
        const decisionRows = await tx
          .select()
          .from(workspaceDecisions)
          .where(eq(workspaceDecisions.workspaceId, workspaceId));
        const verdictRows = await tx
          .select()
          .from(workspaceReviewVerdicts)
          .where(eq(workspaceReviewVerdicts.workspaceId, workspaceId));
        const inboxRows = await tx
          .select()
          .from(workspaceInbox)
          .where(eq(workspaceInbox.workspaceId, workspaceId));
        const caseRows = await tx
          .select({
            sourceProcurementId: workspaceProcurements.sourceProcurementId,
            archived: workspaceProcurements.archived,
          })
          .from(workspaceProcurements)
          .where(eq(workspaceProcurements.workspaceId, workspaceId));
        const profiles = profileRows.map((row) =>
          SpecialistWorkingProfile.parse({
            id: row.id,
            name: row.name,
            purpose: row.purpose,
            description: row.description,
            keywords: row.keywords,
            excludeKeywords: row.excludeKeywords,
            statuses: row.statuses,
            excludeSingleSource: row.excludeSingleSource,
            filters: row.filters,
            watchNewProcurements: row.watchNewProcurements,
            ...(row.lastDiscoveryAt === null
              ? {}
              : { lastDiscoveryAt: toIsoDateTime(row.lastDiscoveryAt) }),
          }),
        );
        const active =
          profiles.find((item) => item.id === settingRows[0]?.activeProfileId) ?? profiles[0];
        if (active === undefined) return undefined;
        return SpecialistWorkspaceState.parse({
          profiles,
          activeProfileId: active.id,
          decisions: decisionRows.map((row) => ({
            sourceProcurementId: row.sourceProcurementId,
            kind: row.kind,
            madeAt: toIsoDateTime(row.madeAt),
          })),
          dismissedInboxIds: inboxRows
            .filter((row) => row.state !== "open")
            .map((row) => {
              const parsed = InboxFixtureItem.safeParse(row.item);
              return parsed.success ? parsed.data.change.id : row.eventKey;
            }),
          reviewedIrrelevant: verdictRows.map((row) => ({
            profileId: row.profileId,
            sourceProcurementId: row.sourceProcurementId,
            decidedAt: toIsoDateTime(row.decidedAt),
            algorithmVersion: row.algorithmVersion,
          })),
          archivedSourceIds: caseRows
            .filter((row) => row.archived)
            .map((row) => row.sourceProcurementId),
          searchIdsByProfile: searchIdsByProfileFromSettings(settingRows[0]?.settings),
        });
      });
    },

    async saveWorkspace(
      snapshot: SpecialistWorkspaceStateValue,
      workspaceId: string,
    ): Promise<void> {
      const state = SpecialistWorkspaceState.parse(snapshot);
      const now = new Date().toISOString();
      await withWorkspace(db, workspaceId, async (tx) => {
        const existingProfiles = await tx
          .select({ id: workspaceProfiles.id })
          .from(workspaceProfiles)
          .where(eq(workspaceProfiles.workspaceId, workspaceId));
        const nextIds = new Set(state.profiles.map((item) => item.id));
        const removed = existingProfiles
          .map((row) => row.id)
          .filter((id) => !nextIds.has(id));
        if (removed.length > 0) {
          await tx.delete(workspaceProfiles).where(inArray(workspaceProfiles.id, removed));
        }
        for (const profile of state.profiles) {
          await tx
            .insert(workspaceProfiles)
            .values({
              id: profile.id,
              workspaceId,
              name: profile.name,
              purpose: profile.purpose,
              description: profile.description,
              keywords: profile.keywords,
              excludeKeywords: profile.excludeKeywords,
              statuses: profile.statuses,
              excludeSingleSource: profile.excludeSingleSource,
              filters: profile.filters,
              watchNewProcurements: profile.watchNewProcurements,
              lastDiscoveryAt: profile.lastDiscoveryAt,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: workspaceProfiles.id,
              set: {
                name: profile.name,
                purpose: profile.purpose,
                description: profile.description,
                keywords: profile.keywords,
                excludeKeywords: profile.excludeKeywords,
                statuses: profile.statuses,
                excludeSingleSource: profile.excludeSingleSource,
                filters: profile.filters,
                watchNewProcurements: profile.watchNewProcurements,
                lastDiscoveryAt: profile.lastDiscoveryAt,
                updatedAt: now,
              },
            });
        }
        await tx
          .insert(workspaceSettings)
          .values({
            workspaceId,
            activeProfileId: state.activeProfileId,
            settings: { searchIdsByProfile: state.searchIdsByProfile },
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: workspaceSettings.workspaceId,
            set: {
              activeProfileId: state.activeProfileId,
              settings: { searchIdsByProfile: state.searchIdsByProfile },
              updatedAt: now,
            },
          });

        await tx
          .delete(workspaceReviewVerdicts)
          .where(eq(workspaceReviewVerdicts.workspaceId, workspaceId));
        for (const verdict of state.reviewedIrrelevant) {
          await tx.insert(workspaceReviewVerdicts).values({
            workspaceId,
            profileId: verdict.profileId,
            sourceProcurementId: verdict.sourceProcurementId,
            decidedAt: verdict.decidedAt,
            algorithmVersion: verdict.algorithmVersion,
          });
        }

        const existingDecisions = await tx
          .select()
          .from(workspaceDecisions)
          .where(eq(workspaceDecisions.workspaceId, workspaceId));
        const seen = new Set(
          existingDecisions.map(
            (row) => `${row.sourceProcurementId}:${row.kind}:${row.madeAt}`,
          ),
        );
        for (const decision of state.decisions) {
          const key = `${decision.sourceProcurementId}:${decision.kind}:${decision.madeAt}`;
          if (seen.has(key)) continue;
          seen.add(key);
          await tx.insert(workspaceDecisions).values({
            workspaceId,
            sourceProcurementId: decision.sourceProcurementId,
            kind: decision.kind,
            madeAt: decision.madeAt,
          });
        }

        const archived = new Set(state.archivedSourceIds);
        const caseRows = await tx
          .select({
            id: workspaceProcurements.id,
            sourceProcurementId: workspaceProcurements.sourceProcurementId,
            archived: workspaceProcurements.archived,
          })
          .from(workspaceProcurements)
          .where(eq(workspaceProcurements.workspaceId, workspaceId));
        for (const row of caseRows) {
          const nextArchived = archived.has(row.sourceProcurementId);
          if (row.archived === nextArchived) continue;
          await tx
            .update(workspaceProcurements)
            .set({ archived: nextArchived, updatedAt: now })
            .where(eq(workspaceProcurements.id, row.id));
        }

        const dismissed = new Set(state.dismissedInboxIds);
        const inboxRows = await tx
          .select({ id: workspaceInbox.id, eventKey: workspaceInbox.eventKey, item: workspaceInbox.item })
          .from(workspaceInbox)
          .where(eq(workspaceInbox.workspaceId, workspaceId));
        for (const row of inboxRows) {
          const parsed = InboxFixtureItem.safeParse(row.item);
          const changeId = parsed.success ? parsed.data.change.id : row.eventKey;
          const closed = dismissed.has(changeId);
          await tx
            .update(workspaceInbox)
            .set({
              state: closed ? "dismissed" : "open",
              resolvedAt: closed ? now : null,
              updatedAt: now,
            })
            .where(eq(workspaceInbox.id, row.id));
        }
      });
    },

    async loadCases(workspaceId: string): Promise<SpecialistProcurementCardValue[]> {
      return withWorkspace(db, workspaceId, async (tx) => {
        const rows = await tx
          .select()
          .from(workspaceProcurements)
          .where(eq(workspaceProcurements.workspaceId, workspaceId));
        const cards: SpecialistProcurementCardValue[] = [];
        for (const row of rows) {
          const parsed = parseCaseRow(row);
          if (parsed !== undefined) cards.push(parsed);
        }
        return cards;
      });
    },

    async listCases(
      workspaceId: string,
      query: SpecialistCaseListQuery = {},
    ): Promise<SpecialistCaseListPage> {
      const tab = query.tab ?? "listed";
      const limit = query.limit ?? DEFAULT_CASE_LIST_LIMIT;
      const offset = query.offset ?? 0;
      return withWorkspace(db, workspaceId, async (tx) => {
        const filters = caseListFilters(workspaceId, { ...query, tab });
        const totalRows = await tx
          .select({ n: count() })
          .from(workspaceProcurements)
          .where(and(...filters));
        const rows = await tx
          .select({
            id: workspaceProcurements.id,
            procurementId: workspaceProcurements.procurementId,
            triage: workspaceProcurements.triage,
            foundAs: workspaceProcurements.foundAs,
            archived: workspaceProcurements.archived,
            lastSeenAt: workspaceProcurements.lastSeenAt,
            card: tileCardExpression(),
          })
          .from(workspaceProcurements)
          .where(and(...filters))
          .orderBy(desc(workspaceProcurements.updatedAt), asc(workspaceProcurements.id))
          .limit(limit)
          .offset(offset);
        const items: SpecialistProcurementCardValue[] = [];
        for (const row of rows) {
          const parsed = parseCaseRow(row);
          if (parsed !== undefined) items.push(parsed);
        }
        return { items, total: Number(totalRows[0]?.n ?? 0) };
      });
    },

    async listTrashIds(workspaceId: string): Promise<string[]> {
      return withWorkspace(db, workspaceId, async (tx) => {
        const rows = await tx
          .select({ id: workspaceProcurements.id })
          .from(workspaceProcurements)
          .where(
            and(
              eq(workspaceProcurements.workspaceId, workspaceId),
              eq(workspaceProcurements.triage, "reject"),
            ),
          );
        return rows.map((row) => row.id);
      });
    },

    async getCase(workspaceId: string, id: string): Promise<SpecialistProcurementCardValue | undefined> {
      return withWorkspace(db, workspaceId, async (tx) => {
        const rows = await tx
          .select()
          .from(workspaceProcurements)
          .where(and(eq(workspaceProcurements.workspaceId, workspaceId), caseIdentityMatch(id)))
          .limit(1);
        return rows[0] === undefined ? undefined : parseCaseRow(rows[0]);
      });
    },

    async findCaseBySource(
      workspaceId: string,
      sourceProcurementId: string,
    ): Promise<SpecialistProcurementCardValue | undefined> {
      return withWorkspace(db, workspaceId, async (tx) => {
        const rows = await tx
          .select()
          .from(workspaceProcurements)
          .where(
            and(
              eq(workspaceProcurements.workspaceId, workspaceId),
              eq(workspaceProcurements.sourceProcurementId, sourceProcurementId),
            ),
          )
          .limit(1);
        return rows[0] === undefined ? undefined : parseCaseRow(rows[0]);
      });
    },

    async loadCasesBySources(
      workspaceId: string,
      sourceIds: readonly string[],
    ): Promise<Map<string, SpecialistProcurementCardValue>> {
      const found = new Map<string, SpecialistProcurementCardValue>();
      if (sourceIds.length === 0) return found;
      return withWorkspace(db, workspaceId, async (tx) => {
        const rows = await tx
          .select()
          .from(workspaceProcurements)
          .where(
            and(
              eq(workspaceProcurements.workspaceId, workspaceId),
              inArray(workspaceProcurements.sourceProcurementId, [...sourceIds]),
            ),
          );
        for (const row of rows) {
          const parsed = parseCaseRow(row);
          if (parsed !== undefined) found.set(parsed.sourceProcurementId, parsed);
        }
        return found;
      });
    },

    async listWatchedCases(
      workspaceId: string,
      limit: number,
    ): Promise<SpecialistProcurementCardValue[]> {
      if (limit <= 0) return [];
      return withWorkspace(db, workspaceId, async (tx) => {
        const rows = await tx
          .select()
          .from(workspaceProcurements)
          .where(
            and(
              eq(workspaceProcurements.workspaceId, workspaceId),
              eq(workspaceProcurements.archived, false),
              inArray(workspaceProcurements.triage, ["monitor", "participate"]),
              sql`${workspaceProcurements.card} ->> 'live' = 'true'`,
            ),
          )
          .orderBy(
            sql`case when ${workspaceProcurements.watchSnapshot} is null then 0 else 1 end`,
            asc(sql`${workspaceProcurements.watchSnapshot} ->> 'capturedAt'`),
            asc(workspaceProcurements.lastSeenAt),
          )
          .limit(limit);
        const items: SpecialistProcurementCardValue[] = [];
        for (const row of rows) {
          const parsed = parseCaseRow(row);
          if (parsed !== undefined) items.push(parsed);
        }
        return items;
      });
    },

    async listStaleUndecidedIds(
      workspaceId: string,
      _cutoffIso: string,
      keepSourceIds: readonly string[],
      keepIds: readonly string[] = [],
    ): Promise<string[]> {
      return withWorkspace(db, workspaceId, async (tx) => {
        const filters = [
          eq(workspaceProcurements.workspaceId, workspaceId),
          isNull(workspaceProcurements.triage),
          or(isNull(workspaceProcurements.foundAs), ne(workspaceProcurements.foundAs, "review")),
        ];
        if (keepSourceIds.length > 0) {
          filters.push(notInArray(workspaceProcurements.sourceProcurementId, [...keepSourceIds]));
        }
        if (keepIds.length > 0) {
          const kept = [...keepIds];
          filters.push(
            sql`not (${caseIdentityMatch(kept)})`,
          );
        }
        const rows = await tx
          .select({ id: workspaceProcurements.id })
          .from(workspaceProcurements)
          .where(and(...filters));
        return rows.map((row) => row.id);
      });
    },

    async findDocument(
      workspaceId: string,
      hash: string,
    ): Promise<SpecialistCaseDocument | undefined> {
      return withWorkspace(db, workspaceId, async (tx) => {
        const rows = await tx
          .select({ card: workspaceProcurements.card })
          .from(workspaceProcurements)
          .where(
            and(
              eq(workspaceProcurements.workspaceId, workspaceId),
              sql`exists (
                select 1
                from jsonb_array_elements(${workspaceProcurements.card} -> 'documents') as document
                where document ->> 'hash' = ${hash}
              )`,
            ),
          )
          .limit(1);
        const parsed = SpecialistProcurementCard.safeParse(rows[0]?.card);
        if (!parsed.success) return undefined;
        return parsed.data.documents.find((item) => item.hash === hash);
      });
    },

    async saveCases(
      cards: readonly SpecialistProcurementCardValue[],
      workspaceId: string,
    ): Promise<void> {
      const failures: string[] = [];
      for (const card of uniqueBySource(cards)) {
        try {
          await withWorkspace(db, workspaceId, async (tx) => {
            await saveWorkspaceCase(tx, workspaceId, card);
          });
        } catch (error) {
          failures.push(`${card.sourceProcurementId}: ${postgresErrorMessage(error)}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(failures.join("; "));
      }
    },

    async removeCases(ids: readonly string[], workspaceId: string): Promise<void> {
      if (ids.length === 0) return;
      const idList = [...ids];
      // Delete children first. CASCADE + RLS on workspace_procurement_profiles
      // joins back to the parent row; once the parent is gone the policy
      // hides the child and the whole delete is rolled back.
      await withWorkspace(db, workspaceId, async (tx) => {
        const matched = await tx
          .select({ id: workspaceProcurements.id })
          .from(workspaceProcurements)
          .where(and(eq(workspaceProcurements.workspaceId, workspaceId), caseIdentityMatch(idList)));
        const rowIds = matched.map((row) => row.id);
        if (rowIds.length === 0) return;
        await tx
          .delete(workspaceProcurementProfiles)
          .where(inArray(workspaceProcurementProfiles.workspaceProcurementId, rowIds));
        await tx
          .delete(workspaceInbox)
          .where(
            and(
              eq(workspaceInbox.workspaceId, workspaceId),
              inArray(workspaceInbox.workspaceProcurementId, rowIds),
            ),
          );
        await tx
          .delete(workspaceProcurements)
          .where(
            and(
              eq(workspaceProcurements.workspaceId, workspaceId),
              inArray(workspaceProcurements.id, rowIds),
            ),
          );
        const left = await tx
          .select({ id: workspaceProcurements.id })
          .from(workspaceProcurements)
          .where(
            and(
              eq(workspaceProcurements.workspaceId, workspaceId),
              inArray(workspaceProcurements.id, rowIds),
            ),
          );
        if (left.length > 0) {
          throw new Error(
            `workspace_procurements delete removed nothing: ${left.map((row) => row.id).join(", ")}`,
          );
        }
      });
    },

    async loadInbox(workspaceId: string): Promise<InboxFixtureItemValue[]> {
      return withWorkspace(db, workspaceId, async (tx) => {
        const rows = await tx
          .select()
          .from(workspaceInbox)
          .where(eq(workspaceInbox.workspaceId, workspaceId));
        return rows
          .sort((left, right) =>
            left.detectedAt === right.detectedAt
              ? left.id.localeCompare(right.id)
              : left.detectedAt.localeCompare(right.detectedAt),
          )
          .map((row) => InboxFixtureItem.parse(row.item));
      });
    },

    async saveInbox(
      items: readonly InboxFixtureItemValue[],
      workspaceId: string,
    ): Promise<void> {
      const now = new Date().toISOString();
      await withWorkspace(db, workspaceId, async (tx) => {
        const cases = await tx
          .select({
            id: workspaceProcurements.id,
            sourceProcurementId: workspaceProcurements.sourceProcurementId,
          })
          .from(workspaceProcurements)
          .where(eq(workspaceProcurements.workspaceId, workspaceId));
        const bySource = new Map(cases.map((row) => [row.sourceProcurementId, row.id]));
        const byId = new Set(cases.map((row) => row.id));
        for (const raw of items) {
          const item = InboxFixtureItem.parse(jsonbSafe(raw));
          const workspaceProcurementId =
            byId.has(item.change.procurementId)
              ? item.change.procurementId
              : bySource.get(item.procurement.sourceProcurementId);
          await tx
            .insert(workspaceInbox)
            .values({
              id: globalThis.crypto.randomUUID(),
              workspaceId,
              workspaceProcurementId,
              eventKey: item.change.id,
              item,
              state: "open",
              detectedAt: item.change.detectedAt,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [workspaceInbox.workspaceId, workspaceInbox.eventKey],
              set: {
                workspaceProcurementId,
                item,
                updatedAt: now,
              },
            });
        }
      });
    },

    async hasDocumentHash(workspaceId: string, hash: string): Promise<boolean> {
      return withWorkspace(db, workspaceId, async (tx) => {
        const rows = await tx
          .select({ hash: documentVersions.hash })
          .from(workspaceProcurements)
          .innerJoin(documents, eq(documents.procurementId, workspaceProcurements.procurementId))
          .innerJoin(documentVersions, eq(documentVersions.documentId, documents.id))
          .where(
            and(eq(workspaceProcurements.workspaceId, workspaceId), eq(documentVersions.hash, hash)),
          )
          .limit(1);
        return rows.length > 0;
      });
    },
  };
}

/**
 * Drizzle timestamptz `mode: "string"` returns Postgres wire format
 * (`2026-09-09 10:00:00+00`), which Zod IsoDateTime rejects.
 */
export function toIsoDateTime(value: string | Date): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error("Invalid timestamp");
    }
    return value.toISOString();
  }
  const withT = value.includes("T") ? value : value.replace(" ", "T");
  const withColonOffset = withT.replace(/([+-]\d{2})$/, "$1:00");
  const parsed = new Date(withColonOffset);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return parsed.toISOString();
}

type WorkspaceCaseRow = Pick<
  typeof workspaceProcurements.$inferSelect,
  "id" | "procurementId" | "triage" | "foundAs" | "archived" | "lastSeenAt"
> & { card: unknown };

/**
 * Tile lists must not pull the TOASTed parts of `card`: a page of 100 archived
 * cases carries whole ТЗ extracts and raw platform dumps. The detail route
 * reads the row in full.
 */
function tileCardExpression() {
  return sql<unknown>`${workspaceProcurements.card} #- '{documents}'::text[] #- '{actions}'::text[] #- '{missing}'::text[] #- '{extractNotes}'::text[] #- '{extractPreview}'::text[] #- '{reportMarkdown}'::text[] #- '{termsDetail}'::text[] #- '{termsEvidence}'::text[] #- '{paymentQuote}'::text[] #- '{sourceCard,parties}'::text[] #- '{sourceCard,lots}'::text[] #- '{sourceCard,rawFields}'::text[] #- '{sourceCard,externalIds}'::text[]`.as(
    "card",
  );
}

function parseCaseRow(row: WorkspaceCaseRow): SpecialistProcurementCardValue | undefined {
  const parsed = SpecialistProcurementCard.safeParse(row.card);
  if (!parsed.success) return undefined;
  // Keep the card id from JSON. The SQL row id is cabinet-local so two
  // workspaces can store the same source; swapping it here made search
  // return a second identity for a hit the session already had.
  return SpecialistProcurementCard.parse({
    ...parsed.data,
    canonicalProcurementId: row.procurementId,
    archived: row.archived,
    ...(row.triage === null ? {} : { triage: row.triage }),
    ...(row.foundAs === null ? {} : { foundAs: row.foundAs }),
    ...(row.lastSeenAt === null ? {} : { lastSeenAt: toIsoDateTime(row.lastSeenAt) }),
  });
}

function caseListFilters(workspaceId: string, query: SpecialistCaseListQuery) {
  const filters = [eq(workspaceProcurements.workspaceId, workspaceId)];
  const tab = query.tab ?? "listed";
  if (query.liveOnly === true) {
    filters.push(sql`${workspaceProcurements.card} ->> 'live' = 'true'`);
  }
  const rejected = query.rejectedSourceIds ?? [];
  if (rejected.length > 0) {
    filters.push(notInArray(workspaceProcurements.sourceProcurementId, [...rejected]));
  }
  const listed = or(
    isNull(workspaceProcurements.foundAs),
    ne(workspaceProcurements.foundAs, "review"),
    isNotNull(workspaceProcurements.triage),
  );
  if (tab === "trash") {
    return [eq(workspaceProcurements.workspaceId, workspaceId), eq(workspaceProcurements.triage, "reject")];
  }
  if (listed !== undefined) filters.push(listed);
  filters.push(
    or(isNull(workspaceProcurements.triage), ne(workspaceProcurements.triage, "reject"))!,
  );
  if (tab === "all") {
    filters.push(eq(workspaceProcurements.archived, false));
    filters.push(inArray(workspaceProcurements.triage, ["monitor", "participate"]));
  } else if (tab === "monitor") {
    filters.push(eq(workspaceProcurements.archived, false));
    filters.push(eq(workspaceProcurements.triage, "monitor"));
  } else if (tab === "participate") {
    filters.push(eq(workspaceProcurements.archived, false));
    filters.push(eq(workspaceProcurements.triage, "participate"));
  } else if (tab === "archive") {
    filters.push(eq(workspaceProcurements.archived, true));
  }
  return filters;
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
 * Persist may still see a decided case and an inbox stub for the same
 * source. The unique index on source_procurement_id allows only one row;
 * keep the decided card so a stub cannot wipe reject/monitor.
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
  const candidateRank = casePersistRank(candidate);
  const previousRank = casePersistRank(previous);
  if (candidateRank !== previousRank) return candidateRank > previousRank;
  if (candidate.documents.length !== previous.documents.length) {
    return candidate.documents.length > previous.documents.length;
  }
  return false;
}

function casePersistRank(card: SpecialistProcurementCardValue): number {
  if (card.triage === "monitor" || card.triage === "participate") return 3;
  if (card.triage === "reject") return 2;
  if (card.sourceCard !== undefined) return 1;
  return 0;
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

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === "object") {
      const record = current as { code?: unknown; cause?: unknown };
      if (record.code === "23505") return true;
      current = record.cause;
      continue;
    }
    break;
  }
  return false;
}

function caseIdentityMatch(ids: string | readonly string[]) {
  const idList = typeof ids === "string" ? [ids] : [...ids];
  return or(
    inArray(workspaceProcurements.id, idList),
    sql`(${workspaceProcurements.card}->>'id') in (${sql.join(
      idList.map((id) => sql`${id}`),
      sql`, `,
    )})`,
  );
}

type StoreTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export function caseListTimeShouldBump(
  previous:
    | { triage: string | null; archived: boolean; foundAs: string | null }
    | undefined,
  next: { triage?: string | undefined; archived?: boolean | undefined; foundAs?: string | undefined },
): boolean {
  if (previous === undefined) return true;
  return (
    previous.triage !== (next.triage ?? null) ||
    previous.archived !== (next.archived === true) ||
    previous.foundAs !== (next.foundAs ?? null)
  );
}

async function saveWorkspaceCase(
  tx: StoreTx,
  workspaceId: string,
  card: SpecialistProcurementCardValue,
): Promise<void> {
  const parsed = SpecialistProcurementCard.parse(jsonbSafe(card));
  const now = new Date().toISOString();
  const canonicalId = await upsertCanonicalProcurement(tx, parsed, now);
  const stored = SpecialistProcurementCard.parse({
    ...parsed,
    canonicalProcurementId: canonicalId,
  });
  const existing = await tx
    .select({
      id: workspaceProcurements.id,
      triage: workspaceProcurements.triage,
      archived: workspaceProcurements.archived,
      foundAs: workspaceProcurements.foundAs,
      updatedAt: workspaceProcurements.updatedAt,
    })
    .from(workspaceProcurements)
    .where(
      and(
        eq(workspaceProcurements.workspaceId, workspaceId),
        eq(workspaceProcurements.sourceProcurementId, stored.sourceProcurementId),
      ),
    )
    .limit(1);
  const previous = existing[0];
  const updatedAt =
    previous === undefined || caseListTimeShouldBump(previous, stored)
      ? now
      : toIsoDateTime(previous.updatedAt);
  // The API card id is global for a source record. The SQL row id is local
  // identity, otherwise two cabinets collide on workspace_procurements_pkey.
  let rowId = previous?.id ?? globalThis.crypto.randomUUID();
  const values = {
    id: rowId,
    workspaceId,
    procurementId: canonicalId,
    sourceProcurementId: stored.sourceProcurementId,
    triage: stored.triage,
    foundAs: stored.foundAs,
    archived: stored.archived,
    lastSeenAt: stored.lastSeenAt,
    watchSnapshot: stored.watchSnapshot,
    card: stored,
    updatedAt,
  };
  if (previous !== undefined) {
    await tx
      .update(workspaceProcurements)
      .set({
        procurementId: canonicalId,
        triage: stored.triage,
        foundAs: stored.foundAs,
        archived: stored.archived,
        lastSeenAt: stored.lastSeenAt,
        watchSnapshot: stored.watchSnapshot,
        card: stored,
        updatedAt,
      })
      .where(
        and(
          eq(workspaceProcurements.workspaceId, workspaceId),
          eq(workspaceProcurements.sourceProcurementId, stored.sourceProcurementId),
        ),
      );
  } else {
    try {
      await tx.insert(workspaceProcurements).values(values);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await tx
        .select({ id: workspaceProcurements.id })
        .from(workspaceProcurements)
        .where(
          and(
            eq(workspaceProcurements.workspaceId, workspaceId),
            eq(workspaceProcurements.sourceProcurementId, stored.sourceProcurementId),
          ),
        )
        .limit(1);
      if (raced[0] !== undefined) {
        rowId = raced[0].id;
        await tx
          .update(workspaceProcurements)
          .set({
            procurementId: canonicalId,
            triage: stored.triage,
            foundAs: stored.foundAs,
            archived: stored.archived,
            lastSeenAt: stored.lastSeenAt,
            watchSnapshot: stored.watchSnapshot,
            card: stored,
            updatedAt,
          })
          .where(eq(workspaceProcurements.id, rowId));
      } else {
        rowId = globalThis.crypto.randomUUID();
        await tx.insert(workspaceProcurements).values({ ...values, id: rowId });
      }
    }
  }
  await tx
    .delete(workspaceProcurementProfiles)
    .where(eq(workspaceProcurementProfiles.workspaceProcurementId, rowId));
  for (const profileId of stored.profileIds) {
    await tx
      .insert(workspaceProcurementProfiles)
      .values({ workspaceProcurementId: rowId, domainProfileId: profileId })
      .onConflictDoNothing();
  }
  try {
    await upsertDocumentHashes(tx, canonicalId, stored, now);
  } catch {
    // Hash tables are derived; a check/enum failure there must not drop the console card.
  }
}

async function upsertCanonicalProcurement(
  tx: StoreTx,
  card: SpecialistProcurementCardValue,
  now: string,
): Promise<string> {
  const sourceId = card.live ? "goszakupki_by" : "fixture";
  const hashed = card.documents.some((item) => item.hash !== undefined);
  const status = card.status;
  const rows = await tx
    .insert(procurements)
    .values({
      ...(card.canonicalProcurementId === undefined ? {} : { id: card.canonicalProcurementId }),
      sourceId,
      sourceRecordId: card.sourceProcurementId,
      canonicalUrl: card.url,
      title: card.title,
      kind: "other",
      status,
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
        status,
        sourceStatus: card.statusLabel,
        stage: hashed ? "documents_downloaded" : "discovered",
        lastSeenAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: procurements.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("canonical procurement upsert returned no row");
  return id;
}

async function upsertDocumentHashes(
  tx: StoreTx,
  procurementId: string,
  card: SpecialistProcurementCardValue,
  now: string,
): Promise<void> {
  for (const document of card.documents) {
    await upsertDocumentHash(tx, procurementId, document, now);
  }
}

function documentMimeType(document: SpecialistCaseDocument): string {
  const note = document.note ?? "";
  return note.includes("/") ? note.slice(0, 255) : "application/octet-stream";
}

async function upsertDocumentHash(
  tx: StoreTx,
  procurementId: string,
  document: SpecialistCaseDocument,
  now: string,
): Promise<void> {
  const hash = document.hash;
  if (hash === undefined) return;
  const existing = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.procurementId, procurementId), eq(documents.sourceUrl, document.sourceUrl)))
    .limit(1);
  let documentId = existing[0]?.id;
  if (documentId === undefined) {
    const inserted = await tx
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

  const versions = await tx
    .select({ version: documentVersions.version, hash: documentVersions.hash })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId));
  if (versions.some((row) => row.hash === hash)) {
    await tx
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
  const inserted = await tx
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
  await tx
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

export function latestTriage(
  decisions: readonly { sourceProcurementId: string; kind: SpecialistTriageKind }[],
  sourceProcurementId: string,
): SpecialistTriageKind | undefined {
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index];
    if (decision?.sourceProcurementId === sourceProcurementId) return decision.kind;
  }
  return undefined;
}
