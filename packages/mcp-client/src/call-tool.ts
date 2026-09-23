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
    options: { requestId: RequestId; timeoutMs: number; priority?: "high" | "normal" },
  ): Promise<McpCallResult>;
}

/**
 * Stdio MCP is one request at a time: overlapping get + get_documents
 * cross on the pipe and both answers are lost. Queue calls instead.
 *
 * `timeoutMs` is the whole budget — queue wait plus execution (R43): a call
 * that outlives its deadline while waiting fails instead of holding the
 * pipe's turn indefinitely. "high" priority entries jump ahead of queued
 * "normal" ones so a single card re-read does not sit behind a bulk
 * download batch from another job; FIFO is kept within a level.
 */
export function serializeMcpToolCaller(inner: McpToolCaller): McpToolCaller {
  interface QueuedCall {
    priority: number;
    run(): Promise<void>;
  }
  const queue: QueuedCall[] = [];
  let running = false;
  const pump = (): void => {
    if (running) return;
    const next = queue.shift();
    if (next === undefined) return;
    running = true;
    void next.run().finally(() => {
      running = false;
      pump();
    });
  };
  return {
    callTool(toolName, argumentsValue, options) {
      const deadline = Date.now() + options.timeoutMs;
      const result = new Promise<McpCallResult>((resolve, reject) => {
        const entry: QueuedCall = {
          priority: options.priority === "high" ? 0 : 1,
          run: async () => {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              reject(
                new McpToolCallError(
                  "timeout",
                  toolName,
                  `MCP tool ${toolName} timed out waiting in the queue`,
                ),
              );
              return;
            }
            try {
              resolve(
                await inner.callTool(toolName, argumentsValue, {
                  ...options,
                  timeoutMs: remaining,
                }),
              );
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          },
        };
        const later = queue.findIndex((item) => item.priority > entry.priority);
        if (later === -1) queue.push(entry);
        else queue.splice(later, 0, entry);
      });
      pump();
      return result;
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
  /** "high" jumps the shared queue ahead of bulk background work (R43). */
  priority?: "high" | "normal";
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
        ...(options.priority === undefined ? {} : { priority: options.priority }),
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
