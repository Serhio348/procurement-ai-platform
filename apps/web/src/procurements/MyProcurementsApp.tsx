import { useEffect, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import type { SpecialistProcurementCard } from "@procurement/contracts";
import { bidsDeadlinePassed, isSingleSourceAfterFailedProcedure } from "@procurement/domain";
import { Shell } from "../shell/Shell.js";

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

export function MyProcurementsApp({
  procurements,
  section = "mine",
  onArchive,
  onRemove,
  onRestore,
  onPurge,
  load,
  now = () => new Date(),
}: {
  procurements: readonly SpecialistProcurementCard[];
  section?: MyProcurementsSection;
  onArchive?: (id: string, archived: boolean) => Promise<unknown> | void;
  onRemove?: (id: string) => Promise<unknown> | void;
  onRestore?: (id: string) => Promise<unknown> | void;
  onPurge?: (id: string) => Promise<unknown> | void;
  load?: (tab: ListTab) => Promise<readonly SpecialistProcurementCard[]>;
  now?: () => Date;
}): ReactElement {
  const navigate = useNavigate();
  const today = now();
  const isTrash = section === "trash";
  const [filter, setFilter] = useState<MineTab>("all");
  const [pendingId, setPendingId] = useState<string | undefined>();
  const [remote, setRemote] = useState<readonly SpecialistProcurementCard[] | undefined>(undefined);
  const activeTab: ListTab = isTrash ? "trash" : filter;

  useEffect(() => {
    if (load === undefined) {
      setRemote(undefined);
      return undefined;
    }
    let cancelled = false;
    void load(activeTab).then((items) => {
      if (!cancelled) setRemote(items);
    });
    return () => {
      cancelled = true;
    };
  }, [activeTab, load]);

  const source = remote ?? procurements;
  const decided = source.filter((item) => isDecided(item) && item.archived !== true);
  const archived = source.filter(
    (item) => item.archived === true && item.triage !== "reject",
  );
  const trashed = source.filter((item) => item.triage === "reject");
  // When load() is set it already returns the active tab. Filtering that page
  // again (e.g. Архив against a «Все» response) emptied the list. Still drop
  // reject so trash cannot leak into Мои закупки.
  const visible = isTrash
    ? trashed
    : load !== undefined
      ? source.filter((item) => item.triage !== "reject")
      : filter === "archive"
        ? archived
        : filter === "all"
          ? decided
          : decided.filter((item) => item.triage === filter);

  async function runCardAction(
    item: SpecialistProcurementCard,
    action: (() => Promise<unknown> | void) | undefined,
  ): Promise<void> {
    if (action === undefined || pendingId !== undefined) return;
    setPendingId(item.id);
    try {
      await action();
      if (load !== undefined) {
        setRemote(await load(activeTab));
      }
    } finally {
      setPendingId(undefined);
    }
  }

  return (
    <Shell>
      <main className="my-procurements">
        <h1>{isTrash ? "Корзина" : "Мои закупки"}</h1>
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
        {visible.length === 0 ? (
          <p className="my-procurements-empty">{isTrash ? "Корзина пуста." : EMPTY_TEXT[filter]}</p>
        ) : (
          <ul className="my-procurements-grid">
            {visible.map((item) => (
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
                    <dl className="my-procurements-card-facts">
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
                            void runCardAction(item, () => onRestore(item.id));
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
                            if (
                              !window.confirm(
                                "Удалить закупку из корзины безвозвратно? Вернуть её уже будет нельзя.",
                              )
                            ) {
                              return;
                            }
                            void runCardAction(item, () => onPurge(item.id));
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
                            if (
                              !window.confirm(
                                "Убрать закупку в корзину? Потом её можно вернуть или удалить.",
                              )
                            ) {
                              return;
                            }
                            void runCardAction(item, () => onRemove(item.id));
                          }}
                        >
                          Убрать
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </Shell>
  );
}
