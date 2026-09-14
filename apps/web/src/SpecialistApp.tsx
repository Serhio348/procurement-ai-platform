import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import type {
  SpecialistInboxAction,
  SpecialistInboxEntry,
  SpecialistInboxResolveResponse,
  SpecialistIngestProgress,
  SpecialistProcurementCard,
  SpecialistProfileListResponse,
  SpecialistProfileWrite,
  SpecialistSearchResponse,
  SpecialistTriageKind,
  SpecialistWorkingProfile,
} from "@procurement/contracts";
import { isIngestRunning, isRejectedTriage, isWatchedTriage } from "@procurement/domain";
import { AdminApp } from "./admin/AdminApp.js";
import { InboxAlertProvider } from "./inbox/InboxAlert.js";
import { InboxApp } from "./inbox/InboxApp.js";
import { MyProcurementsApp } from "./procurements/MyProcurementsApp.js";
import { ProcurementDetailApp } from "./procurements/ProcurementDetailApp.js";
import { ProcurementsApp } from "./procurements/ProcurementsApp.js";
import { ProfileApp } from "./profile/ProfileApp.js";
import { ProfileList } from "./profile/ProfileList.js";

export interface SpecialistAppProps {
  inbox: readonly SpecialistInboxEntry[];
  procurements: readonly SpecialistProcurementCard[];
  profiles: readonly SpecialistWorkingProfile[];
  activeProfileId?: string;
  search?: (offset?: number) => Promise<SpecialistSearchResponse>;
  createProfile?: () => Promise<SpecialistWorkingProfile>;
  deleteProfile?: (id: string) => Promise<SpecialistProfileListResponse>;
  activateProfile?: (id: string) => Promise<SpecialistWorkingProfile>;
  saveProfile?: (id: string, next: SpecialistProfileWrite) => Promise<SpecialistWorkingProfile>;
  setProfileWatch?: (watchNewProcurements: boolean) => Promise<SpecialistWorkingProfile>;
  decide?: (
    id: string,
    kind: SpecialistTriageKind,
  ) => Promise<readonly SpecialistProcurementCard[]>;
  archive?: (
    id: string,
    archived: boolean,
  ) => Promise<readonly SpecialistProcurementCard[]>;
  restore?: (id: string) => Promise<readonly SpecialistProcurementCard[]>;
  purge?: (id: string) => Promise<void>;
  emptyTrash?: () => Promise<void>;
  reindex?: (id: string) => Promise<readonly SpecialistProcurementCard[]>;
  ingestProgress?: (id: string) => Promise<SpecialistIngestProgress>;
  refreshInbox?: () => Promise<readonly SpecialistInboxEntry[]>;
  resolveInbox?: (
    id: string,
    action: SpecialistInboxAction,
  ) => Promise<SpecialistInboxResolveResponse>;
  listMine?: (query?: {
    tab?: string;
    limit?: number;
  }) => Promise<readonly SpecialistProcurementCard[]>;
  loadCard?: (id: string) => Promise<SpecialistProcurementCard>;
  /** Namespaces last-search ids so two users on one browser do not share them. */
  storageScope?: string;
}

