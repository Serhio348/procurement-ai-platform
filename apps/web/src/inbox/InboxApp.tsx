import { useState } from "react";
import type { SpecialistInboxEntry } from "@procurement/contracts";
import { Shell } from "../shell/Shell.js";
import { InboxPage } from "./InboxPage.js";

export function InboxApp({ entries }: { entries: readonly SpecialistInboxEntry[] }) {
  const [selectedId, setSelectedId] = useState<string | undefined>(entries[0]?.id);
  return (
    <Shell>
      <InboxPage
        entries={entries}
        {...(selectedId === undefined ? {} : { selectedId })}
        onSelect={setSelectedId}
      />
    </Shell>
  );
}
