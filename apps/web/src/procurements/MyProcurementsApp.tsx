import { useEffect, useRef, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import type { SpecialistIngestProgress, SpecialistProcurementCard } from "@procurement/contracts";
import {
  bidsDeadlinePassed,
  cardProcedureKindLabel,
  isIngestRunning,
  isSingleSourceAfterFailedProcedure,
} from "@procurement/domain";
import { ConfirmToast, TRASH_EMPTY_PROMPT, TRASH_MOVE_PROMPT, TRASH_PURGE_PROMPT } from "../shell/ConfirmToast.js";
import { Shell } from "../shell/Shell.js";
import { ingestProgressCaption } from "./ProcurementsApp.js";

type MineTab = "all" | "monitor" | "participate" | "archive";
export type MyProcurementsSection = "mine" | "trash";
type ListTab = MineTab | "trash";

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

function CardIngestCaption({ ingest }: { ingest: SpecialistIngestProgress | undefined }) {
  const running = runningIngest(ingest);
  if (running === undefined) return null;
  return <p className="my-procurements-card-ingest">{ingestProgressCaption(running)}</p>;
}

export function MyProcurementsApp({
  procurements,
  section = "mine",
  onArchive,
  onRemove,
  onRestore,
  onPurge,
  onEmptyTrash,
  load,
  now = () => new Date(),
  activeIngest = {},
}: {
  procurements: readonly SpecialistProcurementCard[];
  section?: MyProcurementsSection;
  onArchive?: (id: string, archived: boolean) => Promise<unknown> | void;
  onRemove?: (id: string) => Promise<unknown> | void;
  onRestore?: (id: string) => Promise<unknown> | void;
  onPurge?: (id: string) => Promise<unknown> | void;
  onEmptyTrash?: () => Promise<unknown> | void;
  load?: (tab: ListTab) => Promise<readonly SpecialistProcurementCard[]>;
  now?: () => Date;
  activeIngest?: Record<string, SpecialistIngestProgress>;
}): ReactElement {
  const navigate = useNavigate();
  const today = now();
  const isTrash = section === "trash";
  const [filter, setFilter] = useState<MineTab>("all");
  const [pendingId, setPendingId] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<
    { kind: "empty" } | { kind: "purge" | "remove"; id: string } | undefined
  >();
  const [remote, setRemote] = useState<readonly SpecialistProcurementCard[] | undefined>(undefined);
  const [loadedTab, setLoadedTab] = useState<ListTab | undefined>(undefined);
  const activeTab: ListTab = isTrash ? "trash" : filter;
  const hasLoad = load !== undefined;
  const loadRef = useRef(load);
  loadRef.current = load;

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
  const visible = isTrash
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
      <main className="my-procurements">
        <div className="my-procurements-header">
          <h1>{isTrash ? "Корзина" : "Мои закупки"}</h1>
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
        )}
        {waiting ? (
          <p className="my-procurements-empty">Загрузка…</p>
        ) : visible.length === 0 ? (
          <p className="my-procurements-empty">{isTrash ? "Корзина пуста." : EMPTY_TEXT[filter]}</p>
        ) : (
          <ul className="my-procurements-grid">
            {visible.map((item) => {
              const procedureKind = cardProcedureKindLabel(item);
              return (
              <li key={item.id}>
                <div className={`my-procurements-card is-${item.triage ?? "unknown"}`}>
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
                      <span className="my-procurements-card-id">{shortId(item.id)}</span>
                    </div>
                    <h2 className="my-procurements-card-title">{item.title}</h2>
                    <CardIngestCaption ingest={activeIngest[item.id]} />
                    <dl className="my-procurements-card-facts">
                      {procedureKind === undefined ? null : (
                        <div>
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
                      {item.watchSnapshot?.bidsDeadline ? (
                        <div>
                          <dt>Приём до</dt>
                          <dd>{item.watchSnapshot.bidsDeadline}</dd>
                        </div>
                      ) : null}
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
                    <span className="my-procurements-card-footer" aria-hidden="true">
                      Открыть карточку <span className="my-procurements-card-arrow">→</span>
                    </span>
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
                </div>
              </li>
              );
            })}
          </ul>
        )}
      </main>
    </Shell>
  );
}
