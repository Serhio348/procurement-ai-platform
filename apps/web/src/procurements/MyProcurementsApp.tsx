import { useEffect, useRef, useState, type ReactElement } from "react";
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
import { ConfirmToast, TRASH_EMPTY_PROMPT, TRASH_MOVE_PROMPT, TRASH_PURGE_PROMPT } from "../shell/ConfirmToast.js";
import { Shell } from "../shell/Shell.js";
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
  const [page, setPage] = useState(0);
  const [pendingId, setPendingId] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<
    { kind: "empty" } | { kind: "purge" | "remove"; id: string } | undefined
  >();
  const [remote, setRemote] = useState<readonly SpecialistProcurementCard[] | undefined>(undefined);
  const [loadedTab, setLoadedTab] = useState<ListTab | undefined>(undefined);
  const listRef = useRef<HTMLElement | null>(null);
  const activeTab: ListTab = isTrash ? "trash" : filter;
  const hasLoad = load !== undefined;
  const loadRef = useRef(load);
  loadRef.current = load;
  const showProfileFilter = !isTrash && profiles.length > 0;

  useEffect(() => {
    const loader = loadRef.current;
    if (loader === undefined) {
      setRemote(undefined);
      setLoadedTab(undefined);
      return undefined;
    }
    let cancelled = false;
    void loader(activeTab)
      .then((items) => {
        if (!cancelled) {
          setRemote(items);
          setLoadedTab(activeTab);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRemote([]);
          setLoadedTab(activeTab);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, hasLoad]);

  // When load() is set, paint only that tab page. Falling back to the parent
  // catalog mixes archive and search hits into «Все» and reshuffles cards.
  const waiting = hasLoad && loadedTab !== activeTab;
  const source = hasLoad
    ? waiting
      ? []
      : (remote ?? [])
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
  const visible = filterByProfile(byDecision, profiles, profileFilter);

  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = visible.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const window = pageWindow(visible.length, safePage, pageSize);

  useEffect(() => {
    setPage(0);
  }, [activeTab, profileFilter]);

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

  async function runCardAction(
    item: SpecialistProcurementCard,
    action: (() => Promise<unknown> | void) | undefined,
    dropFromList = false,
  ): Promise<void> {
    if (action === undefined || pendingId !== undefined) return;
    setPendingId(item.id);
    const previous = remote;
    if (dropFromList) {
      setRemote((current) => (current ?? source).filter((card) => card.id !== item.id));
    }
    try {
      await action();
      if (!dropFromList && hasLoad) {
        setRemote((current) =>
          (current ?? source).map((card) =>
            card.id === item.id ? { ...card, archived: item.archived !== true } : card,
          ),
        );
      }
    } catch {
      if (dropFromList) setRemote(previous);
    } finally {
      setPendingId(undefined);
    }
  }

  async function runEmptyTrash(): Promise<void> {
    if (onEmptyTrash === undefined || pendingId !== undefined) return;
    setPendingId("empty");
    const previous = remote;
    setRemote([]);
    try {
      await onEmptyTrash();
    } catch {
      setRemote(previous);
    } finally {
      setPendingId(undefined);
    }
  }

  const emptyMessage =
    isTrash
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
              ? TRASH_EMPTY_PROMPT
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
              void runCardAction(item, () => onPurge?.(item.id), true);
              return;
            }
            void runCardAction(item, () => onRemove?.(item.id), true);
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
              disabled={pendingId !== undefined}
              onClick={() => {
                setConfirm({ kind: "empty" });
              }}
            >
              {pendingId === "empty" ? "Очищаем…" : "Очистить корзину"}
            </button>
          ) : null}
        </div>
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
        {waiting ? (
          <p className="my-procurements-empty">Загрузка…</p>
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
                              disabled={pendingId === item.id}
                              onClick={() => {
                                void runCardAction(item, () => onRestore(item.id), true);
                              }}
                            >
                              Вернуть
                            </button>
                          ) : null}
                          {onPurge !== undefined ? (
                            <button
                              type="button"
                              className="my-procurements-card-action my-procurements-card-action-danger"
                              disabled={pendingId === item.id}
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
                              disabled={pendingId === item.id}
                              onClick={() => {
                                void runCardAction(item, () => onArchive(item.id, !item.archived));
                              }}
                            >
                              {item.archived ? "Вернуть" : "В архив"}
                            </button>
                          ) : null}
                          {onRemove !== undefined ? (
                            <button
                              type="button"
                              className="my-procurements-card-action my-procurements-card-action-danger"
                              disabled={pendingId === item.id}
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
