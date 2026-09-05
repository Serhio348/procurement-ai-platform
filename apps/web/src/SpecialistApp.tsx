import { useState, type ReactElement } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import type {
  SpecialistInboxEntry,
  SpecialistProcurementCard,
  SpecialistProfileWrite,
  SpecialistSearchResponse,
  SpecialistTriageKind,
  SpecialistWorkingProfile,
} from "@procurement/contracts";
import { InboxApp } from "./inbox/InboxApp.js";
import { ProcurementsApp } from "./procurements/ProcurementsApp.js";
import { ProfileApp } from "./profile/ProfileApp.js";

export interface SpecialistAppProps {
  inbox: readonly SpecialistInboxEntry[];
  procurements: readonly SpecialistProcurementCard[];
  profile: SpecialistWorkingProfile;
  search?: () => Promise<SpecialistSearchResponse>;
  saveProfile?: (next: SpecialistProfileWrite) => Promise<SpecialistWorkingProfile>;
  setProfileWatch?: (watchNewProcurements: boolean) => Promise<SpecialistWorkingProfile>;
  decide?: (
    id: string,
    kind: SpecialistTriageKind,
  ) => Promise<readonly SpecialistProcurementCard[]>;
}

export function SpecialistApp(props: SpecialistAppProps): ReactElement {
  const [procurements, setProcurements] = useState(props.procurements);
  const searchProfile = props.search;
  const decideCase = props.decide;

  const search =
    searchProfile === undefined
      ? undefined
      : async () => {
          const result = await searchProfile();
          setProcurements(result.items);
          return result;
        };

  const decide =
    decideCase === undefined
      ? undefined
      : async (id: string, kind: SpecialistTriageKind) => {
          const items = await decideCase(id, kind);
          setProcurements(items);
          return items;
        };

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<InboxApp entries={props.inbox} />} />
        <Route
          path="/profiles"
          element={
            <ProfileApp
              profile={props.profile}
              save={props.saveProfile ?? (async () => props.profile)}
              setWatch={props.setProfileWatch ?? (async () => props.profile)}
            />
          }
        />
        <Route
          path="/procurements"
          element={
            <ProcurementsApp
              items={procurements}
              {...(search === undefined ? {} : { search })}
              {...(decide === undefined ? {} : { decide })}
            />
          }
        />
        <Route
          path="/procurements/:id"
          element={
            <ProcurementsApp
              items={procurements}
              {...(search === undefined ? {} : { search })}
              {...(decide === undefined ? {} : { decide })}
            />
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
