import {
  NotificationSendRequest,
  NotificationSendResponse,
  TelegramSendRequest,
  TelegramSendResponse,
  type McpToolName,
  type RequestId,
  type NotificationSendResponse as NotificationSendResponseValue,
  type TelegramSendResponse as TelegramSendResponseValue,
} from "@procurement/contracts";
import type { z } from "zod";
import type { Logger } from "@procurement/observability";
import { silentLogger } from "@procurement/observability";
import { callValidatedTool, type McpToolCaller } from "./call-tool.js";
import type { ToolPolicyGate } from "./tool-policy.js";

export interface NotificationsMcpClientOptions {
  caller: McpToolCaller;
  policyGate: ToolPolicyGate;
  timeoutMs?: number;
  logger?: Logger;
}

export class NotificationsMcpClient {
  readonly #caller: McpToolCaller;
  readonly #policyGate: ToolPolicyGate;
  readonly #timeoutMs: number;
  readonly #logger: Logger;

  constructor(options: NotificationsMcpClientOptions) {
    this.#caller = options.caller;
    this.#policyGate = options.policyGate;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#logger = options.logger ?? silentLogger;
  }

  send(
    input: z.input<typeof NotificationSendRequest>,
    requestId: RequestId,
  ): Promise<NotificationSendResponseValue> {
    return this.#call(
      "notification.send",
      input,
      NotificationSendRequest,
      NotificationSendResponse,
      requestId,
    );
  }

  sendTelegram(
    input: z.input<typeof TelegramSendRequest>,
    requestId: RequestId,
  ): Promise<TelegramSendResponseValue> {
    return this.#call("telegram.send", input, TelegramSendRequest, TelegramSendResponse, requestId);
  }

  #call<Input extends Record<string, unknown>, Output>(
    toolName: McpToolName,
    input: Input,
    inputSchema: Parameters<typeof callValidatedTool<Input, Output>>[0]["inputSchema"],
    outputSchema: Parameters<typeof callValidatedTool<Input, Output>>[0]["outputSchema"],
    requestId: RequestId,
  ): Promise<Output> {
    return callValidatedTool({
      toolName,
      input,
      inputSchema,
      outputSchema,
      caller: this.#caller,
      policyGate: this.#policyGate,
      requestId,
      timeoutMs: this.#timeoutMs,
      logger: this.#logger,
    });
  }
}