export function SpecialistApp(props: SpecialistAppProps): ReactElement {
  const [inbox, setInbox] = useState(props.inbox);
  const [procurements, setProcurements] = useState(props.procurements);
  const [profiles, setProfiles] = useState(props.profiles);
  const [activeProfileId, setActiveProfileId] = useState(
    props.activeProfileId ?? props.profiles[0]?.id ?? "",
  );
  const searchProfile = props.search;
  const decideCase = props.decide;
  const archiveCase = props.archive;
  const restoreCase = props.restore;
  const purgeCase = props.purge;
  const emptyTrashCase = props.emptyTrash;
  const reindexCase = props.reindex;
  const activateProfile = props.activateProfile;
  const createProfile = props.createProfile;
  const deleteProfile = props.deleteProfile;
  const saveProfile = props.saveProfile;
  const setProfileWatch = props.setProfileWatch;
  const refreshInbox = props.refreshInbox;
  const resolveInbox = props.resolveInbox;

  useEffect(() => {
    if (refreshInbox === undefined) return undefined;
    const timer = setInterval(() => {
      void refreshInbox()
        // The poll returns a fresh array every tick; swapping it for an
        // identical list re-renders the whole console for nothing.
        .then((items) =>
          setInbox((current) => (sameInboxItems(current, items) ? current : items)),
        )
        .catch(() => undefined);
    }, 30_000);
    return () => clearInterval(timer);
  }, [refreshInbox]);

  // Ids of the last profile search per profile, in source order. The search
  // pane is unmounted on every tab switch and the whole app on reload; without
  // this it would come back showing the whole catalog (old completed cases)
  // instead of what was just found. Kept in localStorage so a refresh keeps it.
  const [searchIdsByProfile, setSearchIdsByProfile] = useState(() =>
    readStoredSearchIds(props.storageScope),
  );
  const searchIds = searchIdsByProfile[activeProfileId];
  const ingestingIds = useRef(new Set<string>());
  const [ingestById, setIngestById] = useState<Record<string, SpecialistIngestProgress>>(
    {},
  );
  const ingestProgressRef = useRef(props.ingestProgress);
  ingestProgressRef.current = props.ingestProgress;
  const loadCardRef = useRef(props.loadCard);
  loadCardRef.current = props.loadCard;

  const search =
    searchProfile === undefined
      ? undefined
      : async (offset?: number) => {
          const result = await searchProfile(offset);
          // Keep decided / watched cases in memory so "Мои закупки" does not
          // empty when the search pane shows only the latest hit list.
          setProcurements((current) => mergeProcurementCards(current, result.items));
          const ids = result.items.map((item) => item.id);
          setSearchIdsByProfile((current) => {
            const previous = current[activeProfileId];
            const next = {
              ...current,
              [activeProfileId]:
                offset === undefined || offset === 0 || previous === undefined
                  ? ids
                  : [...previous, ...ids.filter((id) => !previous.includes(id))],
            };
            writeStoredSearchIds(next, props.storageScope);
            return next;
          });
          if (refreshInbox !== undefined) {
            setInbox(await refreshInbox());
          }
          return result;
        };

  const searchPaneItems =
    searchIds === undefined
      ? procurements.filter((item) => !isWatchedTriage(item) && !isRejectedTriage(item.triage))
      : searchIds
          .map((id) => procurements.find((item) => item.id === id))
          .filter((item): item is SpecialistProcurementCard => item !== undefined)
          .filter((item) => !isWatchedTriage(item) && !isRejectedTriage(item.triage));

  const decide =
    decideCase === undefined
      ? undefined
      : async (id: string, kind: SpecialistTriageKind) => {
          if (kind === "participate") ingestingIds.current.add(id);
          const items = await decideCase(id, kind);
          const updated = items.find((item) => item.id === id);
          setProcurements((current) => {
            if (kind === "reject") {
              if (updated === undefined) return current.filter((item) => item.id !== id);
              return mergeProcurementCards(current, [updated]);
            }
            if (updated === undefined) return current;
            return mergeProcurementCards(current, [updated]);
          });
          if (kind === "monitor" || kind === "participate" || kind === "reject") {
            setSearchIdsByProfile((current) => {
              const previous = current[activeProfileId];
              if (previous === undefined || !previous.includes(id)) return current;
              const nextIds = previous.filter((item) => item !== id);
              const next = { ...current, [activeProfileId]: nextIds };
              writeStoredSearchIds(next, props.storageScope);
              return next;
            });
          }
          if (refreshInbox !== undefined) {
            setInbox(await refreshInbox());
          }
          return updated === undefined ? items : [updated];
        };

  const archive =
    archiveCase === undefined
      ? undefined
      : async (id: string, archived: boolean) => {
          const items = await archiveCase(id, archived);
          const updated = items.find((item) => item.id === id);
          if (updated !== undefined) {
            setProcurements((current) => mergeProcurementCards(current, [updated]));
          }
          return updated === undefined ? items : [updated];
        };

  const restore =
    restoreCase === undefined
      ? undefined
      : async (id: string) => {
          const items = await restoreCase(id);
          const updated = items.find((item) => item.id === id);
          if (updated !== undefined) {
            setProcurements((current) => mergeProcurementCards(current, [updated]));
          }
          return updated === undefined ? items : [updated];
        };

  const purge =
    purgeCase === undefined
      ? undefined
      : async (id: string) => {
          await purgeCase(id);
          setProcurements((current) => current.filter((item) => item.id !== id));
        };

  const emptyTrash =
    emptyTrashCase === undefined
      ? undefined
      : async () => {
          await emptyTrashCase();
          setProcurements((current) => current.filter((item) => item.triage !== "reject"));
        };

  const reindex =
    reindexCase === undefined
      ? undefined
      : async (id: string) => {
          ingestingIds.current.add(id);
          try {
            const items = await reindexCase(id);
            const updated = items.find((item) => item.id === id);
            if (updated !== undefined) {
              setProcurements((current) => mergeProcurementCards(current, [updated]));
            }
            return updated === undefined ? items : [updated];
          } catch (error) {
            ingestingIds.current.delete(id);
            throw error;
          }
        };

  const listMine = props.listMine;
  const loadList = useCallback(
    async (tab: "all" | "monitor" | "participate" | "archive" | "trash") => {
      return (await listMine?.({ tab, limit: 100 })) ?? [];
    },
    [listMine],
  );

  function rememberCard(card: SpecialistProcurementCard): void {
    setProcurements((current) => {
      if (current.some((item) => item.id === card.id)) {
        return current.map((item) => (item.id === card.id ? card : item));
      }
      return [...current, card];
    });
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      const pull = ingestProgressRef.current;
      if (pull === undefined) return;
      for (const id of ingestingIds.current) {
        void pull(id)
          .then(async (snap) => {
            if (!ingestingIds.current.has(id)) return;
            setIngestById((current) => ({ ...current, [id]: snap }));
            if (isIngestRunning(snap.phase)) return;
            ingestingIds.current.delete(id);
            if (snap.phase === "done") {
              const load = loadCardRef.current;
              if (load !== undefined) {
                try {
                  const card = await load(id);
                  setProcurements((current) => {
                    if (current.some((item) => item.id === card.id)) {
                      return current.map((item) => (item.id === card.id ? card : item));
                    }
                    return [...current, card];
                  });
                } catch {
                  // Detail/list still have the participate stub; next open reloads.
                }
              }
              setIngestById((current) => {
                const next = { ...current };
                delete next[id];
                return next;
              });
              return;
            }
            setIngestById((current) => ({ ...current, [id]: snap }));
          })
          .catch(() => undefined);
      }
    }, 400);
    return () => window.clearInterval(timer);
  }, []);

  function showInSearchPane(card: SpecialistProcurementCard): void {
    const next =
      activeProfileId.length > 0 && !card.profileIds.includes(activeProfileId)
        ? { ...card, profileIds: [...card.profileIds, activeProfileId] }
        : card;
    rememberCard(next);
    setSearchIdsByProfile((current) => {
      const previous = current[activeProfileId];
      if (previous === undefined || previous.includes(next.id)) return current;
      const updated = { ...current, [activeProfileId]: [next.id, ...previous] };
      writeStoredSearchIds(updated, props.storageScope);
      return updated;
    });
  }

  function remember(next: SpecialistWorkingProfile, activate = false): SpecialistWorkingProfile {
    setProfiles((current) => {
      if (current.some((item) => item.id === next.id)) {
        return current.map((item) => (item.id === next.id ? next : item));
      }
      return [...current, next];
    });
    if (activate) setActiveProfileId(next.id);
    return next;
  }

  return (
    <InboxAlertProvider count={inbox.length}>
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <InboxRoute
              entries={inbox}
              {...(resolveInbox === undefined
                ? {}
                : {
                    resolve: async (id, action) => {
                      const result = await resolveInbox(id, action);
                      setInbox(result.items);
                      if (result.card !== undefined) showInSearchPane(result.card);
                      if (action === "documents") {
                        for (const document of result.documents) {
                          window.open(document.url, "_blank", "noopener,noreferrer");
                        }
                      }
                      return result;
                    },
                  })}
            />
          }
        />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/register" element={<Navigate to="/" replace />} />
        <Route path="/forgot-password" element={<Navigate to="/" replace />} />
        <Route path="/reset-password" element={<Navigate to="/" replace />} />
        <Route
          path="/profiles"
          element={
            <ProfileListRoute
              profiles={profiles}
              create={async () => {
                if (createProfile === undefined) return undefined;
                return remember(await createProfile(), true);
              }}
              {...(deleteProfile === undefined
                ? {}
                : {
                    remove: async (id: string) => {
                      const listed = await deleteProfile(id);
                      setProfiles(listed.items);
                      setActiveProfileId(listed.activeProfileId);
                    },
                  })}
            />
          }
        />
        <Route
          path="/profiles/:id"
          element={
            <ProfileEditorRoute
              profiles={profiles}
              {...(activateProfile === undefined
                ? {}
                : { activate: async (id: string) => remember(await activateProfile(id), true) })}
              save={async (id, next) => {
                if (saveProfile === undefined) {
                  const current = profiles.find((item) => item.id === id) ?? profiles[0];
                  if (current === undefined) {
                    throw new Error("no_profile");
                  }
                  return remember({ ...current, ...next });
                }
                return remember(await saveProfile(id, next));
              }}
              setWatch={async (watchNewProcurements) => {
                if (setProfileWatch === undefined) {
                  const current = profiles[0];
                  if (current === undefined) {
                    throw new Error("no_profile");
                  }
                  return remember({ ...current, watchNewProcurements });
                }
                return remember(await setProfileWatch(watchNewProcurements));
              }}
            />
          }
        />
        <Route
          path="/procurements"
          element={
            <ProcurementsApp
              items={searchPaneItems}
              profiles={profiles}
              {...(activeProfileId.length === 0 ? {} : { activeProfileId })}
              {...(search === undefined ? {} : { search })}
              {...(activateProfile === undefined
                ? {}
                : {
                    selectProfile: async (id: string) => {
                      remember(await activateProfile(id), true);
                    },
                  })}
              {...(decide === undefined ? {} : { decide })}
              {...(props.ingestProgress === undefined ? {} : { ingestProgress: props.ingestProgress })}
            />
          }
        />
        <Route
          path="/procurements/:id"
          element={
            <ProcurementsApp
              items={searchPaneItems}
              profiles={profiles}
              {...(activeProfileId.length === 0 ? {} : { activeProfileId })}
              {...(search === undefined ? {} : { search })}
              {...(activateProfile === undefined
                ? {}
                : {
                    selectProfile: async (id: string) => {
                      remember(await activateProfile(id), true);
                    },
                  })}
              {...(decide === undefined ? {} : { decide })}
              {...(props.ingestProgress === undefined ? {} : { ingestProgress: props.ingestProgress })}
            />
          }
        />
        <Route
          path="/my-procurements"
          element={
            <MyProcurementsApp
              procurements={procurements}
              {...(archive === undefined ? {} : { onArchive: archive })}
              {...(decide === undefined
                ? {}
                : { onRemove: async (id: string) => void decide(id, "reject") })}
              {...(listMine === undefined ? {} : { load: loadList })}
              activeIngest={ingestById}
            />
          }
        />
        <Route
          path="/trash"
          element={
            <MyProcurementsApp
              section="trash"
              procurements={procurements}
              {...(restore === undefined ? {} : { onRestore: restore })}
              {...(purge === undefined ? {} : { onPurge: purge })}
              {...(emptyTrash === undefined ? {} : { onEmptyTrash: emptyTrash })}
              {...(listMine === undefined ? {} : { load: loadList })}
            />
          }
        />
        <Route
          path="/my-procurements/:id"
          element={
            <ProcurementDetailApp
              procurements={procurements}
              onCardLoaded={rememberCard}
              {...(props.loadCard === undefined ? {} : { fetchCase: props.loadCard })}
              {...(decide === undefined ? {} : { decide })}
              {...(restore === undefined ? {} : { restore })}
              {...(purge === undefined ? {} : { purge })}
              {...(props.ingestProgress === undefined ? {} : { ingestProgress: props.ingestProgress })}
              activeIngest={ingestById}
              {...(reindex === undefined ? {} : { reindex })}
            />
          }
        />
        <Route
          path="/trash/:id"
          element={
            <ProcurementDetailApp
              procurements={procurements}
              onCardLoaded={rememberCard}
              {...(props.loadCard === undefined ? {} : { fetchCase: props.loadCard })}
              {...(decide === undefined ? {} : { decide })}
              {...(restore === undefined ? {} : { restore })}
              {...(purge === undefined ? {} : { purge })}
              {...(props.ingestProgress === undefined ? {} : { ingestProgress: props.ingestProgress })}
              activeIngest={ingestById}
              {...(reindex === undefined ? {} : { reindex })}
            />
          }
        />
        <Route path="/admin/:pane?/:userId?" element={<AdminApp />} />
      </Routes>
    </BrowserRouter>
    </InboxAlertProvider>
  );
}

