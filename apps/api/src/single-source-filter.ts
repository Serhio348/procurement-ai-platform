import type { SearchHit, SpecialistWorkingProfile } from "@procurement/contracts";
import { isSingleSourceAfterFailedProcedure } from "@procurement/domain";
import { silentLogger, type Logger } from "@procurement/observability";
import type { SpecialistCardWatchPort } from "./card-watch.js";

export interface FailedSingleSourceFilter {
  apply: (
    hits: readonly SearchHit[],
    profile: Pick<SpecialistWorkingProfile, "excludeSingleSourceAfterFailed">,
    options?: { beforeRequest?: () => Promise<void> },
  ) => Promise<{ hits: SearchHit[]; droppedCount: number }>;
}

/**
 * The basis of a single-source purchase is only on its card, so honouring
 * "exclude after a failed procedure" costs one card read per single-source
 * hit. Verdicts are cached for the process lifetime: the basis of a purchase
 * never changes. A card that could not be read keeps its hit — missing data
 * is not a reason to hide a procedure — and is retried next time.
 */
export function createFailedSingleSourceFilter(options: {
  cardWatch?: SpecialistCardWatchPort;
  logger?: Logger;
}): FailedSingleSourceFilter {
  const logger = options.logger ?? silentLogger;
  const cardWatch = options.cardWatch;
  const verdicts = new Map<string, boolean>();

  return {
    async apply(hits, profile, callOptions) {
      if (!profile.excludeSingleSourceAfterFailed || cardWatch === undefined) {
        return { hits: [...hits], droppedCount: 0 };
      }
      const kept: SearchHit[] = [];
      let droppedCount = 0;
      for (const hit of hits) {
        if (hit.kind !== "single_source") {
          kept.push(hit);
          continue;
        }
        let verdict = verdicts.get(hit.sourceProcurementId);
        if (verdict === undefined) {
          await callOptions?.beforeRequest?.();
          const card = await cardWatch.read(hit.sourceProcurementId);
          if (card === undefined) {
            kept.push(hit);
            continue;
          }
          verdict = isSingleSourceAfterFailedProcedure(card);
          verdicts.set(hit.sourceProcurementId, verdict);
        }
        if (verdict) {
          droppedCount += 1;
          continue;
        }
        kept.push(hit);
      }
      if (droppedCount > 0) {
        logger.info("Single-source hits after a failed procedure dropped", { droppedCount });
      }
      return { hits: kept, droppedCount };
    },
  };
}
