import type { SpecialistInboxEntry } from "@procurement/contracts";

export interface InboxPageProps {
  entries: readonly SpecialistInboxEntry[];
  selectedId?: string;
  onSelect?: (id: string) => void;
}

export function InboxPage(props: InboxPageProps) {
  const selected =
    props.entries.find((entry) => entry.id === props.selectedId) ?? props.entries[0];

  return (
    <main className="workspace">
      <section className="inbox" aria-labelledby="inbox-heading">
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
                    onClick={() => props.onSelect?.(entry.id)}
                  >
                    <span className="inbox-row-top">
                      <span className="inbox-title">{entry.title}</span>
                      <span className="urgent-mark">Срочно</span>
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
          </>
        )}
      </section>
    </main>
  );
}