function InboxRoute({
  entries,
  resolve,
}: {
  entries: readonly SpecialistInboxEntry[];
  resolve?: (
    id: string,
    action: SpecialistInboxAction,
  ) => Promise<SpecialistInboxResolveResponse>;
}): ReactElement {
  const navigate = useNavigate();
  return (
    <InboxApp
      entries={entries}
      {...(resolve === undefined
        ? {}
        : {
            onResolve: async (id, action) => {
              const result = await resolve(id, action);
              if (result.card !== undefined && action === "open") {
                void navigate(`/procurements/${result.card.id}`);
              }
            },
          })}
    />
  );
}

function ProfileListRoute({
  profiles,
  create,
  remove,
}: {
  profiles: readonly SpecialistWorkingProfile[];
  create: () => Promise<SpecialistWorkingProfile | undefined>;
  remove?: (id: string) => Promise<void>;
}): ReactElement {
  const navigate = useNavigate();
  return (
    <ProfileList
      profiles={profiles}
      create={async () => {
        const created = await create();
        if (created !== undefined) navigate(`/profiles/${created.id}`);
      }}
      {...(remove === undefined ? {} : { remove })}
    />
  );
}

function ProfileEditorRoute({
  profiles,
  activate,
  save,
  setWatch,
}: {
  profiles: readonly SpecialistWorkingProfile[];
  activate?: (id: string) => Promise<SpecialistWorkingProfile>;
  save: (id: string, next: SpecialistProfileWrite) => Promise<SpecialistWorkingProfile>;
  setWatch: (watchNewProcurements: boolean) => Promise<SpecialistWorkingProfile>;
}): ReactElement {
  const { id } = useParams();
  const profile = profiles.find((item) => item.id === id) ?? profiles[0];
  if (profile === undefined) {
    return <ProfileList profiles={[]} create={async () => undefined} />;
  }
  return (
    <ProfileApp
      profile={profile}
      {...(activate === undefined ? {} : { activate })}
      save={(next) => save(profile.id, next)}
      setWatch={setWatch}
    />
  );
}

