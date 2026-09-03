import {
  AgentRunId,
  AgentRunInput,
  ChangeEventId,
  MonitoringOutput,
  MonitoringSnapshot,
  ProcurementCaseHeader,
  RequestId,
  SourceDocument,
  electricalEquipmentSeedV1,
  type AgentRunInput as AgentRunInputValue,
  type McpToolName,
  type ProcedureStatus,
} from "@procurement/contracts";
import type { McpToolCaller } from "@procurement/mcp-client";
import { describe, expect, it } from "vitest";
import { MonitoringAgent } from "./agent.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-09-03T09:00:00.000Z";
const earlier = "2026-09-02T09:00:00.000Z";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const specUrl = "https://example.test/files/spec-001.pdf";

describe("MonitoringAgent", () => {
  it("takes a baseline snapshot without inventing changes or sending telegram", async () => {
    const tools: McpToolName[] = [];
    const agent = new MonitoringAgent({
      caller: recordingCaller(tools, { status: "accepting_bids" }),
      clock: () => new Date(now),
      changeEventId: () => ChangeEventId.parse(uuid(40)),
    });

    const result = await agent.run(runInput());
    const payload = MonitoringOutput.parse(result.payload);

    expect(result.status).toBe("success");
    expect(payload.unchanged).toBe(true);
    expect(payload.changes).toEqual([]);
    expect(result.nextRecommendedCapability).toBeUndefined();
    expect(tools).toEqual([
      "procurement.get_status",
      "procurement.get_documents",
      "procurement.get_changes",
    ]);
    expect(tools).not.toContain("telegram.send");
  });

  it("emits a status change when the profile watches status", async () => {
    const tools: McpToolName[] = [];
    const agent = new MonitoringAgent({
      caller: recordingCaller(tools, { status: "cancelled" }),
      clock: () => new Date(now),
      changeEventId: () => ChangeEventId.parse(uuid(41)),
    });

    const result = await agent.run(
      runInput({
        input: { previous: previousSnapshot({ status: "accepting_bids" }) },
      }),
    );
    const payload = MonitoringOutput.parse(result.payload);

    expect(payload.unchanged).toBe(false);
    expect(payload.changes).toEqual([
      expect.objectContaining({
        kind: "status_changed",
        previous: "accepting_bids",
        current: "cancelled",
        urgent: true,
      }),
    ]);
    expect(result.nextRecommendedCapability).toBe("notification");
    expect(tools).not.toContain("telegram.send");
  });

  it("ignores a status change when the profile only watches documents", async () => {
    const agent = new MonitoringAgent({
      caller: recordingCaller([], { status: "cancelled" }),
      clock: () => new Date(now),
    });

    const result = await agent.run(
      runInput({
        watches: ["documents"],
        input: { previous: previousSnapshot({ status: "accepting_bids" }) },
      }),
    );
    const payload = MonitoringOutput.parse(result.payload);
    expect(payload.unchanged).toBe(true);
    expect(result.nextRecommendedCapability).toBeUndefined();
  });

  it("reports a document hash change from a prior ingest overlay", async () => {
    const agent = new MonitoringAgent({
      caller: recordingCaller([], { status: "accepting_bids" }),
      clock: () => new Date(now),
      changeEventId: () => ChangeEventId.parse(uuid(42)),
    });

    const result = await agent.run(
      runInput({
        watches: ["documents"],
        input: {
          previous: previousSnapshot({
            documents: [{ name: "ТЗ.pdf", sourceUrl: specUrl, hash: hashA }],
          }),
          documentHashes: [{ sourceUrl: specUrl, hash: hashB }],
        },
      }),
    );
    const payload = MonitoringOutput.parse(result.payload);
    expect(payload.changes).toEqual([
      expect.objectContaining({ kind: "document_updated", previous: hashA, current: hashB }),
    ]);
  });

  it("does not list status when procurement.get_status is not allowed", async () => {
    const tools: McpToolName[] = [];
    const agent = new MonitoringAgent({
      caller: recordingCaller(tools, { status: "accepting_bids" }),
    });

    const result = await agent.run(runInput({ allowedTools: ["procurement.get_documents"] }));
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("permission_denied");
    expect(tools).toEqual([]);
  });
});

function recordingCaller(
  tools: McpToolName[],
  options: { status: ProcedureStatus },
): McpToolCaller {
  return {
    async callTool(toolName) {
      tools.push(toolName);
      if (toolName === "procurement.get_status") {
        return {
          structuredContent: {
            status: options.status,
            fetchedAt: now,
          },
        };
      }
      if (toolName === "procurement.get_documents") {
        return {
          structuredContent: {
            documents: [
              SourceDocument.parse({
                name: "ТЗ.pdf",
                sourceUrl: specUrl,
                mimeType: "application/pdf",
                discoveredAt: now,
              }),
            ],
          },
        };
      }
      if (toolName === "procurement.get_changes") {
        return { structuredContent: { changes: [] } };
      }
      throw new Error(`unexpected tool ${toolName}`);
    },
  };
}

function previousSnapshot(
  overrides: Partial<Parameters<typeof MonitoringSnapshot.parse>[0]> = {},
) {
  return MonitoringSnapshot.parse({
    status: "accepting_bids",
    documents: [{ name: "ТЗ.pdf", sourceUrl: specUrl }],
    fetchedAt: earlier,
    ...overrides,
  });
}

function runInput(options?: {
  allowedTools?: AgentRunInputValue["context"]["allowedTools"];
  watches?: Array<"status" | "documents" | "deadlines">;
  input?: AgentRunInputValue["input"];
}) {
  const watches = options?.watches ?? ["status", "documents", "deadlines"];
  return AgentRunInput.parse({
    runId: AgentRunId.parse(uuid(1)),
    requestId: RequestId.parse("req-monitor"),
    capability: "monitoring",
    context: {
      event: {
        kind: "plan_step",
        description: "Проверить изменения выбранной закупки",
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
        monitoringRules: watches.map((watch) => ({
          watch,
          intervalMinutes: 480,
          notifyOnChange: true,
          urgent: watch === "status",
        })),
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
        stage: "card_fetched",
        createdAt: earlier,
        updatedAt: earlier,
      }),
      allowedTools: options?.allowedTools ?? [
        "procurement.get_status",
        "procurement.get_changes",
        "procurement.get_documents",
      ],
      estimatedTokens: 400,
    },
    input: options?.input ?? {},
  });
}
