import { NavLink } from "react-router-dom";
import type { ReactNode } from "react";

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <aside className="nav">
        <p className="nav-brand">Платформа закупок</p>
        <nav aria-label="Разделы">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "nav-current" : "nav-link")}>
            Входящие
          </NavLink>
          <NavLink
            to="/procurements"
            className={({ isActive }) => (isActive ? "nav-current" : "nav-link")}
          >
            Закупки
          </NavLink>
          <NavLink
            to="/profiles"
            className={({ isActive }) => (isActive ? "nav-current" : "nav-link")}
          >
            Профили
          </NavLink>
          <button type="button" className="nav-soon" disabled title="Скоро">
            Задачи
            <span className="nav-soon-mark">скоро</span>
          </button>
        </nav>
      </aside>
      {children}
    </div>
  );
}
