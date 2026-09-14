import { NavLink, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuthSession } from "../auth/AuthSession.js";
import { roleLabel } from "../auth/labels.js";
import { useInboxAlertCount } from "../inbox/InboxAlert.js";
import { BrandMark } from "./BrandMark.js";

export function Shell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuthSession();
  const pending = user?.pendingUserCount ?? 0;
  const errors = user?.errorEventCount ?? 0;
  const inboxAlert = useInboxAlertCount();
  const atAdmin = useLocation().pathname.startsWith("/admin");

  return (
    <div className="shell">
      <aside className="nav">
        <p className="nav-brand">
          <span className="nav-brand-mark">
            <BrandMark />
          </span>
          <span className="nav-brand-text">
            <span>Платформа</span>
            <span>закупок</span>
          </span>
        </p>
        <nav aria-label="Разделы">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "nav-current" : "nav-link")}>
            Входящие
            {inboxAlert > 0 ? <span className="nav-badge">{inboxAlert}</span> : null}
          </NavLink>
          <NavLink
            to="/procurements"
            className={({ isActive }) => (isActive ? "nav-current" : "nav-link")}
          >
            Закупки
          </NavLink>
          <NavLink
            to="/my-procurements"
            className={({ isActive }) => (isActive ? "nav-current" : "nav-link")}
          >
            Мои закупки
          </NavLink>
          <NavLink
            to="/trash"
            className={({ isActive }) => (isActive ? "nav-current" : "nav-link")}
          >
            Корзина
          </NavLink>
          <NavLink
            to="/profiles"
            className={({ isActive }) => (isActive ? "nav-current" : "nav-link")}
          >
            Профили
          </NavLink>
          {user?.role === "admin" ? (
            <NavLink
              to="/admin/access"
              className={() => (atAdmin ? "nav-current" : "nav-link")}
            >
              Администрирование
              {pending > 0 ? <span className="nav-badge">{pending}</span> : null}
              {errors > 0 ? (
                <span className="nav-alarm-mark">ошибки {String(errors)}</span>
              ) : null}
            </NavLink>
          ) : null}
          <button type="button" className="nav-soon" disabled title="Скоро">
            Задачи
            <span className="nav-soon-mark">скоро</span>
          </button>
        </nav>
        {user !== null ? (
          <div className="nav-user">
            <p className="nav-user-name">{user.name}</p>
            <p className="nav-user-role">{roleLabel(user.role)}</p>
            <button type="button" className="nav-sign-out" onClick={() => void signOut()}>
              Выйти
            </button>
          </div>
        ) : null}
      </aside>
      {children}
    </div>
  );
}
