import { useEffect, useRef, useState } from "react";
import type { SpecialistInboxAction, SpecialistInboxEntry } from "@procurement/contracts";
import { ConfirmToast } from "../shell/ConfirmToast.js";

const isNarrowViewport = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(max-width: 768px)").matches;

function pluralRu(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export interface InboxPageProps {
  entries: readonly SpecialistInboxEntry[];
  selectedId?: string;
  busyId?: string;
  clearing?: boolean;
  onSelect?: (id: string) => void;
  onResolve?: (id: string, action: SpecialistInboxAction) => void;
  onDismissAll?: () => void;
}

const NEW_INBOX_TOPICS = new Set(["new_found", "review"]);

const INBOX_GROUPS = [
  { key: "new", title: "Новые закупки" },
  { key: "watched", title: "Изменения в моих закупках" },
] as const;

export function InboxPage(props: InboxPageProps) {
  const selected =
    props.entries.find((entry) => entry.id === props.selectedId) ?? props.entries[0];
  const groups = INBOX_GROUPS.map((group) => ({
    ...group,
    entries: props.entries.filter((entry) =>
      group.key === "new" ? NEW_INBOX_TOPICS.has(entry.topic) : !NEW_INBOX_TOPICS.has(entry.topic),
    ),
  }));

  // R32: on narrow screens the card renders above the list — tapping a row
  // deep in the list must bring the opened card (and its actions) into view.
  const detailRef = useRef<HTMLElement>(null);
  const selectedId = selected?.id;
  useEffect(() => {
    if (selectedId === undefined || !isNarrowViewport()) return;
    detailRef.current?.scrollIntoView({ block: "start" });
  }, [selectedId]);

  const [confirmClear, setConfirmClear] = useState(false);

  return (
    <main className="workspace">
      {confirmClear ? (
        <ConfirmToast
          confirmLabel="Очистить"
          message={`Очистить входящие? ${props.entries.length} ${pluralRu(
            props.entries.length,
            "запись",
            "записи",
            "записей",
          )} будет отмечено как разобранные — те же события повторно не появятся, новые изменения продолжат приходить.`}
          onConfirm={() => {
            setConfirmClear(false);
            props.onDismissAll?.();
          }}
          onCancel={() => setConfirmClear(false)}
        />
      ) : null}
      <section className="inbox" aria-labelledby="inbox-heading">
        {props.entries.some((entry) => entry.urgent) ? (
          <p className="inbox-alarm" role="status">
            Тревога: есть срочные изменения в отслеживаемых закупках
          </p>
        ) : props.entries.length > 0 ? (
          <p className="inbox-review-note" role="status">
            На проверку: система не уверена в релевантности кандидатов — решение
            за вами
          </p>
        ) : null}
        <div className="inbox-toolbar">
          <h1 id="inbox-heading">Входящие</h1>
          {props.entries.length === 0 || props.onDismissAll === undefined ? null : (
            <button
              type="button"
              className="inbox-clear"
              disabled={props.clearing === true}
              onClick={() => setConfirmClear(true)}
            >
              {props.clearing === true ? "Очищаем…" : "Очистить всё"}
            </button>
          )}
        </div>
        {props.entries.length === 0 ? (
          <p className="empty">Новых изменений нет</p>
        ) : (
          groups
            .filter((group) => group.entries.length > 0)
            .map((group) => (
              <section key={group.key} aria-label={group.title}>
                <h2 className="inbox-group">
                  {group.title} ({group.entries.length})
                </h2>
                <ul className="inbox-list">
                  {group.entries.map((entry) => {
                    const isSelected = selected?.id === entry.id;
                    return (
                      <li key={entry.id}>
                        <button
                          type="button"
                          className={isSelected ? "inbox-row is-selected" : "inbox-row"}
                          aria-current={isSelected ? "true" : undefined}
                          onClick={() => {
                            props.onSelect?.(entry.id);
                          }}
                        >
                          <span className="inbox-row-top">
                            <span className="inbox-title">{entry.title}</span>
                            <span className="inbox-marks">
                              <span className={`inbox-topic is-${entry.topic}`}>
                                {entry.topicLabel}
                              </span>
                            </span>
                          </span>
                          <span className="inbox-summary">{entry.summary}</span>
                          <span className="inbox-date">{entry.detectedOn}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
        )}
      </section>

      <section ref={detailRef} className="detail" aria-labelledby="detail-heading">
        {selected === undefined ? (
          <>
            <h2 id="detail-heading">Закупка</h2>
            <p className="empty">Новых изменений нет</p>
          </>
        ) : (
          <>
            <h2 id="detail-heading">{selected.title}</h2>
            <dl className="detail-meta">
              <div>
                <dt>Номер</dt>
                <dd>{selected.sourceProcurementId}</dd>
              </div>
              <div>
                <dt>Статус</dt>
                <dd>{selected.statusLabel}</dd>
              </div>
              <div>
                <dt>Площадка</dt>
                <dd>
                  <a href={selected.url} target="_blank" rel="noreferrer">
                    {selected.url}
                  </a>
                </dd>
              </div>
              {selected.profileNames.length > 0 ? (
                <div>
                  <dt>Профиль</dt>
                  <dd>{selected.profileNames.join(", ")}</dd>
                </div>
              ) : null}
            </dl>
            {selected.topic === "review" ? (
              <>
                <h3>Почему на проверку</h3>
                <p className="review-reason">
                  {selected.reviewReason ??
                    "Система не смогла уверенно определить релевантность — проверьте карточку вручную."}
                </p>
              </>
            ) : null}
            <h3>Изменение</h3>
            <pre className="change-body">{selected.detail}</pre>
            <div className="inbox-actions">
              {selected.topic === "new_found" ? (
                <button
                  type="button"
                  className="inbox-open"
                  disabled={props.busyId === selected.id}
                  onClick={() => props.onResolve?.(selected.id, "open")}
                >
                  Открыть карточку
                </button>
              ) : null}
              {selected.topic === "documents" ? (
                <button
                  type="button"
                  className="profile-fill"
                  disabled={props.busyId === selected.id}
                  onClick={() => props.onResolve?.(selected.id, "documents")}
                >
                  Скачать документы
                </button>
              ) : null}
              {selected.topic === "card_update" ? (
                <button
                  type="button"
                  className="profile-fill"
                  disabled={props.busyId === selected.id}
                  onClick={() => props.onResolve?.(selected.id, "refresh")}
                >
                  Обновить карточку
                </button>
              ) : null}
              {selected.topic !== "new_found" ? (
                <button
                  type="button"
                  className="inbox-open"
                  disabled={props.busyId === selected.id}
                  onClick={() => props.onResolve?.(selected.id, "open")}
                >
                  Открыть карточку
                </button>
              ) : null}
              <button
                type="button"
                className="admin-danger"
                disabled={props.busyId === selected.id}
                onClick={() => props.onResolve?.(selected.id, "dismiss")}
              >
                Удалить
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
