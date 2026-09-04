import { useState, type ReactElement } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import type {
  SpecialistInboxEntry,
  SpecialistProcurementCard,
  SpecialistSearchResponse,
} from "@procurement/contracts";
import { InboxApp } from "./inbox/InboxApp.js";
import { ProcurementsApp } from "./procurements/ProcurementsApp.js";

export interface SpecialistAppProps {
  inbox: readonly SpecialistInboxEntry[];
  procurements: readonly SpecialistProcurementCard[];
  search?: () => Promise<SpecialistSearchResponse>;
}

export function SpecialistApp(props: SpecialistAppProps): ReactElement {
  const [procurements, setProcurements] = useState(props.procurements);
  const searchProfile = props.search;

  const search =
    searchProfile === undefined
      ? undefined
      : async () => {
          const result = await searchProfile();
          setProcurements(result.items);
          return result;
        };

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<InboxApp entries={props.inbox} />} />
        <Route
          path="/procurements"
          element={
            <ProcurementsApp
              items={procurements}
              {...(search === undefined ? {} : { search })}
            />
          }
        />
        <Route
          path="/procurements/:id"
          element={
            <ProcurementsApp
              items={procurements}
              {...(search === undefined ? {} : { search })}
            />
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
