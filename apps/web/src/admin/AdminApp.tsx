import { useEffect, useState } from "react";
import type { AdminUser, AdminUserListResponse, SpecialistRole } from "@procurement/contracts";
import {
  approveUser,
  changeUserRole,
  fetchAdminUsers,
  rejectUser,
  revokeUser,
} from "../api/auth.js";
import { accessMessage, roleLabel } from "../auth/labels.js";
import { useAuthSession } from "../auth/AuthSession.js";
import { Shell } from "../shell/Shell.js";

const ROLES: SpecialistRole[] = ["specialist", "viewer", "admin"];

export function AdminApp() {
  const { refresh } = useAuthSession();
  const [listed, setListed] = useState<AdminUserListResponse | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [roles, setRoles] = useState<Record<string, SpecialistRole>>({});

  async function load(): Promise<void> {
    try {
      const next = await fetchAdminUsers();
      setListed(next);
      setRoles((current) => {
        const merged = { ...current };
        for (const user of next.items) {
          merged[user.id] = user.role ?? "specialist";
        }
        return merged;
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить пользователей");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const pending = listed?.items.filter((user) => user.accessStatus === "pending") ?? [];
  const others = listed?.items.filter((user) => user.accessStatus !== "pending") ?? [];

  return (
    <Shell>
      <main className="workspace admin-workspace">
        <section className="profile-section">
          <h1>Администрирование</h1>
          <p className="profile-lead">Заявки на доступ и роли сотрудников.</p>
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
                  await refresh();
                }}
                onReject={async () => {
                  setListed(await rejectUser(user.id));
                  await refresh();
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
                        await refresh();
                      },
                      onRevoke: async () => {
                        setListed(await revokeUser(user.id));
                        await refresh();
                      },
                    }
                  : {})}
              />
            ))}
          </ul>
        </section>
      </main>
    </Shell>
  );
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
          <button type="button" className="profile-list-remove" onClick={() => void onReject()}>
            Отклонить
          </button>
        ) : null}
        {onChangeRole !== undefined ? (
          <button type="button" className="profile-fill" onClick={() => void onChangeRole()}>
            Сохранить роль
          </button>
        ) : null}
        {onRevoke !== undefined ? (
          <button type="button" className="profile-list-remove" onClick={() => void onRevoke()}>
            Отозвать
          </button>
        ) : null}
      </div>
    </li>
  );
}
