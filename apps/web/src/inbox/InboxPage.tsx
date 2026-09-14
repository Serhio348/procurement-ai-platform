import type { SpecialistInboxAction, SpecialistInboxEntry } from "@procurement/contracts";

export interface InboxPageProps {
  entries: readonly SpecialistInboxEntry[];
  selectedId?: string;
  busyId?: string;
  onSelect?: (id: string) => void;
  onResolve?: (id: string, action: SpecialistInboxAction) => void;
}

export function InboxPage(props: InboxPageProps) {
  const selected =
    props.entries.find((entry) => entry.id === props.selectedId) ?? props.entries[0];

  return (
    <main className="workspace">
      <section className="inbox" aria-labelledby="inbox-heading">
        {props.entries.length > 0 ? (
          <p className="inbox-alarm" role="status">
            Тревога: есть сообщения, которые нужно разобрать
          </p>
        ) : null}
        <h1 id="inbox-heading">Входящие</h1>
        {props.entries.length === 0 ? (
          <p className="empty">Новых изменений нет</p>
        ) : (
          <ul className="inbox-list">
            {props.entries.map((entry) => {
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
                        <span className={`inbox-topic is-${entry.topic}`}>{entry.topicLabel}</span>
                      </span>
                    </span>
                    <span className="inbox-summary">{entry.summary}</span>
                    <span className="inbox-date">{entry.detectedOn}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="detail" aria-labelledby="detail-heading">
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
            </dl>
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
