import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import type {
  ProcurementId,
  SpecialistInboxAction,
  SpecialistInboxEntry,
  SpecialistInboxResolveResponse,
  SpecialistIngestProgress,
  SpecialistProcurementCard,
  SpecialistProcurementListResponse,
  SpecialistProfileListResponse,
  SpecialistProfileWrite,
  SpecialistSearchResponse,
  SpecialistSearchRun,
  SpecialistTriageKind,
  SpecialistWorkingProfile,
} from "@procurement/contracts";
import {
  isIngestRunning,
  isListingPlaceholder,
  isRejectedTriage,
  isWatchedTriage,
} from "@procurement/domain";
import { AdminApp } from "./admin/AdminApp.js";
import { InboxAlertProvider } from "./inbox/InboxAlert.js";
import { InboxApp } from "./inbox/InboxApp.js";
import { MyProcurementsApp } from "./procurements/MyProcurementsApp.js";
import { ProcurementDetailApp } from "./procurements/ProcurementDetailApp.js";
import { ProcurementsApp } from "./procurements/ProcurementsApp.js";
import { ProfileApp } from "./profile/ProfileApp.js";
import { ProfileList } from "./profile/ProfileList.js";
import { NoticeStack, type InboxNotice } from "./shell/NoticeToast.js";
import { UnsavedGuardProvider } from "./shell/UnsavedGuard.js";

const LIST_PAGE_LIMIT = 500;
const POLL_FAILURE_LIMIT = 3;
type PollChannel = "inbox" | "run";

export interface SpecialistAppProps {
  inbox: readonly SpecialistInboxEntry[];
  procurements: readonly SpecialistProcurementCard[];
  profiles: readonly SpecialistWorkingProfile[];
  activeProfileId?: string;
  search?: (profileId: string, offset?: number) => Promise<SpecialistSearchResponse>;
  createProfile?: () => Promise<SpecialistWorkingProfile>;
  deleteProfile?: (id: string) => Promise<SpecialistProfileListResponse>;
  activateProfile?: (id: string) => Promise<SpecialistWorkingProfile>;
  saveProfile?: (id: string, next: SpecialistProfileWrite) => Promise<SpecialistWorkingProfile>;
  setProfileWatch?: (
    id: string,
    watchNewProcurements: boolean,
  ) => Promise<SpecialistWorkingProfile>;
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
    profileId?: string;
    limit?: number;
    offset?: number;
  }) => Promise<SpecialistProcurementListResponse>;
  loadCard?: (id: string) => Promise<SpecialistProcurementCard>;
  searchProgress?: (profileId: string) => Promise<SpecialistSearchRun>;
}

