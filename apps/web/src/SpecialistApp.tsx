import { BrowserRouter, Route, Routes } from "react-router-dom";
import type { SpecialistInboxEntry, SpecialistProcurementCard } from "@procurement/contracts";
import { InboxApp } from "./inbox/InboxApp.js";
import { ProcurementsApp } from "./procurements/ProcurementsApp.js";

export interface SpecialistAppProps {
  inbox: readonly SpecialistInboxEntry[];
  procurements: readonly SpecialistProcurementCard[];
}

export function SpecialistApp(props: SpecialistAppProps) {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<InboxApp entries={props.inbox} />} />
        <Route path="/procurements" element={<ProcurementsApp items={props.procurements} />} />
        <Route path="/procurements/:id" element={<ProcurementsApp items={props.procurements} />} />
      </Routes>
    </BrowserRouter>
  );
}
