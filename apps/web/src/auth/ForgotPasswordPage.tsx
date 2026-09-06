import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { forgotPassword } from "../api/auth.js";
import { AuthScreen } from "./AuthScreen.js";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await forgotPassword(email);
      setDone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось отправить письмо");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScreen title="Сброс пароля">
      {done ? (
        <p className="auth-note">Если такой аккаунт есть, письмо со ссылкой уже отправлено.</p>
      ) : (
        <form className="auth-form" onSubmit={(event) => void onSubmit(event)}>
          <label>
            Email
            <input
              type="email"
              name="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          {error !== undefined ? <p className="auth-error">{error}</p> : null}
          <button type="submit" className={busy ? "auth-submit is-busy" : "auth-submit"} disabled={busy}>
            Отправить ссылку
          </button>
        </form>
      )}
      <p className="auth-links">
        <Link to="/login">К входу</Link>
      </p>
    </AuthScreen>
  );
}