export function SpecialistApp(props: SpecialistAppProps): ReactElement {
  const [inbox, setInbox] = useState(props.inbox);
  // Rows already shown are seeded as known: only entries arriving after the
  // first render can raise a toast — the initial load must stay silent.
  const knownInboxIds = useRef(new Set(props.inbox.map((item) => item.id)));
  const [notices, setNotices] = useState<InboxNotice[]>([]);
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

  // Every inbox swap goes through here: new ids are remembered once, and a
  // deadline event that just arrived also raises a passive toast.
  const applyInboxItems = useCallback((items: readonly SpecialistInboxEntry[]) => {
    const fresh = items.filter((item) => !knownInboxIds.current.has(item.id));
    for (const item of fresh) knownInboxIds.current.add(item.id);
    const deadlineNotices = fresh
      .filter((item) => item.kind === "deadline_changed")
      .map((item) => ({ id: `notice-${item.id}`, title: item.title, message: item.summary }));
    if (deadlineNotices.length > 0) {
      setNotices((current) => [...current, ...deadlineNotices]);
    }
    // The poll returns a fresh array every tick; swapping it for an
    // identical list re-renders the whole console for nothing.
    setInbox((current) => (sameInboxItems(current, items) ? current : items));
  }, []);

  const dismissNotice = useCallback((id: string) => {
    setNotices((current) => current.filter((item) => item.id !== id));
  }, []);

  // Poll health (R28): three consecutive failures per channel raise a shared
  // connection note; the next successful poll clears it. Shown data stays.
  const pollFailures = useRef<Record<PollChannel, number>>({ inbox: 0, run: 0 });
  const [pollStale, setPollStale] = useState<ReadonlySet<PollChannel>>(new Set());
  const pollOk = useCallback((channel: PollChannel) => {
    pollFailures.current[channel] = 0;
    setPollStale((current) => {
      if (!current.has(channel)) return current;
      const next = new Set(current);
      next.delete(channel);
      return next;
    });
  }, []);
  const pollFailed = useCallback((channel: PollChannel) => {
    pollFailures.current[channel] += 1;
    if (pollFailures.current[channel] >= POLL_FAILURE_LIMIT) {
      setPollStale((current) =>
        current.has(channel) ? current : new Set(current).add(channel),
      );
    }
  }, []);

  useEffect(() => {
    if (refreshInbox === undefined) return undefined;
    const timer = setInterval(() => {
      void refreshInbox()
        .then((items) => {
          applyInboxItems(items);
          pollOk("inbox");
        })
        .catch(() => pollFailed("inbox"));
    }, 30_000);
    return () => clearInterval(timer);
  }, [refreshInbox, applyInboxItems, pollOk, pollFailed]);

  // Ids of the last profile search. The search pane unmounts on tab switch;
  // parent state plus GET ?tab=search keep this run, not the cabinet dump.
  const [searchRun, setSearchRun] = useState<SpecialistSearchRun | undefined>();
  const ingestingIds = useRef(new Set<string>());
  const [ingestById, setIngestById] = useState<Record<string, SpecialistIngestProgress>>(
    {},
  );
  const ingestProgressRef = useRef(props.ingestProgress);
  ingestProgressRef.current = props.ingestProgress;
  const searchProgressRef = useRef(props.searchProgress);
  searchProgressRef.current = props.searchProgress;
  const loadCardRef = useRef(props.loadCard);
  loadCardRef.current = props.loadCard;
  const listMineRef = useRef(props.listMine);
  listMineRef.current = props.listMine;

  const search =
    searchProfile === undefined
      ? undefined
      : async (profileId: string, offset?: number) => {
          setSearchRun(undefined);
          const result = await searchProfile(profileId, offset);
          setProcurements((current) => {
            if (offset === undefined || offset === 0) {
              const kept = current.filter(
                (item) =>
                  isWatchedTriage(item) ||
                  isRejectedTriage(item.triage) ||
                  (profileId.length > 0 && !item.profileIds.includes(profileId)),
              );
              return mergeProcurementCards(kept, result.items);
            }
            return mergeProcurementCards(current, result.items);
          });
          setSearchRun(result.run);
          if (refreshInbox !== undefined) {
            applyInboxItems(await refreshInbox());
          }
          return result;
        };

  const searchPaneItems = procurements.filter(
    (item) =>
      !isListingPlaceholder(item) &&
      !isWatchedTriage(item) &&
      !isRejectedTriage(item.triage),
  );

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
          if (refreshInbox !== undefined) {
            applyInboxItems(await refreshInbox());
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

  // Lists are paged server-side; the console walks every page so a card past
  // the first window stays reachable and counters show the real total (R27).
  const loadEntireList = useCallback(
    async (query: { tab: string; profileId?: string }) => {
      const pull = listMineRef.current;
      if (pull === undefined) return [] as SpecialistProcurementCard[];
      const items: SpecialistProcurementCard[] = [];
      let offset = 0;
      for (;;) {
        const page = await pull({ ...query, limit: LIST_PAGE_LIMIT, offset });
        items.push(...page.items);
        if (!page.hasMore || page.items.length === 0) return items;
        offset += page.items.length;
      }
    },
    [],
  );

  const loadList = useCallback(
    async (tab: "all" | "monitor" | "participate" | "archive" | "trash") => {
      return loadEntireList({ tab });
    },
    [loadEntireList],
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

  // First open: the stored search queue and a still-running search must
  // survive a page reload — the same load the profile switch performs.
  useEffect(() => {
    const pull = searchProgressRef.current;
    const profileId = activeProfileId;
    if (listMineRef.current !== undefined && profileId.length > 0) {
      void loadEntireList({ tab: "search", profileId })
        .then((items) => {
          setProcurements((current) => mergeSearchPane(current, items, profileId));
        })
        .catch(() => undefined);
    }
    if (pull !== undefined && profileId.length > 0) {
      void pull(profileId)
        .then((next) => setSearchRun(next))
        .catch(() => undefined);
    }
    // Mount-only restore; the running-search poll below keeps it fresh.
  }, [loadEntireList]);

  useEffect(() => {
    if (searchRun === undefined) return undefined;
    if (
      searchRun.status === "done" ||
      searchRun.status === "failed" ||
      searchRun.status === "interrupted"
    )
      return undefined;
    const timer = window.setInterval(() => {
      // The run names its own profile: polling follows the search, not
      // whichever profile happens to be active in this tab right now.
      const runProfileId = searchRun.profileId;
      const pull = searchProgressRef.current;
      if (pull !== undefined) {
        void pull(runProfileId)
          .then((next) => {
            pollOk("run");
            setSearchRun(next);
            if (
              next.status !== "done" &&
              next.status !== "failed" &&
              next.status !== "interrupted"
            )
              return;
            void loadEntireList({ tab: "search", profileId: runProfileId })
              .then((items) => {
                setProcurements((current) => mergeSearchPane(current, items, runProfileId));
              })
              .catch(() => pollFailed("run"));
          })
          .catch(() => pollFailed("run"));
      }
      if (listMineRef.current !== undefined) {
        void loadEntireList({ tab: "search", profileId: runProfileId })
          .then((items) => {
            setProcurements((current) => mergeSearchPane(current, items, runProfileId));
          })
          .catch(() => pollFailed("run"));
      }
      if (refreshInbox !== undefined) {
        void refreshInbox()
          .then((items) => {
            applyInboxItems(items);
            pollOk("inbox");
          })
          .catch(() => pollFailed("inbox"));
      }
    }, 800);
    return () => window.clearInterval(timer);
  }, [applyInboxItems, loadEntireList, pollFailed, pollOk, refreshInbox, searchRun]);

  async function openProfileSearch(id: string): Promise<void> {
    if (activateProfile !== undefined) {
      remember(await activateProfile(id), true);
    } else {
      setActiveProfileId(id);
    }
    const pull = searchProgressRef.current;
    if (listMineRef.current !== undefined) {
      try {
        const items = await loadEntireList({ tab: "search", profileId: id });
        setProcurements((current) => mergeSearchPane(current, items, id));
      } catch {
        // Keep the cards already on screen for this profile.
      }
    }
    if (pull !== undefined) {
      try {
        setSearchRun(await pull(id));
      } catch {
        setSearchRun(undefined);
      }
    }
  }

  function showInSearchPane(card: SpecialistProcurementCard): void {
    // Opening an inbox row is navigation: the card keeps the profile(s)
    // that found it. Attaching the active profile here would silently
    // claim another profile's candidate.
    rememberCard(card);
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
      <UnsavedGuardProvider>
      {pollStale.size === 0 ? null : (
        <p className="connection-stale" role="status">
          Нет связи с сервером — показанные данные могут быть устаревшими.
        </p>
      )}
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
                      applyInboxItems(result.items);
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
                      const previous = profiles;
                      const previousActive = activeProfileId;
                      const next = previous.filter((item) => item.id !== id);
                      if (next.length === 0) {
                        throw new Error("Нельзя удалить единственный профиль");
                      }
                      setProfiles(next);
                      if (previousActive === id) {
                        setActiveProfileId(next[0]!.id);
                      }
                      try {
                        const listed = await deleteProfile(id);
                        setProfiles(listed.items);
                        setActiveProfileId(listed.activeProfileId);
                      } catch (error) {
                        setProfiles(previous);
                        setActiveProfileId(previousActive);
                        throw error;
                      }
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
              setWatch={async (id, watchNewProcurements) => {
                if (setProfileWatch === undefined) {
                  const current =
                    profiles.find((item) => item.id === id) ?? profiles[0];
                  if (current === undefined) {
                    throw new Error("no_profile");
                  }
                  return remember({ ...current, watchNewProcurements });
                }
                return remember(await setProfileWatch(id, watchNewProcurements));
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
                      await openProfileSearch(id);
                    },
                  })}
              {...(decide === undefined ? {} : { decide })}
              {...(searchRun === undefined ? {} : { searchRun })}
              {...(props.ingestProgress === undefined ? {} : { ingestProgress: props.ingestProgress })}
            />
          }
        />
        <Route
          path="/procurements/:id"
          element={
            <ProcurementsApp
              items={procurements}
              profiles={profiles}
              {...(activeProfileId.length === 0 ? {} : { activeProfileId })}
              {...(search === undefined ? {} : { search })}
              {...(activateProfile === undefined
                ? {}
                : {
                    selectProfile: async (id: string) => {
                      await openProfileSearch(id);
                    },
                  })}
              {...(decide === undefined ? {} : { decide })}
              {...(searchRun === undefined ? {} : { searchRun })}
              {...(props.ingestProgress === undefined ? {} : { ingestProgress: props.ingestProgress })}
              {...(props.loadCard === undefined ? {} : { fetchCase: props.loadCard })}
              onCardLoaded={rememberCard}
            />
          }
        />
        <Route
          path="/my-procurements"
          element={
            <MyProcurementsApp
              procurements={procurements}
              profiles={profiles}
              {...(archive === undefined ? {} : { onArchive: archive })}
              {...(decide === undefined
                ? {}
                : { onRemove: async (id: string) => void decide(id, "reject") })}
              {...(props.listMine === undefined ? {} : { load: loadList })}
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
              profiles={profiles}
              {...(restore === undefined ? {} : { onRestore: restore })}
              {...(purge === undefined ? {} : { onPurge: purge })}
              {...(emptyTrash === undefined ? {} : { onEmptyTrash: emptyTrash })}
              {...(props.listMine === undefined ? {} : { load: loadList })}
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
      </UnsavedGuardProvider>
      <NoticeStack notices={notices} onDismiss={dismissNotice} />
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
                void navigate(inboxOpenTarget(result.card));
              }
            },
          })}
    />
  );
}

