import { randomUUID } from "node:crypto";
import {
  RequestId,
  SourceId,
  SourceProcurementId,
  type ProcedureCard,
  type SourceId as SourceIdValue,
} from "@procurement/contracts";
import { ProcurementMcpClient, ToolPolicyGate, type McpToolCaller } from "@procurement/mcp-client";
import { silentLogger, type Logger } from "@procurement/observability";

/** Re-reads a decided case from the source. Absent: monitoring stays off. */
export interface SpecialistCardWatchPort {
  read: (sourceProcurementId: string) => Promise<ProcedureCard | undefined>;
}

export interface ProcurementCardWatchOptions {
  caller: McpToolCaller;
  sourceId: SourceIdValue;
  logger?: Logger;
  timeoutMs?: number;
}

/**
 * Monitoring only ever reads a card, so the gate allows procurement.get and
 * nothing else. A card that cannot be fetched returns undefined: one bad page
 * must not abort the pass or invent a change.
 */
export function createProcurementCardWatch(
  options: ProcurementCardWatchOptions,
): SpecialistCardWatchPort {
  const logger = options.logger ?? silentLogger;
  const sourceId = SourceId.parse(options.sourceId);
  const client = new ProcurementMcpClient({
    caller: options.caller,
    policyGate: new ToolPolicyGate({ agentAllowedTools: ["procurement.get"] }),
    timeoutMs: options.timeoutMs ?? 60_000,
    logger,
  });

  return {
    async read(sourceProcurementId) {
      try {
        return await client.get(
          { sourceId, sourceProcurementId: SourceProcurementId.parse(sourceProcurementId) },
          RequestId.parse(randomUUID()),
        );
      } catch (error) {
        logger.warn("Card watch skipped a case", {
          sourceProcurementId,
          err: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    },
  };
}