export const SEARCH_IDS_STORAGE_KEY = "procurement.searchIdsByProfile";

export function searchIdsStorageKey(scope?: string): string {
  return scope === undefined || scope.length === 0
    ? SEARCH_IDS_STORAGE_KEY
    : `${SEARCH_IDS_STORAGE_KEY}.${scope}`;
}

type SearchIdsByProfile = Readonly<Record<string, readonly string[]>>;

/** Storage is best-effort: a missing or corrupt entry just means "no search yet". */
export function readStoredSearchIds(scope?: string): SearchIdsByProfile {
  try {
    const raw = globalThis.localStorage?.getItem(searchIdsStorageKey(scope));
    if (raw === null || raw === undefined) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, readonly string[]> = {};
    for (const [profileId, ids] of Object.entries(parsed)) {
      if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) {
        result[profileId] = ids;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function writeStoredSearchIds(value: SearchIdsByProfile, scope?: string): void {
  try {
    globalThis.localStorage?.setItem(searchIdsStorageKey(scope), JSON.stringify(value));
  } catch {
    // Quota or privacy mode: the in-memory state still works for this session.
  }
}

function sameInboxItems(
  left: readonly SpecialistInboxEntry[],
  right: readonly SpecialistInboxEntry[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((item, index) => item.id === right[index]?.id);
}

/** Prefer the richer case (documents / source card) when the same id returns twice. */
export function mergeProcurementCards(
  current: readonly SpecialistProcurementCard[],
  updates: readonly SpecialistProcurementCard[],
): SpecialistProcurementCard[] {
  const byId = new Map(current.map((item) => [item.id, item] as const));
  for (const update of updates) {
    const previous = byId.get(update.id);
    if (previous === undefined) {
      byId.set(update.id, update);
      continue;
    }
    byId.set(update.id, {
      ...previous,
      ...update,
      documents: update.documents.length > 0 ? update.documents : previous.documents,
      sourceCard: update.sourceCard ?? previous.sourceCard,
      termsDetail: update.termsDetail ?? previous.termsDetail,
      paymentQuote: update.paymentQuote ?? previous.paymentQuote,
      watchSnapshot: update.watchSnapshot ?? previous.watchSnapshot,
      actions: update.actions.length > 0 ? update.actions : previous.actions,
    });
  }
  const order = [...current.map((item) => item.id)];
  for (const update of updates) {
    if (!order.includes(update.id)) order.push(update.id);
  }
  return order
    .map((id) => byId.get(id))
    .filter((item): item is SpecialistProcurementCard => item !== undefined);
}