// An inbox row opens where the case actually lives: watched cases carry their
// full stored card in «Мои закупки», rejected ones in «Корзина»; only
// undecided candidates belong to the search tab.
function inboxOpenTarget(card: SpecialistProcurementCard): string {
  if (isRejectedTriage(card.triage)) return `/trash/${card.id}`;
  if (isWatchedTriage(card) || card.archived) return `/my-procurements/${card.id}`;
  return `/procurements/${card.id}`;
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

export function ProfileEditorRoute({
  profiles,
  activate,
  save,
  setWatch,
}: {
  profiles: readonly SpecialistWorkingProfile[];
  activate?: (id: string) => Promise<SpecialistWorkingProfile>;
  save: (id: string, next: SpecialistProfileWrite) => Promise<SpecialistWorkingProfile>;
  setWatch: (
    id: string,
    watchNewProcurements: boolean,
  ) => Promise<SpecialistWorkingProfile>;
}): ReactElement {
  const { id } = useParams();
  const profile = profiles.find((item) => item.id === id) ?? profiles[0];
  if (profile === undefined) {
    return <ProfileList profiles={[]} create={async () => undefined} />;
  }
  return (
    <ProfileApp
      key={profile.id}
      profile={profile}
      {...(activate === undefined ? {} : { activate })}
      save={(next) => save(profile.id, next)}
      setWatch={setWatch}
    />
  );
}

function sameInboxItems(
  left: readonly SpecialistInboxEntry[],
  right: readonly SpecialistInboxEntry[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((item, index) => item.id === right[index]?.id);
}

function mergeSearchPane(
  current: readonly SpecialistProcurementCard[],
  updates: readonly SpecialistProcurementCard[],
  profileId: string,
): SpecialistProcurementCard[] {
  const updateSources = new Set(updates.map((item) => item.sourceProcurementId));
  const kept = current.filter(
    (item) =>
      !updateSources.has(item.sourceProcurementId) &&
      (isWatchedTriage(item) ||
        isRejectedTriage(item.triage) ||
        (profileId.length > 0 && !item.profileIds.includes(profileId))),
  );
  return mergeProcurementCards(kept, updates);
}

/** Prefer the richer case (documents / source card) when the same id returns twice. */
export function mergeProcurementCards(
  current: readonly SpecialistProcurementCard[],
  updates: readonly SpecialistProcurementCard[],
): SpecialistProcurementCard[] {
  const byId = new Map(current.map((item) => [item.id, item] as const));
  const idBySource = new Map(current.map((item) => [item.sourceProcurementId, item.id] as const));
  for (const update of updates) {
    const previousId = byId.has(update.id) ? update.id : idBySource.get(update.sourceProcurementId);
    const previous = previousId === undefined ? undefined : byId.get(previousId);
    if (previous !== undefined && previous.id !== update.id) {
      byId.delete(previous.id);
    }
    if (previous === undefined) {
      byId.set(update.id, update);
      idBySource.set(update.sourceProcurementId, update.id);
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
    idBySource.set(update.sourceProcurementId, update.id);
  }
  const seen = new Set<ProcurementId>();
  const order: ProcurementId[] = [];
  for (const item of [...current, ...updates]) {
    const id = idBySource.get(item.sourceProcurementId);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  return order
    .map((id) => byId.get(id))
    .filter((item): item is SpecialistProcurementCard => item !== undefined);
}
