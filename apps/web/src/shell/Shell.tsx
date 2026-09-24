import { NavLink, useLocation } from "react-router-dom";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useAuthSession } from "../auth/AuthSession.js";
import { roleLabel } from "../auth/labels.js";
import { useInboxAlertCount } from "../inbox/InboxAlert.js";
import { BrandMark } from "./BrandMark.js";
import { useGuardedClick } from "./UnsavedGuard.js";

function TabIcon({ d }: { d: string }) {
  return (
    <svg
      className="mobile-tab-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const TAB_ICONS = {
  inbox: "M4 6h16v12H4z M4 13h5l1.5 2h3L15 13h5",
  search: "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Z M15.2 15.2 20 20",
  mine: "M6 7h12v13H6z M9 7V5a3 3 0 0 1 6 0v2",
  profiles: "M12 8a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z M5 19c.8-3 3.5-4.5 7-4.5s6.2 1.5 7 4.5",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
} as const;

export function Shell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuthSession();
  const pending = user?.pendingUserCount ?? 0;
  const errors = user?.errorEventCount ?? 0;
  const inboxAlert = useInboxAlertCount();
  const atAdmin = useLocation().pathname.startsWith("/admin");
  const guardedClick = useGuardedClick();
  const [navOpen, setNavOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const touchStartX = useRef<number | undefined>(undefined);

  // Mobile drawer (R32): Esc / Tab-trap inside the open drawer, body scroll
  // lock, focus returns to the hamburger on close, swipe-left closes.
  useEffect(() => {
    if (!navOpen) return undefined;
    const nav = navRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    nav?.querySelector<HTMLElement>(".nav-close")?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setNavOpen(false);
        return;
      }
      if (event.key !== "Tab" || nav === null) return;
      const focusables = nav.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled])",
      );
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      toggleRef.current?.focus();
    };
  }, [navOpen]);

  const drawerClick = (event: MouseEvent<HTMLAnchorElement>) => {
    guardedClick(event);
    if (!event.defaultPrevented) setNavOpen(false);
  };

  const navBody = (
    <>
      <p className="nav-brand">
        <span className="nav-brand-mark">
          <BrandMark />
        </span>
        <span className="nav-brand-text">
          <span>Платформа</span>
          <span>закупок</span>
        </span>
        <button
          type="button"
          className="nav-close"
          aria-label="Закрыть меню"
          onClick={() => setNavOpen(false)}
        >
          ✕
        </button>
      </p>
      <nav aria-label="Разделы">
        <NavLink
          to="/"
          end
          onClick={drawerClick}
          className={({ isActive }) => (isActive ? "nav-current" : "nav-link")}
        >
          Входящие
          {inboxAlert > 0 ? <span className="nav-badge">{inboxAlert}</span> : null}
        </NavLink>
        <NavLink
          to="/procurements"
          onClick={drawerClick}
          className={({ isActive }) => (isActive ? "nav-current" : "nav-link")}
        >
          Закупки
        </NavLink>
        <NavLink
          to="/my-procurements"
          onClick={drawerClick}
          className={({ isActive }) => (isActive ? "nav-current" : "nav-link")}
        >
          Мои закупки
        </NavLink>
        <NavLink
          to="/trash"
          onClick={drawerClick}
          className={({ isActive }) => (isActive ? "nav-current" : "nav-link")}
        >
          Корзина
        </NavLink>
        <NavLink
          to="/profiles"
          onClick={drawerClick}
          className={({ isActive }) => (isActive ? "nav-current" : "nav-link")}
        >
          Профили
        </NavLink>
        {user?.role === "admin" ? (
          <NavLink
            to="/admin/access"
            onClick={drawerClick}
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
    </>
  );

  return (
    <div className={navOpen ? "shell is-nav-open" : "shell"}>
      <header className="shell-topbar">
        <button
          ref={toggleRef}
          type="button"
          className="nav-toggle"
          aria-label="Меню"
          aria-expanded={navOpen}
          aria-controls="shell-nav"
          onClick={() => setNavOpen(true)}
        >
          <svg
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <span className="shell-topbar-brand">
          <span className="nav-brand-mark">
            <BrandMark />
          </span>
          Платформа закупок
        </span>
      </header>
      {navOpen ? (
        <div
          className="nav-backdrop"
          aria-hidden="true"
          onClick={() => setNavOpen(false)}
        />
      ) : null}
      <aside
        id="shell-nav"
        ref={navRef}
        className="nav"
        role={navOpen ? "dialog" : undefined}
        aria-modal={navOpen ? true : undefined}
        aria-label="Меню разделов"
        onTouchStart={(event) => {
          touchStartX.current = event.touches[0]?.clientX;
        }}
        onTouchEnd={(event) => {
          const start = touchStartX.current;
          const end = event.changedTouches[0]?.clientX;
          touchStartX.current = undefined;
          if (start !== undefined && end !== undefined && start - end > 60) {
            setNavOpen(false);
          }
        }}
      >
        {navBody}
      </aside>
      {children}
      <nav className="mobile-tabs" aria-label="Основные разделы">
        <NavLink
          to="/"
          end
          onClick={guardedClick}
          className={({ isActive }) =>
            isActive ? "mobile-tab is-current" : "mobile-tab"
          }
        >
          <TabIcon d={TAB_ICONS.inbox} />
          <span className="mobile-tab-label">Входящие</span>
          {inboxAlert > 0 ? (
            <span className="mobile-tab-badge">{inboxAlert}</span>
          ) : null}
        </NavLink>
        <NavLink
          to="/procurements"
          onClick={guardedClick}
          className={({ isActive }) =>
            isActive ? "mobile-tab is-current" : "mobile-tab"
          }
        >
          <TabIcon d={TAB_ICONS.search} />
          <span className="mobile-tab-label">Закупки</span>
        </NavLink>
        <NavLink
          to="/my-procurements"
          onClick={guardedClick}
          className={({ isActive }) =>
            isActive ? "mobile-tab is-current" : "mobile-tab"
          }
        >
          <TabIcon d={TAB_ICONS.mine} />
          <span className="mobile-tab-label">Мои</span>
        </NavLink>
        <NavLink
          to="/profiles"
          onClick={guardedClick}
          className={({ isActive }) =>
            isActive ? "mobile-tab is-current" : "mobile-tab"
          }
        >
          <TabIcon d={TAB_ICONS.profiles} />
          <span className="mobile-tab-label">Профили</span>
        </NavLink>
        <button
          type="button"
          className="mobile-tab"
          aria-label="Ещё разделы"
          onClick={() => setNavOpen(true)}
        >
          <TabIcon d={TAB_ICONS.more} />
          <span className="mobile-tab-label">Ещё</span>
          {pending + errors > 0 ? (
            <span className="mobile-tab-badge">{pending + errors}</span>
          ) : null}
        </button>
      </nav>
    </div>
  );
}
