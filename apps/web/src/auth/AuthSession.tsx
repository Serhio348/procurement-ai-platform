import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AuthSessionUser } from "@procurement/contracts";
import { fetchSession, signOut as requestSignOut } from "../api/auth.js";

export type AuthLoadState = "loading" | "ready" | "offline";

export interface AuthSessionValue {
  user: AuthSessionUser | null;
  status: AuthLoadState;
  setUser: (user: AuthSessionUser | null) => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthSessionContext = createContext<AuthSessionValue>({
  user: null,
  status: "ready",
  setUser: () => undefined,
  refresh: async () => undefined,
  signOut: async () => undefined,
});

export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthSessionUser | null>(null);
  const [status, setStatus] = useState<AuthLoadState>("loading");

  const refresh = async (): Promise<void> => {
    try {
      setUser(await fetchSession());
      setStatus("ready");
    } catch {
      setUser(null);
      setStatus("offline");
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (user?.role !== "admin") return undefined;
    const timer = setInterval(() => {
      void fetchSession()
        .then(setUser)
        .catch(() => undefined);
    }, 30_000);
    return () => clearInterval(timer);
  }, [user?.role]);

  const value = useMemo<AuthSessionValue>(
    () => ({
      user,
      status,
      setUser,
      refresh,
      signOut: async () => {
        await requestSignOut();
        setUser(null);
      },
    }),
    [user, status],
  );

  return <AuthSessionContext.Provider value={value}>{children}</AuthSessionContext.Provider>;
}

export function useAuthSession(): AuthSessionValue {
  return useContext(AuthSessionContext);
}
