import {
  AgentRunId,
  AgentRunInput,
  ChangeEvent,
  NotificationId,
  NotificationOutput,
  ProcurementCaseHeader,
  RequestId,
  electricalEquipmentSeedV1,
  type AgentRunInput as AgentRunInputValue,
  type McpToolName,
} from "@procurement/contracts";
import type { McpToolCaller } from "@procurement/mcp-client";
import { describe, expect, it } from "vitest";
import { NotificationAgent } from "./agent.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-09-03T10:00:00.000Z";
const inboxId = NotificationId.parse(uuid(30));

describe("NotificationAgent", () => {
  it("delivers a formed report to the inbox and does not open Telegram when not urgent", async () => {
    const tools: McpToolName[] = [];
    const agent = new NotificationAgent({
      caller: recordingCaller(tools),
    });

    const result = await agent.run(
      runInput({
        input: {
          title: "Поставка КТПБ",
          body: "# Поставка КТПБ\n\nАванс: 30%.",
          telegramChatIds: ["42"],
        },
      }),
    );
    const payload = NotificationOutput.parse(result.payload);

    expect(result.status).toBe("success");
    expect(payload.body).toContain("Аванс: 30%.");
    expect(payload.body).not.toMatch(/Аванс: 90%/);
    expect(payload.urgent).toBe(false);
    expect(payload.deliveries).toEqual([
      {
        channel: "inbox",
        destination: "inbox",
        notificationId: inboxId,
        duplicate: false,
      },
    ]);
    expect(payload.skipped).toEqual([{ channel: "telegram", reason: "not_urgent" }]);
    expect(tools).toEqual(["notification.send"]);
    expect(tools).not.toContain("telegram.send");
    expect(tools).not.toContain("procurement.search");
  });

  it("sends Telegram for an urgent ChangeEvent and never calls procurement tools", async () => {
    const tools: McpToolName[] = [];
    const agent = new NotificationAgent({
      caller: recordingCaller(tools),
    });

    const result = await agent.run(
      runInput({
        allowedTools: ["notification.send", "telegram.send", "procurement.search"],
        input: {
          telegramChatIds: ["42"],
          changes: [
            ChangeEvent.parse({
              id: uuid(3),
              procurementId: uuid(20),
              kind: "status_changed",
              previous: "accepting_bids",
              current: "cancelled",
              detectedAt: now,
              urgent: true,
            }),
          ],
        },
      }),
    );
    const payload = NotificationOutput.parse(result.payload);

    expect(result.status).toBe("success");
    expect(payload.urgent).toBe(true);
    expect(payload.body).toContain("Статус (срочно): accepting_bids → cancelled.");
    expect(payload.body).not.toMatch(/\d+%/);
    expect(payload.deliveries.map((item) => item.channel)).toEqual(["inbox", "telegram"]);
    expect(tools).toEqual(["notification.send", "telegram.send"]);
    expect(tools).not.toContain("procurement.search");
    expect(tools).not.toContain("documents.download");
  });

  it("asks a human when there is neither a formed body nor a change to render", async () => {
    const tools: McpToolName[] = [];
    const agent = new NotificationAgent({ caller: recordingCaller(tools) });

    const result = await agent.run(runInput({ input: {} }));

    expect(result.status).toBe("needs_human");
    expect(result.humanQuestion).toContain("Нет текста уведомления");
    expect(tools).toEqual([]);
  });
});

function recordingCaller(tools: McpToolName[]): McpToolCaller {
  return {
    async callTool(toolName, input) {
      tools.push(toolName);
      if (toolName === "notification.send") {
        return {
          structuredContent: {
            id: inboxId,
            channel: "inbox",
            duplicate: false,
            deliveredAt: now,
          },
        };
      }
      if (toolName === "telegram.send") {
        expect(input).toMatchObject({ chatId: "42" });
        expect(String((input as { text: string }).text).length).toBeLessThanOrEqual(4096);
        return {
          structuredContent: {
            messageId: "1",
            chatId: "42",
            duplicate: false,
            deliveredAt: now,
          },
        };
      }
      throw new Error(`unexpected tool ${toolName}`);
    },
  };
}

function runInput(options?: {
  allowedTools?: AgentRunInputValue["context"]["allowedTools"];
  input?: AgentRunInputValue["input"];
}) {
  return AgentRunInput.parse({
    runId: AgentRunId.parse(uuid(1)),
    requestId: RequestId.parse("req-notification"),
    capability: "notification",
    context: {
      event: {
        kind: "plan_step",
        description: "Доставить уведомление специалисту",
        occurredAt: now,
      },
      domainProfile: {
        slug: electricalEquipmentSeedV1.slug,
        name: electricalEquipmentSeedV1.name,
        purpose: electricalEquipmentSeedV1.purpose,
        instructions: electricalEquipmentSeedV1.instructions,
        keywords: electricalEquipmentSeedV1.keywords,
        excludeKeywords: [],
        semanticConcepts: electricalEquipmentSeedV1.semanticConcepts,
        positiveCriteria: electricalEquipmentSeedV1.positiveCriteria,
        negativeCriteria: electricalEquipmentSeedV1.negativeCriteria,
        constraints: [],
        monitoringRules: electricalEquipmentSeedV1.monitoringRules,
      },
      procurement: ProcurementCaseHeader.parse({
        id: uuid(20),
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/001",
        url: "https://goszakupki.by/auction/view/001",
        year: 2026,
        title: "Поставка КТПБ",
        kind: "electronic_auction",
        status: "accepting_bids",
        stage: "reported",
        createdAt: now,
        updatedAt: now,
      }),
      allowedTools: options?.allowedTools ?? ["notification.send", "telegram.send"],
      estimatedTokens: 200,
    },
    input: options?.input ?? {},
  });
}
