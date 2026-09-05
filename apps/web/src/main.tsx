import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  decideProcurement,
  fetchInbox,
  fetchProcurements,
  fetchProfile,
  saveProfile,
  searchProcurements,
  setProfileWatch,
} from "./api/specialist.js";
import { SpecialistApp } from "./SpecialistApp.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Root element #root is missing");
}

const mount = createRoot(root);

try {
  const [inbox, procurements, profile] = await Promise.all([
    fetchInbox(),
    fetchProcurements(),
    fetchProfile(),
  ]);
  mount.render(
    <StrictMode>
      <SpecialistApp
        inbox={inbox}
        procurements={procurements}
        profile={profile}
        search={searchProcurements}
        saveProfile={saveProfile}
        setProfileWatch={setProfileWatch}
        decide={decideProcurement}
      />
    </StrictMode>,
  );
} catch {
  mount.render(
    <StrictMode>
      <p className="empty">Нет связи с API. Запустите npm run web из корня репозитория.</p>
    </StrictMode>,
  );
}
