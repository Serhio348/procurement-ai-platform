import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type {
  AdminCabinetSummary,
  SpecialistProcurementCard,
  SpecialistProcurementListTab,
} from "@procurement/contracts";
import { fetchAdminCabinets, fetchAdminUserProcurements } from "../api/auth.js";
import { accessMessage, roleLabel } from "../auth/labels.js";
import { adminPanePath } from "./panes.js";

const CABINET_TABS: { key: SpecialistProcurementListTab; label: string }[] = [
  { key: "all", label: "Мои закупки" },
  { key: "monitor", label: "Слежу" },
  { key: "participate", label: "Участвую" },
  { key: "archive", label: "Архив" },
  { key: "trash", label: "Корзина" },
];

export function CabinetsPane({
  userId,
  onError,
}: {
  userId?: string;
  onError: (message: string | undefined) => void;
}) {
  const [listed, setListed] = useState<readonly AdminCabinetSummary[] | undefined>();
  const [tab, setTab] = useState<SpecialistProcurementListTab>("all");
  const [cards, setCards] = useState<readonly SpecialistProcurementCard[] | undefined>();

  useEffect(() => {
    let cancelled = false;
    void fetchAdminCabinets()
      .then((next) => {
        if (!cancelled) {
          setListed(next.items);
          onError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          onError(cause instanceof Error ? cause.message : "Не удалось загрузить кабинеты");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onError]);

  useEffect(() => {
    setTab("all");
  }, [userId]);

  useEffect(() => {
    if (userId === undefined) {
      setCards(undefined);
      return undefined;
    }
    let cancelled = false;
    void fetchAdminUserProcurements(userId, tab)
      .then((page) => {
        if (!cancelled) {
          setCards(page.items);
          onError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          onError(cause instanceof Error ? cause.message : "Не удалось загрузить закупки кабинета");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [userId, tab, onError]);

  const selected = listed?.find((item) => item.userId === userId);

  if (userId !== undefined) {
    return (
      <section className="profile-section">
        <p>
          <Link to={adminPanePath("cabinets")}>← Все кабинеты</Link>
        </p>
        <h2>{selected?.name ?? "Кабинет"}</h2>
        {selected !== undefined ? (
          <p className="profile-list-meta">
            {selected.email}
            {" · "}
            {cabinetRoleLine(selected)}
            {" · "}
            {cabinetCountsLine(selected)}
            {" · "}
            {cabinetPresenceLine(selected.lastActiveAt)}
          </p>
        ) : null}
        <nav className="admin-panes" aria-label="Разделы кабинета">
          {CABINET_TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={tab === item.key ? "search-profile is-pressed-monitor" : "search-profile"}
              onClick={() => setTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        {cards === undefined ? (
          <p className="profile-empty-queries">Загрузка…</p>
        ) : cards.length === 0 ? (
          <p className="profile-empty-queries">В этом разделе закупок нет.</p>
        ) : (
          <ul className="admin-list">
            {cards.map((card) => (
              <li key={card.id} className="admin-row">
                <div>
                  <strong>
                    <a href={card.url} target="_blank" rel="noreferrer">
                      {card.title}
                    </a>
                  </strong>
                  <p className="profile-list-meta">
                    {card.statusLabel}
                    {card.buyerName !== undefined && card.buyerName.length > 0
                      ? ` · ${card.buyerName}`
                      : ""}
                    {card.amountLabel !== undefined && card.amountLabel.length > 0
                      ? ` · ${card.amountLabel}`
                      : ""}
                    {card.triage !== undefined ? ` · ${triageLabel(card.triage)}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return (
    <section className="profile-section">
      <h2>Кабинеты</h2>
      {listed === undefined ? (
        <p className="profile-empty-queries">Загрузка…</p>
      ) : listed.length === 0 ? (
        <p className="profile-empty-queries">Пользователей ещё нет.</p>
      ) : (
        <ul className="admin-list">
          {listed.map((item) => (
            <li key={item.userId} className="admin-row">
              <div>
                <strong>{item.name}</strong>
                <p className="profile-list-meta">
                  {item.email}
                  {" · "}
                  {cabinetRoleLine(item)}
                </p>
                <p className="profile-list-meta">
                  {cabinetCountsLine(item)}
                  {" · "}
                  {cabinetPresenceLine(item.lastActiveAt)}
                </p>
              </div>
              <div className="admin-actions">
                <Link to={adminPanePath("cabinets", item.userId)} className="profile-fill">
                  Открыть
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function cabinetRoleLine(item: AdminCabinetSummary): string {
  return item.accessStatus === "active" ? roleLabel(item.role) : accessMessage(item.accessStatus);
}

function cabinetCountsLine(item: AdminCabinetSummary): string {
  return `Профили ${String(item.profileCount)} · Мои закупки ${String(item.mineCount)} · Архив ${String(item.archiveCount)} · Корзина ${String(item.trashCount)}`;
}

function cabinetPresenceLine(lastActiveAt: string | undefined): string {
  if (lastActiveAt === undefined) return "Не в сети";
  const parsed = new Date(lastActiveAt);
  if (Number.isNaN(parsed.getTime())) return "В системе";
  const date = parsed.toLocaleDateString("ru-BY");
  const time = parsed.toLocaleTimeString("ru-BY", { hour: "2-digit", minute: "2-digit" });
  return `В системе до ${date} ${time}`;
}

function triageLabel(kind: NonNullable<SpecialistProcurementCard["triage"]>): string {
  if (kind === "monitor") return "Слежу";
  if (kind === "participate") return "Участвую";
  return "Корзина";
}
