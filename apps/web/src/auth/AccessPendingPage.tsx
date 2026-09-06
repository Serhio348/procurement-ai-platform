import { accessMessage } from "./labels.js";
import { AuthScreen } from "./AuthScreen.js";
import { useAuthSession } from "./AuthSession.js";

export function AccessPendingPage() {
  const { user, signOut } = useAuthSession();
  const status = user?.accessStatus ?? "pending";

  return (
    <AuthScreen title="Доступ">
      <p className="auth-note">{accessMessage(status)}</p>
      <button type="button" className="auth-submit" onClick={() => void signOut()}>
        Выйти
      </button>
    </AuthScreen>
  );
}
