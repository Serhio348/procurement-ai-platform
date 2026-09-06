import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { signIn } from "../api/auth.js";
import { AuthScreen } from "./AuthScreen.js";
import { useAuthSession } from "./AuthSession.js";

export function LoginPage() {
  const { setUser } = useAuthSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      setUser(await signIn(email, password));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось войти");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScreen title="Вход">
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
        <label>
          Пароль
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={8}
          />
        </label>
        {error !== undefined ? <p className="auth-error">{error}</p> : null}
        <button type="submit" className={busy ? "auth-submit is-busy" : "auth-submit"} disabled={busy}>
          Войти
        </button>
      </form>
      <p className="auth-links">
        <Link to="/register">Регистрация</Link>
        <Link to="/forgot-password">Сброс пароля</Link>
      </p>
    </AuthScreen>
  );
}
