import {
  AgentRunInput,
  AgentRunOutput,
  ReportInput,
  ReportOutput,
  type AgentDefinition,
  type AgentRunInput as AgentRunInputValue,
  type AgentRunOutput as AgentRunOutputValue,
  type CapabilityId,
} from "@procurement/contracts";
import { compileProcurementReport } from "@procurement/domain";
import {
  DocumentsMcpClient,
  McpToolCallError,
  ToolPolicyDeniedError,
  ToolPolicyGate,
  type McpToolCaller,
} from "@procurement/mcp-client";
import { silentLogger, type Logger } from "@procurement/observability";
import { capabilityRegistry } from "../../registry/capabilities.js";

export interface ReportAgentOptions {
  caller: McpToolCaller;
  registry?: Readonly<Record<CapabilityId, AgentDefinition>>;
  logger?: Logger;
  clock?: () => Date;
}

export class ReportAgent {
  readonly #caller: McpToolCaller;
  readonly #registry: Readonly<Record<CapabilityId, AgentDefinition>>;
  readonly #logger: Logger;
  readonly #clock: () => Date;

  constructor(options: ReportAgentOptions) {
    this.#caller = options.caller;
    this.#registry = options.registry ?? capabilityRegistry;
    this.#logger = options.logger ?? silentLogger;
    this.#clock = options.clock ?? (() => new Date());
  }

  async run(rawInput: unknown): Promise<AgentRunOutputValue> {
    const input = AgentRunInput.parse(rawInput);
    const logger = this.#logger.child({
      requestId: input.requestId,
      runId: input.runId,
      agentId: "report",
      component: "report-agent",
    });
    if (input.capability !== "report") {
      throw new Error(`ReportAgent cannot run capability ${input.capability}`);
    }
    const procurement = input.context.procurement;
    if (procurement === undefined) {
      return escalateRun(input, "Для отчёта нужна выбранная закупка.");
    }

    const payload = ReportInput.parse(input.input ?? {});
    const compiled = compileProcurementReport({
      card: {
        title: procurement.title,
        url: procurement.url,
        status: procurement.status,
        kind: procurement.kind,
        sourceProcurementId: procurement.sourceProcurementId,
      },
      ...(input.context.domainProfile === undefined
        ? {}
        : { profileName: input.context.domainProfile.name }),
      ...(payload.terms === undefined ? {} : { terms: payload.terms }),
      changes: payload.changes,
      ...(payload.score === undefined ? {} : { score: payload.score }),
    });

    let storageKey: string | undefined;
    let hash: string | undefined;
    if (input.context.allowedTools.includes("files.put")) {
      const agent = this.#registry.report;
      const gate = new ToolPolicyGate({ agentAllowedTools: input.context.allowedTools });
      const files = new DocumentsMcpClient({
        caller: this.#caller,
        policyGate: gate,
        timeoutMs: agent.timeoutMs,
        logger,
      });
      try {
        const stored = await files.putFile(
          {
            bytesBase64: Buffer.from(compiled.markdown, "utf8").toString("base64"),
            contentType: "text/markdown; charset=UTF-8",
          },
          input.requestId,
        );
        storageKey = stored.storageKey;
        hash = stored.hash;
      } catch (error) {
        logger.error("Report file store failed", error);
        return failedRun(input, error);
      }
    }

    const output = ReportOutput.parse({
      title: compiled.title,
      markdown: compiled.markdown,
      sections: compiled.sections,
      missing: compiled.missing,
      generatedAt: this.#clock().toISOString(),
      ...(storageKey === undefined ? {} : { storageKey }),
      ...(hash === undefined ? {} : { hash }),
    });
    logger.info("Procurement report compiled", {
      missingCount: output.missing.length,
      stored: storageKey !== undefined,
    });
    return AgentRunOutput.parse({
      runId: input.runId,
      status: "success",
      confidence: 1,
      payload: output,
      nextRecommendedCapability: "notification",
    });
  }
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
