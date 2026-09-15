import {
  InboxFixtureItem,
  SpecialistProcurementCard,
  SpecialistWorkingProfile,
  SpecialistWorkspaceState,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
} from "@procurement/contracts";
import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  authUsers,
  specialistCases,
  specialistInbox,
  specialistWorkspaces,
  workspaceBackfillRuns,
} from "./schema.js";
import { createSpecialistStore, PERSONAL_WORKSPACE_BACKFILL_ID } from "./specialist-store.js";
import { withRlsBypass } from "./workspace-scope.js";

export async function applyPersonalWorkspaceBackfill(db: Database): Promise<boolean> {
  const claimed = await withRlsBypass(db, async (tx) => {
    const rows = await tx
      .insert(workspaceBackfillRuns)
      .values({ id: PERSONAL_WORKSPACE_BACKFILL_ID })
      .onConflictDoNothing()
      .returning({ id: workspaceBackfillRuns.id });
    return rows.length > 0;
  });
  if (!claimed) return false;

  const legacy = await withRlsBypass(db, async (tx) => ({
    users: await tx.select().from(authUsers),
    workspace: await loadLegacyWorkspace(tx as unknown as Database),
    cases: await loadLegacyCases(tx as unknown as Database),
    inbox: await loadLegacyInbox(tx as unknown as Database),
  }));

  const store = createSpecialistStore(db);
  for (const user of legacy.users) {
    const workspaceId = await store.ensurePersonalWorkspace(user.id, user.name);
    if (user.accessStatus !== "active" || legacy.workspace === undefined) continue;
    const cloned = cloneWorkspaceState(legacy.workspace);
    const remappedCases = legacy.cases.map((card) => remapCase(card, cloned.profileMap));
    const remappedInbox = legacy.inbox.map((item) => remapInbox(item, remappedCases));
    await store.saveWorkspace(cloned.state, workspaceId);
    await store.saveCases(remappedCases, workspaceId);
    await store.saveInbox(remappedInbox, workspaceId);
  }
  return true;
}

async function loadLegacyWorkspace(db: Database): Promise<SpecialistWorkspaceState | undefined> {
  const rows = await db
    .select()
    .from(specialistWorkspaces)
    .where(eq(specialistWorkspaces.id, "console"))
    .limit(1);
  const snapshot = rows[0]?.snapshot;
  if (snapshot === undefined) return undefined;
  return parseLegacyWorkspace(snapshot);
}

function parseLegacyWorkspace(raw: unknown): SpecialistWorkspaceState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as {
    profiles?: unknown;
    profile?: unknown;
    activeProfileId?: unknown;
    decisions?: unknown;
    dismissedInboxIds?: unknown;
    reviewedIrrelevant?: unknown;
    archivedSourceIds?: unknown;
  };
  const profiles = Array.isArray(record.profiles)
    ? record.profiles.map((item) => SpecialistWorkingProfile.parse(item))
    : record.profile === undefined
      ? []
      : [SpecialistWorkingProfile.parse(record.profile)];
  if (profiles.length === 0) return undefined;
  const active =
    profiles.find((item) => item.id === record.activeProfileId) ?? profiles[0];
  if (active === undefined) return undefined;
  return SpecialistWorkspaceState.parse({
    profiles,
    activeProfileId: active.id,
    decisions: record.decisions ?? [],
    dismissedInboxIds: record.dismissedInboxIds ?? [],
    reviewedIrrelevant: record.reviewedIrrelevant ?? [],
    archivedSourceIds: record.archivedSourceIds ?? [],
  });
}

async function loadLegacyCases(db: Database): Promise<SpecialistProcurementCardValue[]> {
  const rows = await db.select().from(specialistCases);
  const cards: SpecialistProcurementCardValue[] = [];
  for (const row of rows) {
    const parsed = SpecialistProcurementCard.safeParse(row.card);
    if (parsed.success) cards.push(parsed.data);
  }
  return cards;
}

async function loadLegacyInbox(db: Database): Promise<InboxFixtureItem[]> {
  const rows = await db.select().from(specialistInbox);
  return rows.map((row) => InboxFixtureItem.parse(row.item));
}

function cloneWorkspaceState(state: SpecialistWorkspaceState): {
  state: SpecialistWorkspaceState;
  profileMap: Map<string, string>;
} {
  const profileMap = new Map<string, string>();
  const profiles = state.profiles.map((profile) => {
    const nextId = globalThis.crypto.randomUUID();
    profileMap.set(profile.id, nextId);
    return { ...profile, id: nextId };
  });
  const activeProfileId = profileMap.get(state.activeProfileId) ?? profiles[0]?.id;
  if (activeProfileId === undefined) {
    throw new Error("legacy workspace has no profiles");
  }
  return {
    profileMap,
    state: SpecialistWorkspaceState.parse({
      ...state,
      profiles,
      activeProfileId,
      reviewedIrrelevant: state.reviewedIrrelevant.map((item) => ({
        ...item,
        profileId: profileMap.get(item.profileId) ?? item.profileId,
      })),
      searchIdsByProfile: {},
    }),
  };
}

function remapCase(
  card: SpecialistProcurementCardValue,
  profileMap: Map<string, string>,
): SpecialistProcurementCardValue {
  return SpecialistProcurementCard.parse({
    ...card,
    id: globalThis.crypto.randomUUID(),
    canonicalProcurementId: card.canonicalProcurementId ?? card.id,
    profileIds: card.profileIds.map((id) => profileMap.get(id) ?? id),
  });
}

function remapInbox(
  item: InboxFixtureItem,
  cases: readonly SpecialistProcurementCardValue[],
): InboxFixtureItem {
  const match = cases.find(
    (card) => card.sourceProcurementId === item.procurement.sourceProcurementId,
  );
  return InboxFixtureItem.parse({
    ...item,
    change: {
      ...item.change,
      procurementId: match?.id ?? item.change.procurementId,
    },
  });
}
