import { NavLink } from "react-router-dom";
import type { ReactNode } from "react";

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <aside className="nav">
        <p className="nav-brand">
          <span className="nav-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 48 48" fill="none">
              <rect
                x="2.5"
                y="2.5"
                width="43"
                height="43"
                rx="10"
                fill="#2c3548"
                stroke="#c9a25a"
                strokeWidth="1.5"
              />
              <rect
                x="7"
                y="7"
                width="34"
                height="34"
                rx="7"
                stroke="#c9a25a"
                strokeWidth="0.7"
                opacity="0.4"
              />
              <path d="M15 13.5h12.5L33 19v15.5H15V13.5Z" fill="#eef2f6" />
              <path d="M27.5 13.5V19H33" fill="#c5ccd6" />
              <path
                d="M19 24h10M19 28h10M19 32h6.5"
                stroke="#3a5d86"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
              <circle cx="33.5" cy="33.5" r="6.2" fill="#c9a25a" />
              <circle cx="33.5" cy="33.5" r="4" stroke="#1e2430" strokeWidth="0.85" />
              <path
                d="M31.7 36.15V31.15h3.6v5h-1.25v-3.75h-1.1v3.75H31.7Z"
                fill="#1e2430"
              />
            </svg>
          </span>
          <span className="nav-brand-text">
            <span>Платформа</span>
            <span>закупок</span>
          </span>
        </p>
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
