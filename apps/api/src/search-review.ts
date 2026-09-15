import { randomUUID } from "node:crypto";
import {
  RequestId,
  type ProcedureCard,
  type SearchHit,
  type SearchClassifierInput,
} from "@procurement/contracts";
import {
  buildSearchClassifierInput,
  outcomeFromCardReview,
  outcomeFromModel,
  quotaOutcome,
  reviewByCard,
  reviewByIntentCard,
  unavailableOutcome,
  type ReviewOutcome,
  type ReviewProfile,
} from "@procurement/domain";
import { ProcurementMcpClient, ToolPolicyGate, type McpToolCaller } from "@procurement/mcp-client";
import { silentLogger, type Logger } from "@procurement/observability";

/** Second look at hits the title could not settle. Absent: everything waits for a human. */
export interface SpecialistReviewPort {
  review: (hits: readonly SearchHit[], profile: ReviewProfile) => Promise<ReviewOutcome[]>;
}

export interface SearchClassifierPort {
  classify: (input: SearchClassifierInput) => Promise<unknown>;
}

export interface ProcurementSearchReviewOptions {
  caller: McpToolCaller;
  classifier?: SearchClassifierPort;
  /** Below this the model's answer is only a hint for the specialist. */
  minConfidence?: number;
  /** Model calls one search run may spend; the rest wait for a human. */
  maxModelCalls?: number;
  concurrency?: number;
  logger?: Logger;
  timeoutMs?: number;
}

export const DEFAULT_REVIEW_MIN_CONFIDENCE = 0.7;
export const DEFAULT_REVIEW_MAX_MODEL_CALLS = 50;

/**
 * Card first, model second. The card is fetched through Procurement MCP with
 * only procurement.get allowed; a keyword exact in a lot settles the case
 * without a model. Failures never drop a hit: they degrade to "needs_human".
 */
export function createProcurementSearchReview(
  options: ProcurementSearchReviewOptions,
): SpecialistReviewPort {
  const logger = options.logger ?? silentLogger;
  const client = new ProcurementMcpClient({
    caller: options.caller,
    policyGate: new ToolPolicyGate({ agentAllowedTools: ["procurement.get"] }),
    timeoutMs: options.timeoutMs ?? 60_000,
    logger,
  });
  const minConfidence = options.minConfidence ?? DEFAULT_REVIEW_MIN_CONFIDENCE;
  const maxModelCalls = options.maxModelCalls ?? DEFAULT_REVIEW_MAX_MODEL_CALLS;
  const concurrency = Math.max(1, options.concurrency ?? 4);

  return {
    async review(hits, profile) {
      let modelCalls = 0;
      const results: ReviewOutcome[] = new Array<ReviewOutcome>(hits.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < hits.length) {
          const index = next;
          next += 1;
          const hit = hits[index];
          if (hit === undefined) continue;
          const card = await fetchCard(client, hit, logger);
          if (card !== undefined && profile.intent !== undefined) {
            const byIntent = reviewByIntentCard(card, profile.intent);
            if (byIntent !== undefined) {
              results[index] = byIntent;
              continue;
            }
          } else if (card !== undefined) {
            const byCard = outcomeFromCardReview(reviewByCard(card, profile));
            if (byCard !== undefined) {
              results[index] = byCard;
              continue;
            }
          }
          if (options.classifier === undefined) {
            results[index] = unavailableOutcome();
            continue;
          }
          if (modelCalls >= maxModelCalls) {
            results[index] = quotaOutcome();
            continue;
          }
          modelCalls += 1;
          results[index] = await classify(options.classifier, profile, hit, card, minConfidence, logger);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, hits.length) }, worker));
      return results;
    },
  };
}

async function fetchCard(
  client: ProcurementMcpClient,
  hit: SearchHit,
  logger: Logger,
): Promise<ProcedureCard | undefined> {
  try {
    return await client.get(
      { sourceId: hit.sourceId, sourceProcurementId: hit.sourceProcurementId },
      RequestId.parse(randomUUID()),
    );
  } catch (error) {
    logger.warn("Search review skipped card fetch", {
      sourceProcurementId: hit.sourceProcurementId,
      err: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function classify(
  classifier: SearchClassifierPort,
  profile: ReviewProfile,
  hit: SearchHit,
  card: ProcedureCard | undefined,
  minConfidence: number,
  logger: Logger,
): Promise<ReviewOutcome> {
  try {
    const raw = await classifier.classify(buildSearchClassifierInput(profile, hit, card));
    return outcomeFromModel(raw, minConfidence);
  } catch (error) {
    logger.error("Search review classifier failed", error, {
      sourceProcurementId: hit.sourceProcurementId,
    });
    return {
      verdict: "needs_human",
      decidedBy: "model",
      reason: "Модель недоступна — проверьте по смыслу.",
      matchedTerms: [],
      confidence: 0,
    };
  }
}
