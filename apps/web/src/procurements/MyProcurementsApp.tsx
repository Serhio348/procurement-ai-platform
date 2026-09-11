import { useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import type { SpecialistProcurementCard, SpecialistTriageKind } from "@procurement/contracts";
import { bidsDeadlinePassed, isSingleSourceAfterFailedProcedure } from "@procurement/domain";
import { Shell } from "../shell/Shell.js";

const filterTabs: { key: "all" | SpecialistTriageKind; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "monitor", label: "Слежу" },
  { key: "participate", label: "Участвую" },
];

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

export function MyProcurementsApp({
  procurements,
  now = () => new Date(),
}: {
  procurements: readonly SpecialistProcurementCard[];
  now?: () => Date;
}): ReactElement {
  const navigate = useNavigate();
  const today = now();
  const [filter, setFilter] = useState<"all" | SpecialistTriageKind>("all");
  const decided = procurements.filter(
    (item) => item.triage === "monitor" || item.triage === "participate",
  );
  const visible =
    filter === "all" ? decided : decided.filter((item) => item.triage === filter);

  return (
    <Shell>
      <main className="my-procurements">
        <h1>Мои закупки</h1>
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
        {visible.length === 0 ? (
          <p className="my-procurements-empty">
            Здесь будут закупки, по которым нажали «Следить» или «Участвовать».
          </p>
        ) : (
          <ul className="my-procurements-grid">
            {visible.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`my-procurements-card is-${item.triage ?? "unknown"}`}
                  aria-label={`Открыть: ${item.title}`}
                  onClick={() => {
                    void navigate(`/my-procurements/${item.id}`);
                  }}
                >
                  <div className="my-procurements-card-header">
                    <span className={`my-procurements-card-triage triage-${item.triage ?? ""}`}>
                      {item.triage === "monitor" ? "Слежу" : "Участвую"}
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
              </li>
            ))}
          </ul>
        )}
      </main>
    </Shell>
  );
}
