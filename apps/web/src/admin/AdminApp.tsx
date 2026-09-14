import { useEffect, useState } from "react";
import { NavLink, Navigate, useParams } from "react-router-dom";
import type {
  AdminJournalEntry,
  AdminJournalListResponse,
  AdminUser,
  AdminUserListResponse,
  SpecialistProfileListResponse,
  SpecialistRole,
} from "@procurement/contracts";
import {
  approveUser,
  changeUserRole,
  fetchAdminJournal,
  fetchAdminUsers,
  rejectUser,
  revokeUser,
} from "../api/auth.js";
import { fetchProfiles } from "../api/specialist.js";
import { accessMessage, journalKindLabel, roleLabel } from "../auth/labels.js";
import { useAuthSession } from "../auth/AuthSession.js";
import { Shell } from "../shell/Shell.js";
import { CabinetsPane } from "./CabinetsPane.js";
import {
  ADMIN_PANES,
  adminPaneLabel,
  adminPaneLead,
  adminPanePath,
  journalForPane,
  lastDiscoveryEntry,
  parseAdminPane,
} from "./panes.js";

const ROLES: SpecialistRole[] = ["specialist", "viewer", "admin"];

export function AdminApp() {
  const { pane: rawPane, userId } = useParams();
  const pane = parseAdminPane(rawPane);
  const { refresh } = useAuthSession();
  const [listed, setListed] = useState<AdminUserListResponse | undefined>();
  const [journal, setJournal] = useState<AdminJournalListResponse | undefined>();
  const [profiles, setProfiles] = useState<SpecialistProfileListResponse | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [roles, setRoles] = useState<Record<string, SpecialistRole>>({});

  async function load(): Promise<void> {
    try {
      const [next, log, listedProfiles] = await Promise.all([
        fetchAdminUsers(),
        fetchAdminJournal(),
        fetchProfiles().catch(() => undefined),
      ]);
      setListed(next);
      setJournal(log);
      setProfiles(listedProfiles);
      setRoles((current) => {
        const merged = { ...current };
        for (const user of next.items) {
          merged[user.id] = user.role ?? "specialist";
        }
        return merged;
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить администрирование");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (pane === undefined) {
    return <Navigate to={adminPanePath("access")} replace />;
  }

  const pending = listed?.items.filter((user) => user.accessStatus === "pending") ?? [];
  const others = listed?.items.filter((user) => user.accessStatus !== "pending") ?? [];
  const journalItems = journalForPane(journal?.items ?? [], pane);
  const errorCount = journal?.errorCount ?? 0;
  const presenceCount = journalForPane(journal?.items ?? [], "presence").length;
  const lastDiscovery = lastDiscoveryEntry(journal?.items ?? []);
  const watching = profiles?.items.filter((item) => item.watchNewProcurements) ?? [];

  return (
    <Shell>
      <main className="admin-workspace">
        <section className="profile-section">
          <h1>Администрирование</h1>
          <p className="profile-lead">{adminPaneLead(pane)}</p>
          {error !== undefined ? <p className="auth-error">{error}</p> : null}
          <nav className="admin-panes" aria-label="Разделы администрирования">
            {ADMIN_PANES.map((item) => (
              <NavLink
                key={item}
                to={adminPanePath(item)}
                className={({ isActive }) =>
                  isActive
                    ? item === "errors"
                      ? "search-profile is-pressed-reject"
                      : "search-profile is-pressed-monitor"
                    : "search-profile"
                }
              >
                {adminPaneLabel(item)}
                {item === "access" && pending.length > 0 ? ` (${String(pending.length)})` : ""}
                {item === "presence" && presenceCount > 0 ? ` (${String(presenceCount)})` : ""}
                {item === "discovery" && lastDiscovery?.level === "error" ? " !" : ""}
                {item === "errors" && errorCount > 0 ? ` (${String(errorCount)})` : ""}
              </NavLink>
            ))}
          </nav>
        </section>
        {pane === "discovery" ? (
          <>
            <section className="profile-section">
              <h2>Последний сбор</h2>
              {lastDiscovery === undefined ? (
                <p className="profile-empty-queries">Ещё не было успешного прохода. Сбор идёт раз в час, если на профиле включено слежение.</p>
              ) : (
                <>
                  <p className="profile-list-meta">{formatJournalTime(lastDiscovery.at)}</p>
                  <p>{lastDiscovery.message}</p>
                </>
              )}
              <p className="profile-hint">Интервал: каждый час.</p>
            </section>
            <section className="profile-section">
              <h2>Профили со слежением</h2>
              {watching.length === 0 ? (
                <p className="profile-empty-queries">Ни на одном профиле слежение не включено. Сбор тогда ничего не ищет.</p>
              ) : (
                <ul className="admin-list">
                  {watching.map((item) => (
                    <li key={item.id} className="admin-row">
                      <div>
                        <strong>{item.name.trim() === "" ? "Без названия" : item.name}</strong>
                        <p className="profile-list-meta">
                          {item.keywords.length > 0
                            ? item.keywords.join(", ")
                            : "Нет ключевых слов — этот профиль сбор пропускает."}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="profile-section">
              <h2>Проходы</h2>
              {journalItems.length === 0 ? (
                <p className="profile-empty-queries">Записей нет.</p>
              ) : (
                <ul className="admin-list">
                  {journalItems.map((item) => (
                    <JournalRow key={item.id} item={item} />
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : pane === "cabinets" ? (
          <CabinetsPane {...(userId === undefined ? {} : { userId })} onError={setError} />
        ) : pane === "access" ? (
          <>
            <section className="profile-section">
              <h2>Заявки {pending.length > 0 ? `(${String(pending.length)})` : ""}</h2>
              {pending.length === 0 ? <p className="profile-empty-queries">Новых заявок нет.</p> : null}
              <ul className="admin-list">
                {pending.map((user) => (
                  <AdminUserRow
                    key={user.id}
                    user={user}
                    role={roles[user.id] ?? "specialist"}
                    onRole={(role) => setRoles((current) => ({ ...current, [user.id]: role }))}
                    onApprove={async () => {
                      setListed(await approveUser(user.id, roles[user.id] ?? "specialist"));
                      await load();
                    }}
                    onReject={async () => {
                      setListed(await rejectUser(user.id));
                      await load();
                    }}
                  />
                ))}
              </ul>
            </section>
            <section className="profile-section">
              <h2>Пользователи</h2>
              <ul className="admin-list">
                {others.map((user) => (
                  <AdminUserRow
                    key={user.id}
                    user={user}
                    role={roles[user.id] ?? user.role ?? "specialist"}
                    onRole={(role) => setRoles((current) => ({ ...current, [user.id]: role }))}
                    {...(user.accessStatus === "active"
                      ? {
                          onChangeRole: async () => {
                            setListed(await changeUserRole(user.id, roles[user.id] ?? "specialist"));
                            await load();
                          },
                          onRevoke: async () => {
                            setListed(await revokeUser(user.id));
                            await load();
                          },
                        }
                      : {})}
                  />
                ))}
              </ul>
            </section>
          </>
        ) : (
          <section className="profile-section">
            <h2>{adminPaneLabel(pane)}</h2>
            {journalItems.length === 0 ? (
              <p className="profile-empty-queries">Записей нет.</p>
            ) : (
              <ul className="admin-list">
                {journalItems.map((item) => (
                  <JournalRow key={item.id} item={item} />
                ))}
              </ul>
            )}
          </section>
        )}
      </main>
    </Shell>
  );
}

function JournalRow({ item }: { item: AdminJournalEntry }) {
  return (
    <li className={item.level === "error" ? "admin-row is-journal-error" : "admin-row"}>
      <div>
        <strong>{journalKindLabel(item.kind)}</strong>
        <p className="profile-list-meta">{formatJournalTime(item.at)}</p>
        <p>{item.message}</p>
      </div>
    </li>
  );
}

function formatJournalTime(at: string): string {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return at;
  const date = parsed.toLocaleDateString("ru-BY");
  const time = parsed.toLocaleTimeString("ru-BY", { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}

function AdminUserRow({
  user,
  role,
  onRole,
  onApprove,
  onReject,
  onChangeRole,
  onRevoke,
}: {
  user: AdminUser;
  role: SpecialistRole;
  onRole: (role: SpecialistRole) => void;
  onApprove?: () => Promise<void>;
  onReject?: () => Promise<void>;
  onChangeRole?: () => Promise<void>;
  onRevoke?: () => Promise<void>;
}) {
  return (
    <li className="admin-row">
      <div>
        <strong>{user.name}</strong>
        <p className="profile-list-meta">
          {user.email}
          {" · "}
          {user.accessStatus === "active" ? roleLabel(user.role) : accessMessage(user.accessStatus)}
        </p>
      </div>
      <div className="admin-actions">
        <label>
          Роль
          <select value={role} onChange={(event) => onRole(event.target.value as SpecialistRole)}>
            {ROLES.map((item) => (
              <option key={item} value={item}>
                {roleLabel(item)}
              </option>
            ))}
          </select>
        </label>
        {onApprove !== undefined ? (
          <button type="button" className="profile-fill" onClick={() => void onApprove()}>
            Одобрить
          </button>
        ) : null}
        {onReject !== undefined ? (
          <button type="button" className="admin-danger" onClick={() => void onReject()}>
            Отклонить
          </button>
        ) : null}
        {onChangeRole !== undefined ? (
          <button type="button" className="profile-fill" onClick={() => void onChangeRole()}>
            Сохранить роль
          </button>
        ) : null}
        {onRevoke !== undefined ? (
          <button type="button" className="admin-danger" onClick={() => void onRevoke()}>
            Отозвать
          </button>
        ) : null}
      </div>
    </li>
  );
}
