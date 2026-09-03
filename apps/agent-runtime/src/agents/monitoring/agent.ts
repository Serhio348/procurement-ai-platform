import {
  AgentRunInput,
  AgentRunOutput,
  ChangeEvent,
  ChangeEventId,
  MonitoringInput,
  MonitoringOutput,
  MonitoringSnapshot,
  type AgentDefinition,
  type AgentRunInput as AgentRunInputValue,
  type AgentRunOutput as AgentRunOutputValue,
  type CapabilityId,
  type MonitoredDocument,
  type MonitoringInput as MonitoringInputValue,
  type ProcurementGetStatusResponse,
  type SourceChange,
  type SourceDocument,
} from "@procurement/contracts";
import { diffMonitoringSnapshots } from "@procurement/domain";
import {
  McpToolCallError,
  ProcurementMcpClient,
  ToolPolicyDeniedError,
  ToolPolicyGate,
  type McpToolCaller,
} from "@procurement/mcp-client";
import { silentLogger, type Logger } from "@procurement/observability";
import { capabilityRegistry } from "../../registry/capabilities.js";

export interface MonitoringAgentOptions {
  caller: McpToolCaller;
  registry?: Readonly<Record<CapabilityId, AgentDefinition>>;
  logger?: Logger;
  clock?: () => Date;
  changeEventId?: () => ChangeEventId;
}

export class MonitoringAgent {
  readonly #caller: McpToolCaller;
  readonly #registry: Readonly<Record<CapabilityId, AgentDefinition>>;
  readonly #logger: Logger;
  readonly #clock: () => Date;
  readonly #changeEventId: () => ChangeEventId;

  constructor(options: MonitoringAgentOptions) {
    this.#caller = options.caller;
    this.#registry = options.registry ?? capabilityRegistry;
    this.#logger = options.logger ?? silentLogger;
    this.#clock = options.clock ?? (() => new Date());
    this.#changeEventId = options.changeEventId ?? (() => ChangeEventId.parse(crypto.randomUUID()));
  }

  async run(rawInput: unknown): Promise<AgentRunOutputValue> {
    const input = AgentRunInput.parse(rawInput);
    const logger = this.#logger.child({
      requestId: input.requestId,
      runId: input.runId,
      agentId: "monitoring",
      component: "monitoring-agent",
    });
    if (input.capability !== "monitoring") {
      throw new Error(`MonitoringAgent cannot run capability ${input.capability}`);
    }
    const agent = this.#registry.monitoring;
    const procurement = input.context.procurement;
    const sourceId = procurement?.sourceId;
    const sourceProcurementId = procurement?.sourceProcurementId;
    if (procurement === undefined || sourceId === undefined || sourceProcurementId === undefined) {
      return escalateRun(input, "Для мониторинга нужна выбранная закупка.");
    }

    const payload = MonitoringInput.parse(input.input ?? {});
    const gate = new ToolPolicyGate({ agentAllowedTools: input.context.allowedTools });
    const procurementClient = new ProcurementMcpClient({
      caller: this.#caller,
      policyGate: gate,
      timeoutMs: agent.timeoutMs,
      logger,
    });
    const locator = { sourceId, sourceProcurementId };

    let status: ProcurementGetStatusResponse;
    let documents: SourceDocument[];
    let sourceChanges: SourceChange[] = [];
    try {
      status = await procurementClient.getStatus(locator, input.requestId);
      documents = (await procurementClient.getDocuments(locator, input.requestId)).documents;
      if (input.context.allowedTools.includes("procurement.get_changes")) {
        sourceChanges = (
          await procurementClient.getChanges(
            {
              ...locator,
              ...(payload.since === undefined && payload.previous === undefined
                ? {}
                : { since: payload.since ?? payload.previous?.fetchedAt }),
            },
            input.requestId,
          )
        ).changes;
      }
    } catch (error) {
      logger.error("Monitoring MCP call failed", error);
      return failedRun(input, error);
    }

    const snapshot = MonitoringSnapshot.parse({
      status: status.status,
      ...(status.sourceStatus === undefined ? {} : { sourceStatus: status.sourceStatus }),
      ...(status.bidsDeadline === undefined ? {} : { bidsDeadline: status.bidsDeadline }),
      documents: overlayHashes(documents, payload),
      fetchedAt: status.fetchedAt,
    });
    const rules = input.context.domainProfile?.monitoringRules ?? [];
    const detected = diffMonitoringSnapshots(payload.previous, snapshot, rules, sourceChanges);
    const checkedAt = this.#clock().toISOString();
    const changes = detected.map((change) =>
      ChangeEvent.parse({
        id: this.#changeEventId(),
        procurementId: procurement.id,
        kind: change.kind,
        ...(change.field === undefined ? {} : { field: change.field }),
        previous: change.previous,
        current: change.current,
        detectedAt: checkedAt,
        urgent: change.urgent,
      }),
    );
    const output = MonitoringOutput.parse({
      snapshot,
      changes,
      unchanged: changes.length === 0,
      checkedAt,
    });
    const notify = detected.some((change) => change.notifyOnChange);
    logger.info("Monitoring check completed", {
      changeCount: changes.length,
      unchanged: output.unchanged,
    });
    return AgentRunOutput.parse({
      runId: input.runId,
      status: "success",
      confidence: 1,
      payload: output,
      ...(notify ? { nextRecommendedCapability: "notification" } : {}),
    });
  }
}

function overlayHashes(
  documents: readonly SourceDocument[],
  payload: MonitoringInputValue,
): MonitoredDocument[] {
  const hashes = new Map(payload.documentHashes.map((item) => [item.sourceUrl, item.hash]));
  return documents.map((item) => {
    const hash = hashes.get(item.sourceUrl);
    return {
      name: item.name,
      sourceUrl: item.sourceUrl,
      ...(item.downloadUrl === undefined ? {} : { downloadUrl: item.downloadUrl }),
      ...(hash === undefined ? {} : { hash }),
    };
  });
}

function escalateRun(input: AgentRunInputValue, humanQuestion: string): AgentRunOutputValue {
  return AgentRunOutput.parse({
    runId: input.runId,
    status: "needs_human",
    confidence: 0,
    payload: {},
    humanQuestion,
  });
}

function failedRun(input: AgentRunInputValue, error: unknown): AgentRunOutputValue {
  if (error instanceof ToolPolicyDeniedError) {
    return AgentRunOutput.parse({
      runId: input.runId,
      status: "failed",
      confidence: 0,
      payload: {},
      error: {
        kind: "permission_denied",
        message: error.message,
        toolName: error.toolName,
      },
    });
  }
  const toolError = error instanceof McpToolCallError ? error : undefined;
  const kind =
    toolError?.kind === "timeout"
      ? "timeout"
      : toolError?.kind === "invalid_output"
        ? "invalid_output"
        : "retryable";
  return AgentRunOutput.parse({
    runId: input.runId,
    status: "failed",
    confidence: 0,
    payload: {},
    error: {
      kind,
      message: error instanceof Error ? error.message : String(error),
      ...(toolError === undefined ? {} : { toolName: toolError.toolName }),
    },
  });
}
