import { useEffect, useState } from "react";
import type {
  AdminJournalEntry,
  AdminJournalListResponse,
  AdminUser,
  AdminUserListResponse,
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
import { accessMessage, journalKindLabel, roleLabel } from "../auth/labels.js";
import { useAuthSession } from "../auth/AuthSession.js";
import { Shell } from "../shell/Shell.js";

const ROLES: SpecialistRole[] = ["specialist", "viewer", "admin"];

type JournalFilter = "all" | "errors" | "access";

export function AdminApp() {
  const { refresh } = useAuthSession();
  const [listed, setListed] = useState<AdminUserListResponse | undefined>();
  const [journal, setJournal] = useState<AdminJournalListResponse | undefined>();
  const [filter, setFilter] = useState<JournalFilter>("all");
  const [error, setError] = useState<string | undefined>();
  const [roles, setRoles] = useState<Record<string, SpecialistRole>>({});

  async function load(): Promise<void> {
    try {
      const [next, log] = await Promise.all([fetchAdminUsers(), fetchAdminJournal()]);
      setListed(next);
      setJournal(log);
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

  const pending = listed?.items.filter((user) => user.accessStatus === "pending") ?? [];
  const others = listed?.items.filter((user) => user.accessStatus !== "pending") ?? [];
  const journalItems = visibleJournal(journal?.items ?? [], filter);
  const errorCount = journal?.errorCount ?? 0;

  return (
    <Shell>
      <main className="admin-workspace">
        <section className="profile-section">
          <h1>Администрирование</h1>
          <p className="profile-lead">Заявки на доступ, роли и журнал обслуживания.</p>
          {error !== undefined ? <p className="auth-error">{error}</p> : null}
        </section>
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
        <section className="profile-section">
          <h2>Журнал {errorCount > 0 ? `(ошибки: ${String(errorCount)})` : ""}</h2>
          <p className="profile-hint">
            Вход, выход и смена доступа. Ошибки площадки считаются за 7 дней. Время в системе —
            до последнего запроса, не до закрытия вкладки.
          </p>
          <div className="inbox-search">
            <button
              type="button"
              className={filter === "all" ? "search-profile is-pressed-monitor" : "search-profile"}
              onClick={() => setFilter("all")}
            >
              Все
            </button>
            <button
              type="button"
              className={filter === "errors" ? "search-profile is-pressed-reject" : "search-profile"}
              onClick={() => setFilter("errors")}
            >
              Ошибки
            </button>
            <button
              type="button"
              className={filter === "access" ? "search-profile is-pressed-monitor" : "search-profile"}
              onClick={() => setFilter("access")}
            >
              Доступ
            </button>
          </div>
          {journalItems.length === 0 ? (
            <p className="profile-empty-queries">Записей нет.</p>
          ) : (
            <ul className="admin-list">
              {journalItems.map((item) => (
                <li key={item.id} className={item.level === "error" ? "admin-row is-journal-error" : "admin-row"}>
                  <div>
                    <strong>{journalKindLabel(item.kind)}</strong>
                    <p className="profile-list-meta">{formatJournalTime(item.at)}</p>
                    <p>{item.message}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </Shell>
  );
}

function visibleJournal(
  items: readonly AdminJournalEntry[],
  filter: JournalFilter,
): readonly AdminJournalEntry[] {
  if (filter === "errors") return items.filter((item) => item.level === "error");
  if (filter === "access") return items.filter((item) => item.kind === "access");
  return items;
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
