import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { resetPassword } from "../api/auth.js";
import { AuthScreen } from "./AuthScreen.js";

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сменить пароль");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScreen title="Новый пароль">
      {done ? (
        <p className="auth-note">Пароль обновлён. Войдите с новым паролем.</p>
      ) : (
        <form className="auth-form" onSubmit={(event) => void onSubmit(event)}>
          <label>
            Новый пароль
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={8}
            />
          </label>
          {error !== undefined ? <p className="auth-error">{error}</p> : null}
          <button type="submit" className={busy ? "auth-submit is-busy" : "auth-submit"} disabled={busy}>
            Сохранить пароль
          </button>
        </form>
      )}
      <p className="auth-links">
        <Link to="/login">К входу</Link>
      </p>
    </AuthScreen>
  );
}
