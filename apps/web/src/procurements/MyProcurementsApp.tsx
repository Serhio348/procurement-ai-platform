import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import type {
  SpecialistIngestProgress,
  SpecialistProcurementCard,
  SpecialistWorkingProfile,
} from "@procurement/contracts";
import {
  bidsDeadlinePassed,
  cardProcedureKindLabel,
  isIngestRunning,
  isSingleSourceAfterFailedProcedure,
  procurementBelongsToProfile,
  profileDisplayName,
} from "@procurement/domain";
import { ConfirmToast, TRASH_MOVE_PROMPT, TRASH_PURGE_PROMPT } from "../shell/ConfirmToast.js";
import { Shell } from "../shell/Shell.js";
import { errorText } from "../api/http.js";
import { ingestProgressCaption } from "./ProcurementsApp.js";

type MineTab = "all" | "monitor" | "participate" | "archive";
export type MyProcurementsSection = "mine" | "trash";
type ListTab = MineTab | "trash";

/** Three rows of cards fits one viewport better than an endless scroll. */
export const MY_PROCUREMENTS_PAGE_SIZE = 9;

const filterTabs: { key: MineTab; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "monitor", label: "Слежу" },
  { key: "participate", label: "Участвую" },
  { key: "archive", label: "Архив" },
];

const EMPTY_TEXT: Record<ListTab, string> = {
  all: "Здесь будут закупки, по которым нажали «Следить» или «Участвовать».",
  monitor: "Здесь будут закупки, по которым нажали «Следить».",
  participate: "Здесь будут закупки, по которым нажали «Участвовать».",
  archive: "Здесь будут завершённые закупки, которые вы переместили в архив.",
  trash: "Сюда попадают закупки после «Убрать» или «Не нужно». Их можно вернуть или удалить.",
};

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

function isDecided(item: SpecialistProcurementCard): boolean {
  return item.triage === "monitor" || item.triage === "participate";
}

function runningIngest(
  ingest: SpecialistIngestProgress | undefined,
): SpecialistIngestProgress | undefined {
  return ingest !== undefined && isIngestRunning(ingest.phase) ? ingest : undefined;
}

function printDeadline(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (match === null) return raw;
  return `${match[3]}.${match[2]}.${match[1]}`;
}

function CardTitle({ title }: { title: string }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  return (
    <h2
      className={
        expanded ? "my-procurements-card-title is-expanded" : "my-procurements-card-title"
      }
      onMouseEnter={() => {
        setExpanded(true);
      }}
      onMouseLeave={() => {
        setExpanded(false);
      }}
      onFocus={() => {
        setExpanded(true);
      }}
      onBlur={() => {
        setExpanded(false);
      }}
    >
      <span className="my-procurements-card-title-clamp">{title}</span>
      {expanded ? (
        <span className="my-procurements-card-title-full" aria-hidden="true">
          {title}
        </span>
      ) : null}
    </h2>
  );
}

function CardIngestCaption({ ingest }: { ingest: SpecialistIngestProgress | undefined }) {
  const running = runningIngest(ingest);
  if (running === undefined) return null;
  return <p className="my-procurements-card-ingest">{ingestProgressCaption(running)}</p>;
}

function pageWindow(total: number, page: number, size: number): { from: number; to: number } {
  if (total === 0) return { from: 0, to: 0 };
  const from = page * size + 1;
  const to = Math.min(total, (page + 1) * size);
  return { from, to };
}

function pageNumbers(pageCount: number, page: number): number[] {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index);
  }
  const set = new Set<number>([0, pageCount - 1, page]);
  for (const delta of [-2, -1, 1, 2]) {
    const next = page + delta;
    if (next > 0 && next < pageCount - 1) set.add(next);
  }
  return [...set].sort((a, b) => a - b);
}

function filterByProfile(
  items: readonly SpecialistProcurementCard[],
  profiles: readonly SpecialistWorkingProfile[],
  profileFilter: string,
): SpecialistProcurementCard[] {
  if (profileFilter === "all" || profileFilter.length === 0) return [...items];
  const profile = profiles.find((item) => item.id === profileFilter);
  if (profile === undefined) return [...items];
  return items.filter((card) => procurementBelongsToProfile(card, profile));
}

