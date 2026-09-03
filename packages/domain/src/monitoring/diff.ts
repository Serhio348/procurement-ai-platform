import type {
  ChangeKind,
  DomainMonitoringRule,
  MonitoringSnapshot,
  SourceChange,
} from "@procurement/contracts";

export interface DetectedChange {
  kind: ChangeKind;
  field?: string;
  previous: string | null;
  current: string | null;
  urgent: boolean;
  notifyOnChange: boolean;
}

/**
 * Snapshot diff filtered by Domain Profile monitoring rules. A change the
 * profile does not watch is not an event. Recency never invents a watch.
 */
export function diffMonitoringSnapshots(
  previous: MonitoringSnapshot | undefined,
  current: MonitoringSnapshot,
  rules: readonly DomainMonitoringRule[],
  sourceChanges: readonly SourceChange[] = [],
): DetectedChange[] {
  if (previous === undefined) return [];

  const detected: DetectedChange[] = [];
  pushIfWatched(detected, rules, "status", {
    kind: "status_changed",
    field: "status",
    previous: previous.status,
    current: current.status,
  });
  pushIfWatched(detected, rules, "deadlines", {
    kind: "deadline_changed",
    field: "bidsDeadline",
    previous: serializeInstant(previous.bidsDeadline),
    current: serializeInstant(current.bidsDeadline),
  });

  if (isWatched(rules, "documents")) {
    const policy = policyFor(rules, "documents");
    const before = new Map(previous.documents.map((item) => [documentKey(item), item]));
    const after = new Map(current.documents.map((item) => [documentKey(item), item]));
    for (const [key, doc] of after) {
      const was = before.get(key);
      if (was === undefined) {
        detected.push({
          kind: "document_added",
          field: "documents",
          previous: null,
          current: doc.name,
          ...policy,
        });
        continue;
      }
      if (was.hash !== undefined && doc.hash !== undefined && was.hash !== doc.hash) {
        detected.push({
          kind: "document_updated",
          field: "hash",
          previous: was.hash,
          current: doc.hash,
          ...policy,
        });
      }
    }
    for (const [key, doc] of before) {
      if (after.has(key)) continue;
      detected.push({
        kind: "document_removed",
        field: "documents",
        previous: doc.name,
        current: null,
        ...policy,
      });
    }
  }

  for (const change of sourceChanges) {
    const watch = watchForKind(change.kind);
    if (watch === undefined || !isWatched(rules, watch)) continue;
    const key = `${change.kind}:${change.field ?? ""}:${change.previous}:${change.current}`;
    if (
      detected.some(
        (item) => `${item.kind}:${item.field ?? ""}:${item.previous}:${item.current}` === key,
      )
    ) {
      continue;
    }
    detected.push({
      kind: change.kind,
      ...(change.field === undefined ? {} : { field: change.field }),
      previous: change.previous,
      current: change.current,
      ...policyFor(rules, watch),
    });
  }

  return detected;
}

function pushIfWatched(
  detected: DetectedChange[],
  rules: readonly DomainMonitoringRule[],
  watch: DomainMonitoringRule["watch"],
  change: { kind: ChangeKind; field: string; previous: string | null; current: string | null },
): void {
  if (!isWatched(rules, watch)) return;
  if (change.previous === change.current) return;
  detected.push({ ...change, ...policyFor(rules, watch) });
}

function isWatched(
  rules: readonly DomainMonitoringRule[],
  watch: DomainMonitoringRule["watch"],
): boolean {
  return rules.some((rule) => rule.watch === watch);
}

function policyFor(
  rules: readonly DomainMonitoringRule[],
  watch: DomainMonitoringRule["watch"],
): Pick<DetectedChange, "urgent" | "notifyOnChange"> {
  const matching = rules.filter((rule) => rule.watch === watch);
  return {
    urgent: matching.some((rule) => rule.urgent),
    notifyOnChange: matching.some((rule) => rule.notifyOnChange),
  };
}

function watchForKind(kind: ChangeKind): DomainMonitoringRule["watch"] | undefined {
  switch (kind) {
    case "status_changed":
      return "status";
    case "price_changed":
      return "price";
    case "deadline_changed":
      return "deadlines";
    case "document_added":
    case "document_updated":
    case "document_removed":
      return "documents";
    default:
      return undefined;
  }
}

function documentKey(doc: { sourceUrl: string; downloadUrl?: string | undefined }): string {
  return doc.downloadUrl ?? doc.sourceUrl;
}

function serializeInstant(value: MonitoringSnapshot["bidsDeadline"]): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
