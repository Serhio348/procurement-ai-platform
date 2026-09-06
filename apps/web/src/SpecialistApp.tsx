import { useState, type ReactElement } from "react";
import { BrowserRouter, Route, Routes, useNavigate, useParams } from "react-router-dom";
import type {
  SpecialistInboxEntry,
  SpecialistIngestProgress,
  SpecialistProcurementCard,
  SpecialistProfileListResponse,
  SpecialistProfileWrite,
  SpecialistSearchResponse,
  SpecialistTriageKind,
  SpecialistWorkingProfile,
} from "@procurement/contracts";
import { AdminApp } from "./admin/AdminApp.js";
import { InboxApp } from "./inbox/InboxApp.js";
import { ProcurementsApp } from "./procurements/ProcurementsApp.js";
import { ProfileApp } from "./profile/ProfileApp.js";
import { ProfileList } from "./profile/ProfileList.js";

export interface SpecialistAppProps {
  inbox: readonly SpecialistInboxEntry[];
  procurements: readonly SpecialistProcurementCard[];
  profiles: readonly SpecialistWorkingProfile[];
  activeProfileId?: string;
  search?: () => Promise<SpecialistSearchResponse>;
  createProfile?: () => Promise<SpecialistWorkingProfile>;
  deleteProfile?: (id: string) => Promise<SpecialistProfileListResponse>;
  activateProfile?: (id: string) => Promise<SpecialistWorkingProfile>;
  saveProfile?: (id: string, next: SpecialistProfileWrite) => Promise<SpecialistWorkingProfile>;
  setProfileWatch?: (watchNewProcurements: boolean) => Promise<SpecialistWorkingProfile>;
  decide?: (
    id: string,
    kind: SpecialistTriageKind,
  ) => Promise<readonly SpecialistProcurementCard[]>;
  ingestProgress?: (id: string) => Promise<SpecialistIngestProgress>;
}

export function SpecialistApp(props: SpecialistAppProps): ReactElement {
  const [procurements, setProcurements] = useState(props.procurements);
  const [profiles, setProfiles] = useState(props.profiles);
  const [activeProfileId, setActiveProfileId] = useState(
    props.activeProfileId ?? props.profiles[0]?.id ?? "",
  );
  const searchProfile = props.search;
  const decideCase = props.decide;
  const activateProfile = props.activateProfile;
  const createProfile = props.createProfile;
  const deleteProfile = props.deleteProfile;
  const saveProfile = props.saveProfile;
  const setProfileWatch = props.setProfileWatch;

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

  function remember(next: SpecialistWorkingProfile, activate = false): SpecialistWorkingProfile {
    setProfiles((current) => {
      if (current.some((item) => item.id === next.id)) {
        return current.map((item) => (item.id === next.id ? next : item));
      }
      return [...current, next];
    });
    if (activate) setActiveProfileId(next.id);
    return next;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<InboxApp entries={props.inbox} />} />
        <Route
          path="/profiles"
          element={
            <ProfileListRoute
              profiles={profiles}
              create={async () => {
                if (createProfile === undefined) return undefined;
                return remember(await createProfile(), true);
              }}
              {...(deleteProfile === undefined
                ? {}
                : {
                    remove: async (id: string) => {
                      const listed = await deleteProfile(id);
                      setProfiles(listed.items);
                      setActiveProfileId(listed.activeProfileId);
                    },
                  })}
            />
          }
        />
        <Route
          path="/profiles/:id"
          element={
            <ProfileEditorRoute
              profiles={profiles}
              {...(activateProfile === undefined
                ? {}
                : { activate: async (id: string) => remember(await activateProfile(id), true) })}
              save={async (id, next) => {
                if (saveProfile === undefined) {
                  const current = profiles.find((item) => item.id === id) ?? profiles[0];
                  if (current === undefined) {
                    throw new Error("no_profile");
                  }
                  return remember({ ...current, ...next });
                }
                return remember(await saveProfile(id, next));
              }}
              setWatch={async (watchNewProcurements) => {
                if (setProfileWatch === undefined) {
                  const current = profiles[0];
                  if (current === undefined) {
                    throw new Error("no_profile");
                  }
                  return remember({ ...current, watchNewProcurements });
                }
                return remember(await setProfileWatch(watchNewProcurements));
              }}
            />
          }
        />
        <Route
          path="/procurements"
          element={
            <ProcurementsApp
              items={procurements}
              profiles={profiles}
              {...(activeProfileId.length === 0 ? {} : { activeProfileId })}
              {...(search === undefined ? {} : { search })}
              {...(activateProfile === undefined
                ? {}
                : {
                    selectProfile: async (id: string) => {
                      remember(await activateProfile(id), true);
                    },
                  })}
              {...(decide === undefined ? {} : { decide })}
              {...(props.ingestProgress === undefined ? {} : { ingestProgress: props.ingestProgress })}
            />
          }
        />
        <Route path="/admin" element={<AdminApp />} />
        <Route
          path="/procurements/:id"
          element={
            <ProcurementsApp
              items={procurements}
              profiles={profiles}
              {...(activeProfileId.length === 0 ? {} : { activeProfileId })}
              {...(search === undefined ? {} : { search })}
              {...(activateProfile === undefined
                ? {}
                : {
                    selectProfile: async (id: string) => {
                      remember(await activateProfile(id), true);
                    },
                  })}
              {...(decide === undefined ? {} : { decide })}
              {...(props.ingestProgress === undefined ? {} : { ingestProgress: props.ingestProgress })}
            />
          }
        />
      </Routes>
    </BrowserRouter>
  );
}

function ProfileListRoute({
  profiles,
  create,
  remove,
}: {
  profiles: readonly SpecialistWorkingProfile[];
  create: () => Promise<SpecialistWorkingProfile | undefined>;
  remove?: (id: string) => Promise<void>;
}): ReactElement {
  const navigate = useNavigate();
  return (
    <ProfileList
      profiles={profiles}
      create={async () => {
        const created = await create();
        if (created !== undefined) navigate(`/profiles/${created.id}`);
      }}
      {...(remove === undefined ? {} : { remove })}
    />
  );
}

function ProfileEditorRoute({
  profiles,
  activate,
  save,
  setWatch,
}: {
  profiles: readonly SpecialistWorkingProfile[];
  activate?: (id: string) => Promise<SpecialistWorkingProfile>;
  save: (id: string, next: SpecialistProfileWrite) => Promise<SpecialistWorkingProfile>;
  setWatch: (watchNewProcurements: boolean) => Promise<SpecialistWorkingProfile>;
}): ReactElement {
  const { id } = useParams();
  const profile = profiles.find((item) => item.id === id) ?? profiles[0];
  if (profile === undefined) {
    return <ProfileList profiles={[]} create={async () => undefined} />;
  }
  return (
    <ProfileApp
      profile={profile}
      {...(activate === undefined ? {} : { activate })}
      save={(next) => save(profile.id, next)}
      setWatch={setWatch}
    />
  );
}
