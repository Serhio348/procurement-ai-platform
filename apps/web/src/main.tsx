import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
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
import { SpecialistApp } from "./SpecialistApp.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Root element #root is missing");
}

const mount = createRoot(root);

try {
  const [inbox, procurements, listed] = await Promise.all([
    fetchInbox(),
    fetchProcurements(),
    fetchProfiles(),
  ]);
  mount.render(
    <StrictMode>
      <SpecialistApp
        inbox={inbox}
        procurements={procurements}
        profiles={listed.items}
        activeProfileId={listed.activeProfileId}
        search={searchProcurements}
        createProfile={createProfile}
        deleteProfile={deleteProfile}
        activateProfile={activateProfile}
        saveProfile={saveProfile}
        setProfileWatch={setProfileWatch}
        decide={decideProcurement}
        ingestProgress={fetchIngestProgress}
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
