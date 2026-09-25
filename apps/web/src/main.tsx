import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import {
  activateProfile,
  cancelSearch,
  createProfile,
  createTelegramLink,
  decideProcurement,
  deleteProfile,
  fetchInbox,
  fetchIngestProgress,
  fetchProcurement,
  fetchProcurements,
  fetchProfiles,
  fetchSearchProgress,
  fetchServiceHealth,
  fetchTelegramStatus,
  purgeProcurement,
  emptyTrash,
  reindexProcurement,
  dismissAllInbox,
  resolveInbox,
  restoreProcurement,
  saveProfile,
  suggestProfile,
  searchProcurements,
  setProcurementArchived,
  setProfileWatch,
  setTelegramMode,
  unlinkTelegram,
} from "./api/specialist.js";
import { AccessPendingPage } from "./auth/AccessPendingPage.js";
import { AuthScreen } from "./auth/AuthScreen.js";
import { AuthSessionProvider, useAuthSession } from "./auth/AuthSession.js";
import { ForgotPasswordPage } from "./auth/ForgotPasswordPage.js";
import { LoginPage } from "./auth/LoginPage.js";
import { RegisterPage } from "./auth/RegisterPage.js";
import { ResetPasswordPage } from "./auth/ResetPasswordPage.js";
import { SpecialistApp } from "./SpecialistApp.js";
import { errorText } from "./api/http.js";
import type {
  SpecialistInboxEntry,
  SpecialistProcurementCard,
  SpecialistWorkingProfile,
} from "@procurement/contracts";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Root element #root is missing");
}

// PWA shell: cached app shell for fast startup and an offline screen.
// API responses are never cached — the console must not show stale
// procurements or inbox rows.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}

createRoot(root).render(
  <StrictMode>
    <AuthSessionProvider>
      <ConsoleRoot />
    </AuthSessionProvider>
  </StrictMode>,
);

function ConsoleRoot() {
  const { user, status } = useAuthSession();
  if (status === "loading") {
    return <AuthScreen />;
  }
  if (status === "offline") {
    return (
      <AuthScreen title="Нет связи">
        <p className="auth-note">Запустите npm run web из корня репозитория.</p>
      </AuthScreen>
    );
  }
  if (user === null) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
    );
  }
  if (user.accessStatus !== "active" || user.role === null) {
    return <AccessPendingPage />;
  }
  return <LiveConsole />;
}

function LiveConsole() {
  const { user } = useAuthSession();
  const [data, setData] = useState<
    | {
        inbox: readonly SpecialistInboxEntry[];
        procurements: readonly SpecialistProcurementCard[];
        profiles: readonly SpecialistWorkingProfile[];
        activeProfileId: string;
      }
    | "loading"
    | { error: string }
  >("loading");

  // One shared loader: the first mount and the «Повторить» button take the
  // same path — no page reload, and the real failure reason is kept (R28).
  const loadInitialData = useCallback(async () => {
    setData("loading");
    try {
      const [inbox, listed] = await Promise.all([fetchInbox(), fetchProfiles()]);
      setData({
        inbox,
        procurements: [],
        profiles: listed.items,
        activeProfileId: listed.activeProfileId,
      });
    } catch (error) {
      setData({ error: errorText(error, "Не удалось загрузить консоль.") });
    }
  }, []);

  useEffect(() => {
    void loadInitialData();
  }, [loadInitialData]);

  if (data === "loading") {
    return <AuthScreen />;
  }
  if (typeof data === "object" && "error" in data) {
    return (
      <AuthScreen title="Нет связи">
        <p className="auth-note">{data.error}</p>
        <button
          type="button"
          className="auth-submit"
          onClick={() => {
            void loadInitialData();
          }}
        >
          Повторить
        </button>
      </AuthScreen>
    );
  }

  return (
    <SpecialistApp
      key={user?.id ?? "anon"}
      inbox={data.inbox}
      procurements={data.procurements}
      profiles={data.profiles}
      activeProfileId={data.activeProfileId}
      search={searchProcurements}
      createProfile={createProfile}
      deleteProfile={deleteProfile}
      activateProfile={activateProfile}
      saveProfile={saveProfile}
      suggestProfile={suggestProfile}
      setProfileWatch={setProfileWatch}
      decide={decideProcurement}
      archive={setProcurementArchived}
      restore={restoreProcurement}
      purge={purgeProcurement}
      emptyTrash={emptyTrash}
      reindex={reindexProcurement}
      ingestProgress={fetchIngestProgress}
      refreshInbox={fetchInbox}
      dismissAllInbox={dismissAllInbox}
      resolveInbox={resolveInbox}
      listMine={fetchProcurements}
      loadCard={fetchProcurement}
      searchProgress={fetchSearchProgress}
      cancelSearch={cancelSearch}
      serviceHealth={fetchServiceHealth}
      telegram={{
        status: fetchTelegramStatus,
        link: createTelegramLink,
        setMode: setTelegramMode,
        unlink: unlinkTelegram,
      }}
    />
  );
}
