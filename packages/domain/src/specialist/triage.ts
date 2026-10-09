import type { SearchHit, SpecialistTriageKind } from "@procurement/contracts";

export function shouldRunDiscovery(watchNewProcurements: boolean): boolean {
  return watchNewProcurements;
}

export function isRejectedTriage(kind: SpecialistTriageKind | undefined): boolean {
  return kind === "reject";
}

/** Left the search on purpose: «Не нужно» or «Скрыть». Not a watched case. */
export function isDismissedTriage(kind: SpecialistTriageKind | undefined): boolean {
  return kind === "reject" || kind === "hide";
}

/**
 * Cron discovery must not re-offer a procedure the specialist already judged,
 * including reject / monitor / participate.
 */
export function partitionHitsByDecision(
  hits: readonly SearchHit[],
  decidedSourceIds: ReadonlySet<string>,
): { undecided: SearchHit[]; skippedDecidedCount: number } {
  const undecided: SearchHit[] = [];
  let skippedDecidedCount = 0;
  for (const hit of hits) {
    if (decidedSourceIds.has(hit.sourceProcurementId)) {
      skippedDecidedCount += 1;
      continue;
    }
    undecided.push(hit);
  }
  return { undecided, skippedDecidedCount };
}
