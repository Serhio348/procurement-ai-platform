import {
  AgentRunInput,
  AgentRunOutput,
  NotificationInput,
  NotificationOutput,
  type AgentDefinition,
  type AgentRunInput as AgentRunInputValue,
  type AgentRunOutput as AgentRunOutputValue,
  type CapabilityId,
  type InboxFixtureItem,
  type NotificationDelivery,
  type NotificationSkipped,
} from "@procurement/contracts";
import { compileChangeAlert, compileTelegramText, routeNotification } from "@procurement/domain";
import {
  McpToolCallError,
  NotificationsMcpClient,
  ToolPolicyDeniedError,
  ToolPolicyGate,
  type McpToolCaller,
} from "@procurement/mcp-client";
import { silentLogger, type Logger } from "@procurement/observability";
import { capabilityRegistry } from "../../registry/capabilities.js";
import type { SpecialistInboxEvents } from "./inbox-events.js";

export interface NotificationAgentOptions {
  caller: McpToolCaller;
  registry?: Readonly<Record<CapabilityId, AgentDefinition>>;
  logger?: Logger;
  inboxEvents?: SpecialistInboxEvents;
}

export class NotificationAgent {
  readonly #caller: McpToolCaller;
  readonly #registry: Readonly<Record<CapabilityId, AgentDefinition>>;
  readonly #logger: Logger;
  readonly #inboxEvents: SpecialistInboxEvents | undefined;

  constructor(options: NotificationAgentOptions) {
    this.#caller = options.caller;
    this.#registry = options.registry ?? capabilityRegistry;
    this.#logger = options.logger ?? silentLogger;
    this.#inboxEvents = options.inboxEvents ?? undefined;
  }

  async run(rawInput: unknown): Promise<AgentRunOutputValue> {
    const input = AgentRunInput.parse(rawInput);
    const logger = this.#logger.child({
      requestId: input.requestId,
      runId: input.runId,
      agentId: "notification",
      component: "notification-agent",
    });
    if (input.capability !== "notification") {
      throw new Error(`NotificationAgent cannot run capability ${input.capability}`);
    }

    const payload = NotificationInput.parse(input.input ?? {});
    const procurement = input.context.procurement;
    const urgent = payload.urgent ?? payload.changes.some((change) => change.urgent);
    const compiled =
      payload.body === undefined
        ? compileChangeAlert(payload.changes, {
            ...(payload.title === undefined
              ? procurement === undefined
                ? {}
                : { title: procurement.title }
              : { title: payload.title }),
            ...(procurement === undefined
              ? {}
              : {
                  sourceProcurementId: procurement.sourceProcurementId,
                  url: procurement.url,
                }),
          })
        : undefined;
    const body = payload.body ?? compiled?.body;
    const title =
      payload.title ??
      compiled?.title ??
      procurement?.title ??
      (body === undefined ? undefined : "Уведомление");
    if (title === undefined || body === undefined) {
      return escalateRun(input, "Нет текста уведомления и нет изменений для доставки.");
    }

    const agent = this.#registry.notification;
    const gate = new ToolPolicyGate({
      agentAllowedTools: input.context.allowedTools,
      agentForbiddenTools: agent.forbiddenTools,
    });
    const notifications = new NotificationsMcpClient({
      caller: this.#caller,
      policyGate: gate,
      timeoutMs: agent.timeoutMs,
      logger,
    });
    const route = routeNotification({
      urgent,
      telegramChatIds: payload.telegramChatIds,
    });
    const dedupeKey = payload.dedupeKey ?? `${procurement?.id ?? input.runId}:${title}`;
    const skipped: NotificationSkipped[] = [];

    if (!urgent) {
      skipped.push({ channel: "telegram", reason: "not_urgent" });
    } else if (payload.telegramChatIds.length === 0) {
      skipped.push({ channel: "telegram", reason: "no_chat_ids" });
    } else if (!input.context.allowedTools.includes("telegram.send")) {
      skipped.push({ channel: "telegram", reason: "tool_not_allowed" });
    }

    try {
      const inbox = await notifications.send(
        {
          title,
          body,
          urgency: urgent ? "urgent" : "normal",
          dedupeKey,
          ...(procurement === undefined ? {} : { procurementId: procurement.id }),
        },
        input.requestId,
      );
      const deliveries: NotificationDelivery[] = [
        {
          channel: "inbox",
          destination: "inbox",
          notificationId: inbox.id,
          duplicate: inbox.duplicate,
        },
      ];

      if (route.telegramChatIds.length > 0 && input.context.allowedTools.includes("telegram.send")) {
        const text = compileTelegramText(title, body);
        for (const chatId of route.telegramChatIds) {
          const sent = await notifications.sendTelegram(
            {
              chatId,
              text,
              urgency: urgent ? "urgent" : "normal",
              dedupeKey,
            },
            input.requestId,
          );
          deliveries.push({
            channel: "telegram",
            destination: chatId,
            messageId: sent.messageId,
            duplicate: sent.duplicate,
          });
        }
      }

      const output = NotificationOutput.parse({
        title,
        body,
        urgent,
        deliveries,
        skipped,
        deliveredAt: inbox.deliveredAt,
      });
      logger.info("Notification delivered", {
        urgent,
        deliveryCount: deliveries.length,
        skippedCount: skipped.length,
      });
      if (this.#inboxEvents !== undefined && procurement !== undefined) {
        for (const change of payload.changes) {
          const item: InboxFixtureItem = {
            procurement: {
              title: procurement.title,
              status: procurement.status,
              url: procurement.url,
              sourceProcurementId: procurement.sourceProcurementId,
            },
            change,
          };
          try {
            await this.#inboxEvents.record(item);
          } catch (error) {
            logger.error("Specialist inbox projection failed", error);
          }
        }
      }
      return AgentRunOutput.parse({
        runId: input.runId,
        status: "success",
        confidence: 1,
        payload: output,
      });
    } catch (error) {
      logger.error("Notification delivery failed", error);
      return failedRun(input, error);
    }
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
