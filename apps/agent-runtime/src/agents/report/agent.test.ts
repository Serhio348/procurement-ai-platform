import {
  AgentRunId,
  AgentRunInput,
  CommercialTerms,
  FactId,
  ProcurementCaseHeader,
  ReportOutput,
  RequestId,
  electricalEquipmentSeedV1,
  type AgentRunInput as AgentRunInputValue,
  type McpToolName,
} from "@procurement/contracts";
import type { McpToolCaller } from "@procurement/mcp-client";
import { describe, expect, it } from "vitest";
import { ReportAgent } from "./agent.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-09-03T10:00:00.000Z";
const hash = "c".repeat(64);

describe("ReportAgent", () => {
  it("stores a markdown report with a proven advance and never calls telegram", async () => {
    const tools: McpToolName[] = [];
    const agent = new ReportAgent({
      caller: recordingCaller(tools),
      clock: () => new Date(now),
    });

    const result = await agent.run(
      runInput({
        input: {
          terms: CommercialTerms.parse({
            advancePercent: { value: 30, factIds: [FactId.parse(uuid(3))], confidence: 0.92 },
          }),
        },
      }),
    );
    const payload = ReportOutput.parse(result.payload);

    expect(result.status).toBe("success");
    expect(payload.markdown).toContain("Аванс: 30%.");
    expect(payload.markdown).not.toMatch(/Итоговая оценка:\s*\d/);
    expect(payload.storageKey).toBe(`blobs/${hash}`);
    expect(result.nextRecommendedCapability).toBe("notification");
    expect(tools).toEqual(["files.put"]);
    expect(tools).not.toContain("telegram.send");
    expect(tools).not.toContain("memory.get");
  });

  it("still returns the report when files.put is not allowed", async () => {
    const tools: McpToolName[] = [];
    const agent = new ReportAgent({
      caller: recordingCaller(tools),
      clock: () => new Date(now),
    });

    const result = await agent.run(runInput({ allowedTools: ["memory.get"] }));
    const payload = ReportOutput.parse(result.payload);

    expect(result.status).toBe("success");
    expect(payload.storageKey).toBeUndefined();
    expect(payload.markdown).toContain("Коммерческие условия ещё не извлечены.");
    expect(tools).toEqual([]);
  });
});

function recordingCaller(tools: McpToolName[]): McpToolCaller {
  return {
    async callTool(toolName) {
      tools.push(toolName);
      if (toolName === "files.put") {
        return {
          structuredContent: {
            hash,
            storageKey: `blobs/${hash}`,
            sizeBytes: 128,
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
    requestId: RequestId.parse("req-report"),
    capability: "report",
    context: {
      event: {
        kind: "plan_step",
        description: "Собрать отчёт по выбранной закупке",
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
        stage: "commercial_analysed",
        createdAt: now,
        updatedAt: now,
      }),
      allowedTools: options?.allowedTools ?? ["memory.get", "files.put"],
      estimatedTokens: 400,
    },
    input: options?.input ?? {},
  });
}
