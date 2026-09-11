import { useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import type { SpecialistProcurementCard, SpecialistTriageKind } from "@procurement/contracts";
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
}: {
  procurements: readonly SpecialistProcurementCard[];
}): ReactElement {
  const navigate = useNavigate();
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
                  className="my-procurements-card"
                  aria-label={`Открыть: ${item.title}`}
                  onClick={() => {
                    void navigate(`/my-procurements/${item.id}`);
                  }}
                >
                <div className="my-procurements-card-header">
                  <span className="my-procurements-card-id">{shortId(item.id)}</span>
                  <span className={`my-procurements-card-triage triage-${item.triage ?? ""}`}>
                    {item.triage === "monitor" ? "Слежу" : "Участвую"}
                  </span>
                </div>
                <h2 className="my-procurements-card-title">{item.title}</h2>
                <div className="my-procurements-card-meta">
                  <span className="my-procurements-card-status">{item.statusLabel}</span>
                  {item.amountLabel ? (
                    <span className="my-procurements-card-amount">{item.amountLabel}</span>
                  ) : null}
                  {item.watchSnapshot?.bidsDeadline ? (
                    <span className="my-procurements-card-deadline">
                      приём до {item.watchSnapshot.bidsDeadline}
                    </span>
                  ) : null}
                </div>
                {item.buyerName ? (
                  <p className="my-procurements-card-buyer">{item.buyerName}</p>
                ) : null}
                {item.sourceCard?.buyer?.contact ? (
                  <p className="my-procurements-card-contact">{item.sourceCard.buyer.contact}</p>
                ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </Shell>
  );
}
