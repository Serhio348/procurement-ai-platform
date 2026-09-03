import {
  AgentRunId,
  AgentRunInput,
  DomainSearchOutput,
  RequestId,
  SearchHit,
  electricalEquipmentSeedV1,
  type MinimalAgentContext,
} from "@procurement/contracts";
import type { McpToolCaller } from "@procurement/mcp-client";
import { describe, expect, it } from "vitest";
import { FakeSearchClassifier } from "../../testing/fake-search-classifier.js";
import { DomainSearchAgent } from "./agent.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-09-03T06:00:00.000Z";

describe("DomainSearchAgent", () => {
  it("keeps an obvious keyword hit without calling the model or sending exclude terms to the platform", async () => {
    const model = new FakeSearchClassifier();
    const tools: string[] = [];
    const agent = new DomainSearchAgent({
      model,
      caller: recordingCaller(tools, [
        hit("auction/1", "Поставка комплектной трансформаторной подстанции КТПБ"),
      ]),
    });

    const result = await agent.run(runInput());

    expect(result.status).toBe("success");
    const payload = DomainSearchOutput.parse(result.payload);
    expect(payload.query.keywords).toContain("КТПБ");
    expect(payload.candidates).toEqual([
      expect.objectContaining({
        verdict: "relevant",
        classifiedBy: "keywords",
        needDeeper: true,
      }),
    ]);
    expect(model.calls).toHaveLength(0);
    expect(tools).toEqual(["procurement.search"]);
    expect(result.nextRecommendedCapability).toBe("document_ingest");
  });

  it("discards excluded titles in code even if a profile keyword is also present", async () => {
    const model = new FakeSearchClassifier();
    const agent = new DomainSearchAgent({
      model,
      caller: recordingCaller([], [hit("auction/2", "Бытовой щиток КТПБ для дачи")]),
    });

    const result = await agent.run(runInput());
    const payload = DomainSearchOutput.parse(result.payload);

    expect(result.status).toBe("success");
    expect(payload.candidates[0]?.verdict).toBe("irrelevant");
    expect(payload.candidates[0]?.classifiedBy).toBe("exclude");
    expect(payload.discardedCount).toBe(1);
    expect(model.calls).toHaveLength(0);
  });

  it("asks the model only for ambiguous titles and never calls telegram", async () => {
    const model = new FakeSearchClassifier(() => ({
      verdict: "relevant",
      confidence: 0.82,
      reason: "Распределительное устройство относится к промышленному щитовому оборудованию.",
      needDeeper: true,
      matchedTerms: ["щитовое оборудование"],
    }));
    const tools: string[] = [];
    const agent = new DomainSearchAgent({
      model,
      caller: recordingCaller(tools, [
        hit("auction/3", "Поставка распределительного устройства 10 кВ"),
      ]),
    });

    const result = await agent.run(
      runInput({
        allowedTools: [
          "procurement.search",
          "procurement.get",
          "procurement.get_lots",
          "telegram.send",
        ],
      }),
    );

    expect(result.status).toBe("success");
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.hit.title).toContain("распределительного");
    expect(tools).toEqual(["procurement.search", "procurement.get"]);
    expect(tools).not.toContain("telegram.send");
    expect(DomainSearchOutput.parse(result.payload).candidates[0]?.classifiedBy).toBe("model");
  });

  it("does not search when procurement.search is missing from the compiled allowlist", async () => {
    const tools: string[] = [];
    const agent = new DomainSearchAgent({
      model: new FakeSearchClassifier(),
      caller: recordingCaller(tools, [hit("auction/1", "КТПБ")]),
    });

    const result = await agent.run(runInput({ allowedTools: ["procurement.get"] }));

    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("permission_denied");
    expect(tools).toEqual([]);
  });

  it("escalates leftover ambiguous hits when the model quota is exhausted", async () => {
    const model = new FakeSearchClassifier();
    const agent = new DomainSearchAgent({
      model,
      maxModelClassifications: 0,
      caller: recordingCaller([], [
        hit("auction/4", "Поставка распределительного устройства 10 кВ"),
      ]),
    });

    const result = await agent.run(runInput());
    const payload = DomainSearchOutput.parse(result.payload);

    expect(result.status).toBe("needs_human");
    expect(payload.candidates[0]?.classifiedBy).toBe("quota");
    expect(model.calls).toHaveLength(0);
  });
});

function recordingCaller(tools: string[], hits: SearchHit[]): McpToolCaller {
  return {
    async callTool(toolName, argumentsValue) {
      tools.push(toolName);
      if (toolName === "procurement.search") {
        const query = argumentsValue as { excludeKeywords?: string[] };
        expect(query.excludeKeywords ?? []).toEqual([]);
        return { structuredContent: { hits } };
      }
      if (toolName === "procurement.get") {
        return {
          structuredContent: {
            sourceId: "goszakupki_by",
            sourceProcurementId: argumentsValue["sourceProcurementId"],
            url: "https://goszakupki.by/auction/view/3",
            title: "Поставка распределительного устройства 10 кВ",
            fetchedAt: now,
          },
        };
      }
      throw new Error(`unexpected tool ${toolName}`);
    },
  };
}

function hit(sourceProcurementId: string, title: string): SearchHit {
  return SearchHit.parse({
    sourceId: "goszakupki_by",
    sourceProcurementId,
    url: `https://goszakupki.by/${sourceProcurementId}`,
    title,
  });
}

function runInput(options?: { allowedTools?: MinimalAgentContext["allowedTools"] }) {
  return AgentRunInput.parse({
    runId: AgentRunId.parse(uuid(1)),
    requestId: RequestId.parse("req-search"),
    capability: "domain_search",
    context: {
      event: {
        kind: "plan_step",
        description: "Найти закупки по профилю электрооборудования",
        occurredAt: now,
      },
      domainProfile: {
        slug: electricalEquipmentSeedV1.slug,
        name: electricalEquipmentSeedV1.name,
        purpose: electricalEquipmentSeedV1.purpose,
        instructions: electricalEquipmentSeedV1.instructions,
        keywords: electricalEquipmentSeedV1.keywords,
        excludeKeywords: ["бытов"],
        semanticConcepts: electricalEquipmentSeedV1.semanticConcepts,
        positiveCriteria: electricalEquipmentSeedV1.positiveCriteria,
        negativeCriteria: electricalEquipmentSeedV1.negativeCriteria,
        constraints: [],
      },
      allowedTools: options?.allowedTools ?? [
        "procurement.search",
        "procurement.get",
        "procurement.get_lots",
      ],
      estimatedTokens: 400,
    },
    input: { sourceId: "goszakupki_by" },
  });
}
