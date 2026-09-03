import { useNavigate, useParams } from "react-router-dom";
import type { SpecialistProcurementCard } from "@procurement/contracts";
import { Shell } from "../shell/Shell.js";

export function ProcurementsApp({ items }: { items: readonly SpecialistProcurementCard[] }) {
  const params = useParams();
  const navigate = useNavigate();
  const selected =
    items.find((item) => item.id === params["id"]) ?? items[0];

  return (
    <Shell>
      <main className="workspace">
        <section className="inbox" aria-labelledby="procurements-heading">
          <h1 id="procurements-heading">Закупки</h1>
          {items.length === 0 ? (
            <p className="empty">Нет закупок в работе</p>
          ) : (
            <ul className="inbox-list">
              {items.map((item) => {
                const isSelected = selected?.id === item.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={isSelected ? "inbox-row is-selected" : "inbox-row"}
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => {
                        void navigate(`/procurements/${item.id}`);
                      }}
                    >
                      <span className="inbox-row-top">
                        <span className="inbox-title">{item.title}</span>
                        {item.latestChange?.urgent === true ? (
                          <span className="urgent-mark">Срочно</span>
                        ) : null}
                      </span>
                      <span className="inbox-summary">{item.statusLabel}</span>
                      <span className="inbox-date">{item.sourceProcurementId}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="detail" aria-labelledby="case-heading">
          {selected === undefined ? (
            <>
              <h2 id="case-heading">Закупка</h2>
              <p className="empty">Нет закупок в работе</p>
            </>
          ) : (
            <>
              <h2 id="case-heading">{selected.title}</h2>
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
              {selected.latestChange === undefined ? null : (
                <>
                  <h3>Последнее изменение</h3>
                  <pre className="change-body">{selected.latestChange.detail}</pre>
                </>
              )}
            </>
          )}
        </section>
      </main>
    </Shell>
  );
}
