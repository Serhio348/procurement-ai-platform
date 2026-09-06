import type { ReactNode } from "react";
import { BrandMark } from "../shell/BrandMark.js";

export function AuthScreen({
  title,
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="auth-brand-mark">
            <BrandMark />
          </span>
          <p className="auth-brand-title">
            <span>Платформа</span>
            <span>закупок</span>
          </p>
          <span className="auth-rule" aria-hidden="true" />
          <p className="auth-kicker">Консоль специалиста</p>
        </div>
        {title !== undefined && title.length > 0 ? <h1>{title}</h1> : null}
        {children}
      </div>
    </div>
  );
}