function pluralRu(count: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * Explicit load lifecycle (R28): a failed fetch is an error screen, never a
 * fake empty list; a failed refresh keeps the last good page as «stale».
 * `empty` is not a state — it is `ready` with zero items.
 */
type TabListState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: readonly SpecialistProcurementCard[]; updatedAt: Date }
  | { kind: "stale"; items: readonly SpecialistProcurementCard[]; updatedAt: Date; message: string };

function matchesListQuery(item: SpecialistProcurementCard, query: string): boolean {
  const haystack = [item.title, item.buyerName, item.sourceProcurementId, item.id]
    .filter((part): part is string => part !== undefined)
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}

function profileNamesForCard(
  item: SpecialistProcurementCard,
  profiles: readonly SpecialistWorkingProfile[],
): string[] {
  if (item.profileIds.length === 0 || profiles.length === 0) return [];
  return item.profileIds
    .map((id) => profiles.find((profile) => profile.id === id))
    .filter((profile): profile is SpecialistWorkingProfile => profile !== undefined)
    .map((profile) => profileDisplayName(profile));
}

export function MyProcurementsApp({
  procurements,
  section = "mine",
  profiles = [],
  onArchive,
  onRemove,
  onRestore,
  onPurge,
  onEmptyTrash,
  load,
  now = () => new Date(),
  activeIngest = {},
  pageSize = MY_PROCUREMENTS_PAGE_SIZE,
}: {
  procurements: readonly SpecialistProcurementCard[];
  section?: MyProcurementsSection;
  profiles?: readonly SpecialistWorkingProfile[];
  onArchive?: (id: string, archived: boolean) => Promise<unknown> | void;
  onRemove?: (id: string) => Promise<unknown> | void;
  onRestore?: (id: string) => Promise<unknown> | void;
  onPurge?: (id: string) => Promise<unknown> | void;
  onEmptyTrash?: () => Promise<unknown> | void;
  load?: (tab: ListTab) => Promise<readonly SpecialistProcurementCard[]>;
  now?: () => Date;
  activeIngest?: Record<string, SpecialistIngestProgress>;
  pageSize?: number;
}): ReactElement {
  const navigate = useNavigate();
  const today = now();
  const isTrash = section === "trash";
  const [filter, setFilter] = useState<MineTab>("all");
  const [profileFilter, setProfileFilter] = useState("all");
  const [listQuery, setListQuery] = useState("");
  const [page, setPage] = useState(0);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<
    { kind: "empty" } | { kind: "purge" | "remove"; id: string } | undefined
  >();
  const [remote, setRemote] = useState<readonly SpecialistProcurementCard[] | undefined>(undefined);
  // Per-tab load state: coming back to a tab revalidates in place, so a
  // failed refresh degrades to «stale» and keeps the last good items (R28).
  const [lists, setLists] = useState<Partial<Record<ListTab, TabListState>>>({});
  const [refreshing, setRefreshing] = useState(false);
  const listRef = useRef<HTMLElement | null>(null);
  const activeTab: ListTab = isTrash ? "trash" : filter;
  const hasLoad = load !== undefined;
  const loadRef = useRef(load);
  loadRef.current = load;
  // `now` defaults to a fresh arrow each render — keep it in a ref so the
  // load callback stays referentially stable and the effect cannot loop.
  const nowRef = useRef(now);
  nowRef.current = now;
  // A late response from a previous tab must not overwrite the current one:
  // every run gets a generation, stale answers are dropped (R28).
  const generationRef = useRef(0);
  const showProfileFilter = !isTrash && profiles.length > 0;

  const runListLoad = useCallback(
    (tab: ListTab) => {
      const loader = loadRef.current;
      if (loader === undefined) return;
      const generation = ++generationRef.current;
      setLists((current) => {
        const held = current[tab];
        return held !== undefined && "items" in held
          ? current
          : { ...current, [tab]: { kind: "loading" } };
      });
      setRefreshing(true);
      void loader(tab)
        .then((items) => {
          if (generationRef.current !== generation) return;
          setLists((current) => ({
            ...current,
            [tab]: { kind: "ready", items, updatedAt: nowRef.current() },
          }));
        })
        .catch((error: unknown) => {
          if (generationRef.current !== generation) return;
          const message = errorText(error, "Не удалось загрузить список.");
          setLists((current) => {
            const held = current[tab];
            const next: TabListState =
              held !== undefined && "items" in held
                ? { kind: "stale", items: held.items, updatedAt: held.updatedAt, message }
                : { kind: "error", message };
            return { ...current, [tab]: next };
          });
        })
        .finally(() => {
          if (generationRef.current === generation) setRefreshing(false);
        });
    },
    [],
  );

  useEffect(() => {
    if (loadRef.current === undefined) {
      setLists({});
      return undefined;
    }
    runListLoad(activeTab);
    return () => {
      generationRef.current += 1;
    };
  }, [activeTab, hasLoad, runListLoad]);

  // When load() is set, paint only that tab page. Falling back to the parent
  // catalog mixes archive and search hits into «Все» and reshuffles cards.
  const tabState = lists[activeTab];
  const listItems = tabState !== undefined && "items" in tabState ? tabState.items : undefined;
  const listFailed = hasLoad && tabState !== undefined && tabState.kind === "error";
  const staleNote = tabState !== undefined && tabState.kind === "stale" ? tabState : undefined;
  const waiting =
    hasLoad &&
    !listFailed &&
    (tabState === undefined || tabState.kind === "loading");
  const source = hasLoad
    ? waiting || listFailed
      ? []
      : (listItems ?? [])
    : (remote ?? procurements);
  const decided = source.filter((item) => isDecided(item) && item.archived !== true);
  const archived = source.filter(
    (item) => item.archived === true && item.triage !== "reject",
  );
  const trashed = source.filter((item) => item.triage === "reject");
  const byDecision = isTrash
    ? trashed
    : hasLoad
      ? source.filter((item) =>
          item.triage !== "reject" &&
          (filter === "archive" ? item.archived === true : item.archived !== true),
        )
      : filter === "archive"
        ? archived
        : filter === "all"
          ? decided
          : decided.filter((item) => item.triage === filter);
  const query = listQuery.trim().toLowerCase();
  const visible = filterByProfile(byDecision, profiles, profileFilter).filter(
    (item) => query.length === 0 || matchesListQuery(item, query),
  );

  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = visible.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const window = pageWindow(visible.length, safePage, pageSize);

  useEffect(() => {
    setPage(0);
  }, [activeTab, profileFilter, listQuery]);

  useEffect(() => {
    if (page > pageCount - 1) setPage(Math.max(0, pageCount - 1));
  }, [page, pageCount]);

  function goToPage(next: number): void {
    setPage(next);
    const root = listRef.current;
    if (root !== null && typeof root.scrollTo === "function") {
      root.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  // Cards live in two stores: per-tab server pages (load mode) or the parent
  // catalog mirror `remote`. An optimistic patch applies to every cached tab
  // so a removed card does not linger in another tab's snapshot (R28).
  const patchItems = (
    updater: (items: readonly SpecialistProcurementCard[]) => readonly SpecialistProcurementCard[],
  ): void => {
    if (hasLoad) {
      setLists((current) => {
        const next: Partial<Record<ListTab, TabListState>> = { ...current };
        for (const tab of Object.keys(next) as ListTab[]) {
          const state = next[tab];
          if (state !== undefined && "items" in state) {
            next[tab] = { ...state, items: updater(state.items) };
          }
        }
        return next;
      });
    } else {
      setRemote((current) => updater(current ?? source));
    }
  };
  const restoreItems = (tab: ListTab, snapshot: readonly SpecialistProcurementCard[]): void => {
    if (hasLoad) {
      setLists((current) => {
        const state = current[tab];
        return state !== undefined && "items" in state
          ? { ...current, [tab]: { ...state, items: snapshot } }
          : current;
      });
    } else {
      setRemote(snapshot);
    }
  };
  const setPending = (key: string, on: boolean): void => {
    setPendingIds((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  async function runCardAction(
    item: SpecialistProcurementCard,
    action: (() => Promise<unknown> | void) | undefined,
    dropFromList = false,
    op = "action",
  ): Promise<void> {
    const key = `${item.id}:${op}`;
    if (action === undefined || pendingIds.has(key)) return;
    setPending(key, true);
    const tab = activeTab;
    const snapshot = hasLoad ? (listItems ?? []) : source;
    if (dropFromList) {
      patchItems((items) => items.filter((card) => card.id !== item.id));
    }
    try {
      await action();
      setActionError(undefined);
      if (!dropFromList && hasLoad) {
        patchItems((items) =>
          items.map((card) =>
            card.id === item.id ? { ...card, archived: item.archived !== true } : card,
          ),
        );
      }
    } catch (error) {
      if (dropFromList) restoreItems(tab, snapshot);
      setActionError(errorText(error, "Действие не сохранено."));
    } finally {
      setPending(key, false);
    }
  }

  async function runEmptyTrash(): Promise<void> {
    if (onEmptyTrash === undefined || pendingIds.has("empty")) return;
    setPending("empty", true);
    const snapshot = hasLoad ? (listItems ?? []) : source;
    patchItems((items) => items.filter((card) => card.triage !== "reject"));
    try {
      await onEmptyTrash();
      setActionError(undefined);
    } catch (error) {
      restoreItems("trash", snapshot);
      setActionError(errorText(error, "Не удалось очистить корзину."));
    } finally {
      setPending("empty", false);
    }
  }

  const emptyMessage =
    byDecision.length > 0 && visible.length === 0 && query.length > 0
      ? "По запросу ничего не нашлось."
      : isTrash
        ? "Корзина пуста."
        : byDecision.length > 0 && visible.length === 0
          ? "Нет закупок по выбранному профилю."
          : EMPTY_TEXT[filter];

  return (
    <Shell>
      {confirm === undefined ? null : (
        <ConfirmToast
          message={
            confirm.kind === "empty"
              ? `Очистить корзину безвозвратно? Будет удалено ${visible.length} ${pluralRu(visible.length, "запись", "записи", "записей")} — вернуть их уже будет нельзя.`
              : confirm.kind === "purge"
                ? TRASH_PURGE_PROMPT
                : TRASH_MOVE_PROMPT
          }
          danger={confirm.kind === "purge" || confirm.kind === "empty"}
          onConfirm={() => {
            const next = confirm;
            setConfirm(undefined);
            if (next.kind === "empty") {
              void runEmptyTrash();
              return;
            }
            const item = visible.find((card) => card.id === next.id);
            if (item === undefined) return;
            if (next.kind === "purge") {
              void runCardAction(item, () => onPurge?.(item.id), true, "purge");
              return;
            }
            void runCardAction(item, () => onRemove?.(item.id), true, "remove");
          }}
          onCancel={() => {
            setConfirm(undefined);
          }}
        />
      )}
      <main className="my-procurements" ref={listRef}>
        <div className="my-procurements-header">
          <div className="my-procurements-heading">
            <h1>{isTrash ? "Корзина" : "Мои закупки"}</h1>
            {waiting || visible.length === 0 ? null : (
              <p className="my-procurements-count" aria-live="polite">
                {window.from}–{window.to} из {visible.length}
              </p>
            )}
          </div>
          {isTrash && onEmptyTrash !== undefined && visible.length > 0 ? (
            <button
              type="button"
              className="my-procurements-empty-trash"
              disabled={pendingIds.has("empty")}
              onClick={() => {
                setConfirm({ kind: "empty" });
              }}
            >
              {pendingIds.has("empty") ? "Очищаем…" : "Очистить корзину"}
            </button>
          ) : null}
        </div>
        {byDecision.length > 0 ? (
          <div className="my-procurements-search">
            <input
              type="search"
              className="my-procurements-search-input"
              placeholder="Поиск по списку"
              aria-label="Поиск по списку"
              value={listQuery}
              onChange={(event) => {
                setListQuery(event.target.value);
              }}
            />
          </div>
        ) : null}
        {isTrash ? (
          <p className="my-procurements-lead">{EMPTY_TEXT.trash}</p>
        ) : (
          <>
            <div className="my-procurements-filters" role="tablist" aria-label="Фильтр по решению">
              {filterTabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={filter === tab.key}
                  className={
                    filter === tab.key ? "my-procurements-tab-active" : "my-procurements-tab"
                  }
                  onClick={() => {
                    setFilter(tab.key);
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            {showProfileFilter ? (
              <div
                className="my-procurements-profiles"
                role="tablist"
                aria-label="Фильтр по профилю"
              >
                <span className="my-procurements-profiles-label">Профиль</span>
                <button
                  type="button"
                  role="tab"
                  aria-selected={profileFilter === "all"}
                  className={
                    profileFilter === "all"
                      ? "my-procurements-profile-active"
                      : "my-procurements-profile"
                  }
                  onClick={() => {
                    setProfileFilter("all");
                  }}
                >
                  Все закупки
                </button>
                {profiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    role="tab"
                    aria-selected={profileFilter === profile.id}
                    className={
                      profileFilter === profile.id
                        ? "my-procurements-profile-active"
                        : "my-procurements-profile"
                    }
                    onClick={() => {
                      setProfileFilter(profile.id);
                    }}
                  >
                    {profileDisplayName(profile)}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
        {actionError === undefined ? null : (
          <p className="my-procurements-error" role="alert">
            Не удалось сохранить изменение: {actionError}
          </p>
        )}
        {staleNote === undefined ? null : (
          <p className="my-procurements-stale" role="status">
            Список не обновился: {staleNote.message} Показаны данные от{" "}
            {staleNote.updatedAt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}.{" "}
            <button
              type="button"
              className="my-procurements-retry"
              disabled={refreshing}
              onClick={() => {
                runListLoad(activeTab);
              }}
            >
              {refreshing ? "Обновляем…" : "Повторить"}
            </button>
          </p>
        )}
        {waiting ? (
          <p className="my-procurements-empty">Загрузка…</p>
        ) : listFailed ? (
          <div className="my-procurements-error" role="alert">
            <p>{tabState !== undefined && tabState.kind === "error" ? tabState.message : "Не удалось загрузить список."}</p>
            <button
              type="button"
              className="my-procurements-retry"
              onClick={() => {
                runListLoad(activeTab);
              }}
            >
              Повторить
            </button>
          </div>
        ) : visible.length === 0 ? (
          <p className="my-procurements-empty">{emptyMessage}</p>
        ) : (
          <>
            <ul
              key={`${activeTab}:${profileFilter}:${safePage}`}
              className="my-procurements-grid"
            >
              {pageItems.map((item) => {
                const procedureKind = cardProcedureKindLabel(item);
                const deadline = printDeadline(item.watchSnapshot?.bidsDeadline);
                const names = profileNamesForCard(item, profiles);
                return (
                  <li key={item.id}>
                    <article className={`my-procurements-card is-${item.triage ?? "unknown"}`}>
                      <button
                        type="button"
                        className="my-procurements-card-main"
                        aria-label={`Открыть: ${item.title}`}
                        onClick={() => {
                          void navigate(
                            isTrash ? `/trash/${item.id}` : `/my-procurements/${item.id}`,
                          );
                        }}
                      >
                        <div className="my-procurements-card-header">
                          <span className={`my-procurements-card-triage triage-${item.triage ?? ""}`}>
                            {item.triage === "monitor"
                              ? "Слежу"
                              : item.triage === "participate"
                                ? "Участвую"
                                : "Корзина"}
                          </span>
                          <span className="my-procurements-card-status">{item.statusLabel}</span>
                          {bidsDeadlinePassed(item, today) ? (
                            <span className="my-procurements-card-expired">срок подачи истёк</span>
                          ) : null}
                          {item.sourceCard !== undefined &&
                          isSingleSourceAfterFailedProcedure(item.sourceCard) ? (
                            <span className="my-procurements-card-after-failed">
                              после несостоявшейся
                            </span>
                          ) : null}
                          {profileFilter === "all" && names.length > 0
                            ? names.slice(0, 1).map((name) => (
                                <span key={name} className="my-procurements-card-profile">
                                  {name}
                                </span>
                              ))
                            : null}
                          <span className="my-procurements-card-id">{shortId(item.id)}</span>
                        </div>
                        <CardTitle title={item.title} />
                        <CardIngestCaption ingest={activeIngest[item.id]} />
                        <dl className="my-procurements-card-facts">
                          {procedureKind === undefined ? null : (
                            <div className="my-procurements-card-fact-kind">
                              <dt>Вид процедуры</dt>
                              <dd className="my-procurements-card-kind">{procedureKind}</dd>
                            </div>
                          )}
                          {item.amountLabel ? (
                            <div>
                              <dt>Стоимость</dt>
                              <dd className="my-procurements-card-amount">{item.amountLabel}</dd>
                            </div>
                          ) : null}
                          {deadline === undefined ? null : (
                            <div>
                              <dt>Приём до</dt>
                              <dd>{deadline}</dd>
                            </div>
                          )}
                        </dl>
                        {item.buyerName || item.sourceCard?.buyer?.contact ? (
                          <div className="my-procurements-card-buyer-block">
                            {item.buyerName ? (
                              <p className="my-procurements-card-buyer">{item.buyerName}</p>
                            ) : null}
                            {item.sourceCard?.buyer?.contact ? (
                              <p className="my-procurements-card-contact">
                                {item.sourceCard.buyer.contact}
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                      </button>
                      {isTrash ? (
                        <div className="my-procurements-card-actions">
                          {onRestore !== undefined ? (
                            <button
                              type="button"
                              className="my-procurements-card-action"
                              disabled={pendingIds.has(`${item.id}:restore`)}
                              onClick={() => {
                                void runCardAction(item, () => onRestore(item.id), true, "restore");
                              }}
                            >
                              Вернуть
                            </button>
                          ) : null}
                          {onPurge !== undefined ? (
                            <button
                              type="button"
                              className="my-procurements-card-action my-procurements-card-action-danger"
                              disabled={pendingIds.has(`${item.id}:purge`)}
                              onClick={() => {
                                setConfirm({ kind: "purge", id: item.id });
                              }}
                            >
                              Удалить
                            </button>
                          ) : null}
                        </div>
                      ) : onArchive !== undefined || onRemove !== undefined ? (
                        <div className="my-procurements-card-actions">
                          {onArchive !== undefined ? (
                            <button
                              type="button"
                              className="my-procurements-card-action"
                              disabled={pendingIds.has(`${item.id}:archive`)}
                              onClick={() => {
                                void runCardAction(item, () => onArchive(item.id, !item.archived), false, "archive");
                              }}
                            >
                              {item.archived ? "Вернуть" : "В архив"}
                            </button>
                          ) : null}
                          {onRemove !== undefined ? (
                            <button
                              type="button"
                              className="my-procurements-card-action my-procurements-card-action-danger"
                              disabled={pendingIds.has(item.id)}
                              onClick={() => {
                                setConfirm({ kind: "remove", id: item.id });
                              }}
                            >
                              Убрать
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  </li>
                );
              })}
            </ul>
            {pageCount > 1 ? (
              <nav className="my-procurements-pager" aria-label="Страницы списка">
                <button
                  type="button"
                  className="my-procurements-pager-step"
                  disabled={safePage === 0}
                  onClick={() => {
                    goToPage(safePage - 1);
                  }}
                >
                  Назад
                </button>
                <div className="my-procurements-pager-pages">
                  {pageNumbers(pageCount, safePage).map((index, position, all) => {
                    const previous = all[position - 1];
                    const gap = previous !== undefined && index - previous > 1;
                    return (
                      <span key={index} className="my-procurements-pager-slot">
                        {gap ? <span className="my-procurements-pager-ellipsis">…</span> : null}
                        <button
                          type="button"
                          className={
                            index === safePage
                              ? "my-procurements-pager-page is-current"
                              : "my-procurements-pager-page"
                          }
                          aria-current={index === safePage ? "page" : undefined}
                          onClick={() => {
                            goToPage(index);
                          }}
                        >
                          {index + 1}
                        </button>
                      </span>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="my-procurements-pager-step"
                  disabled={safePage >= pageCount - 1}
                  onClick={() => {
                    goToPage(safePage + 1);
                  }}
                >
                  Вперёд
                </button>
              </nav>
            ) : null}
          </>
        )}
      </main>
    </Shell>
  );
}
