import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import {
  activateProfile,
  createProfile,
  decideProcurement,
  deleteProfile,
  fetchInbox,
  fetchIngestProgress,
  fetchProcurements,
  fetchProfiles,
  saveProfile,
  searchProcurements,
  setProfileWatch,
} from "./api/specialist.js";
import { AccessPendingPage } from "./auth/AccessPendingPage.js";
import { AuthScreen } from "./auth/AuthScreen.js";
import { AuthSessionProvider, useAuthSession } from "./auth/AuthSession.js";
import { ForgotPasswordPage } from "./auth/ForgotPasswordPage.js";
import { LoginPage } from "./auth/LoginPage.js";
import { RegisterPage } from "./auth/RegisterPage.js";
import { ResetPasswordPage } from "./auth/ResetPasswordPage.js";
import { SpecialistApp } from "./SpecialistApp.js";
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
  const [data, setData] = useState<
    | {
        inbox: readonly SpecialistInboxEntry[];
        procurements: readonly SpecialistProcurementCard[];
        profiles: readonly SpecialistWorkingProfile[];
        activeProfileId: string;
      }
    | "loading"
    | "offline"
  >("loading");

  useEffect(() => {
    void Promise.all([fetchInbox(), fetchProcurements(), fetchProfiles()])
      .then(([inbox, procurements, listed]) => {
        setData({
          inbox,
          procurements,
          profiles: listed.items,
          activeProfileId: listed.activeProfileId,
        });
      })
      .catch(() => {
        setData("offline");
      });
  }, []);

  if (data === "loading") {
    return <AuthScreen />;
  }
  if (data === "offline") {
    return (
      <AuthScreen title="Нет связи">
        <p className="auth-note">Не удалось загрузить консоль.</p>
      </AuthScreen>
    );
  }

  return (
    <SpecialistApp
      inbox={data.inbox}
      procurements={data.procurements}
      profiles={data.profiles}
      activeProfileId={data.activeProfileId}
      search={searchProcurements}
      createProfile={createProfile}
      deleteProfile={deleteProfile}
      activateProfile={activateProfile}
      saveProfile={saveProfile}
      setProfileWatch={setProfileWatch}
      decide={decideProcurement}
      ingestProgress={fetchIngestProgress}
    />
  );
}
