import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { fetchInbox, fetchProcurements, searchProcurements } from "./api/specialist.js";
import { SpecialistApp } from "./SpecialistApp.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Root element #root is missing");
}

const mount = createRoot(root);

try {
  const [inbox, procurements] = await Promise.all([fetchInbox(), fetchProcurements()]);
  mount.render(
    <StrictMode>
      <SpecialistApp inbox={inbox} procurements={procurements} search={searchProcurements} />
    </StrictMode>,
  );
} catch {
  mount.render(
    <StrictMode>
      <p className="empty">Нет связи с API. Запустите npm run web из корня репозитория.</p>
    </StrictMode>,
  );
}
