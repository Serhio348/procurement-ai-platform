import type { McpToolName, RequestId } from "@procurement/contracts";
import type { Logger } from "@procurement/observability";
import { silentLogger } from "@procurement/observability";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { z } from "zod";
import type { ToolPolicyGate } from "./tool-policy.js";

export interface McpCallResult {
  structuredContent?: unknown | undefined;
  content?: unknown | undefined;
  isError?: boolean | undefined;
  errorKind?:
    | "not_found"
    | "source_unavailable"
    | "invalid_request"
    | "internal"
    | undefined;
}

export interface McpToolCaller {
  callTool(
    toolName: McpToolName,
    argumentsValue: Record<string, unknown>,
    options: { requestId: RequestId; timeoutMs: number },
  ): Promise<McpCallResult>;
}

/**
 * Stdio MCP is one request at a time: overlapping get + get_documents
 * cross on the pipe and both answers are lost. Queue calls instead.
 */
export function serializeMcpToolCaller(inner: McpToolCaller): McpToolCaller {
  let tail: Promise<void> = Promise.resolve();
  return {
    callTool(toolName, argumentsValue, options) {
      const run = tail.then(() => inner.callTool(toolName, argumentsValue, options));
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

export class SdkMcpToolCaller implements McpToolCaller {
  constructor(private readonly client: Client) {}

  async callTool(
    toolName: McpToolName,
    argumentsValue: Record<string, unknown>,
    options: { requestId: RequestId; timeoutMs: number },
  ): Promise<McpCallResult> {
    const result = await this.client.callTool(
      {
        name: toolName,
        arguments: argumentsValue,
        _meta: { requestId: options.requestId },
      },
      undefined,
      { timeout: options.timeoutMs },
    );
    if ("toolResult" in result) {
      return { structuredContent: result.toolResult };
    }
    const errorKind = parseRemoteErrorKind(result._meta?.["errorKind"]);
    return {
      content: result.content,
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
      ...(result.isError === undefined ? {} : { isError: result.isError }),
      ...(errorKind === undefined ? {} : { errorKind }),
    };
  }
}

export type McpToolCallErrorKind =
  | "remote_error"
  | "timeout"
  | "invalid_output"
  | "not_found"
  | "source_unavailable"
  | "invalid_request"
  | "internal";

export class McpToolCallError extends Error {
  readonly kind: McpToolCallErrorKind;
  readonly toolName: McpToolName;

  constructor(kind: McpToolCallErrorKind, toolName: McpToolName, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "McpToolCallError";
    this.kind = kind;
    this.toolName = toolName;
  }
}

export interface ValidatedToolCallOptions<Input extends Record<string, unknown>, Output> {
  toolName: McpToolName;
  input: Input;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
  caller: McpToolCaller;
  policyGate: ToolPolicyGate;
  requestId: RequestId;
  timeoutMs: number;
  logger?: Logger;
}

export async function callValidatedTool<Input extends Record<string, unknown>, Output>(
  options: ValidatedToolCallOptions<Input, Output>,
): Promise<Output> {
  options.policyGate.assertAllowed(options.toolName);
  const input = options.inputSchema.parse(options.input);
  const logger = (options.logger ?? silentLogger).child({
    requestId: options.requestId,
    toolName: options.toolName,
    component: "mcp-client",
  });
  const startedAt = Date.now();

  try {
    const result = await options.caller.callTool(
      options.toolName,
      input,
      {
        requestId: options.requestId,
        timeoutMs: options.timeoutMs,
      },
    );

    if (result.isError === true) {
      throw new McpToolCallError(
        result.errorKind ?? "remote_error",
        options.toolName,
        extractErrorMessage(result.content),
      );
    }

    const parsed = options.outputSchema.safeParse(result.structuredContent);
    if (!parsed.success) {
      throw new McpToolCallError(
        "invalid_output",
        options.toolName,
        `Invalid structured output from ${options.toolName}`,
        parsed.error,
      );
    }

    logger.info("MCP tool call completed", { durationMs: Date.now() - startedAt });
    return parsed.data;
  } catch (error) {
    const mapped = mapToolError(options.toolName, error);
    logger.error("MCP tool call failed", mapped, { durationMs: Date.now() - startedAt });
    throw mapped;
  }
}

function parseRemoteErrorKind(value: unknown): McpCallResult["errorKind"] {
  if (
    value === "not_found" ||
    value === "source_unavailable" ||
    value === "invalid_request" ||
    value === "internal"
  ) {
    return value;
  }
  return undefined;
}

function mapToolError(toolName: McpToolName, error: unknown): McpToolCallError {
  if (error instanceof McpToolCallError) return error;
  if (
    error instanceof Error &&
    (error.name.toLowerCase().includes("timeout") || error.message.toLowerCase().includes("timed out"))
  ) {
    return new McpToolCallError("timeout", toolName, `MCP tool ${toolName} timed out`, error);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new McpToolCallError("remote_error", toolName, message, error);
}

function extractErrorMessage(content: unknown): string {
  if (Array.isArray(content)) {
    const text = content.find(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string",
    );
    if (text !== undefined) return text.text;
  }
  return "MCP tool returned an error";
}
