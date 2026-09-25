import { useState } from "react";
import type { SpecialistInboxAction, SpecialistInboxEntry } from "@procurement/contracts";
import { Shell } from "../shell/Shell.js";
import { InboxPage } from "./InboxPage.js";

export function InboxApp({
  entries,
  onResolve,
  onDismissAll,
}: {
  entries: readonly SpecialistInboxEntry[];
  onResolve?: (
    id: string,
    action: SpecialistInboxAction,
  ) => Promise<void>;
  onDismissAll?: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(entries[0]?.id);
  const [busyId, setBusyId] = useState<string | undefined>();
  const [clearing, setClearing] = useState(false);
  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0];

  return (
    <Shell>
      <InboxPage
        entries={entries}
        {...(selected === undefined ? {} : { selectedId: selected.id })}
        {...(busyId === undefined ? {} : { busyId })}
        {...(clearing ? { clearing: true } : {})}
        onSelect={setSelectedId}
        {...(onDismissAll === undefined
          ? {}
          : {
              onDismissAll: () => {
                setClearing(true);
                void onDismissAll().finally(() => setClearing(false));
              },
            })}
        {...(onResolve === undefined
          ? {}
          : {
              onResolve: (id, action) => {
                setBusyId(id);
                void onResolve(id, action).finally(() => setBusyId(undefined));
              },
            })}
      />
    </Shell>
  );
}
