import {
  AgentRunId,
  AgentRunInput,
  CommercialExtractionOutput,
  DocumentId,
  DocumentVersionId,
  EvidenceId,
  FactId,
  ProcurementCaseHeader,
  RequestId,
  electricalEquipmentSeedV1,
  type AgentRunInput as AgentRunInputValue,
  type McpToolName,
} from "@procurement/contracts";
import type { McpToolCaller } from "@procurement/mcp-client";
import { describe, expect, it } from "vitest";
import { FakeCommercialExtractor } from "../../testing/fake-commercial-extractor.js";
import { CommercialTermsAgent, type CommercialTermsIdFactory } from "./agent.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-09-03T07:00:00.000Z";
const hashDigital = "a".repeat(64);
const hashScan = "b".repeat(64);
const digitalText = "Техническое задание. Аванс 30 процентов.";
const ambiguousText = "Порядок расчётов: оплата после поставки оборудования.";

describe("CommercialTermsAgent", () => {
  it("extracts an explicit advance percent without calling the model or telegram", async () => {
    const tools: McpToolName[] = [];
    const model = new FakeCommercialExtractor();
    const agent = new CommercialTermsAgent({
      caller: recordingCaller(tools, { [hashDigital]: digitalText }),
      model,
      clock: () => new Date(now),
      ids: sequentialIds(),
    });

    const result = await agent.run(runInput());
    const payload = CommercialExtractionOutput.parse(result.payload);

    expect(result.status).toBe("success");
    expect(payload.terms.advancePercent?.value).toBe(30);
    expect(result.facts[0]).toMatchObject({
      key: "commercial.advance_percent",
      value: 30,
    });
    expect(result.evidence[0]?.quote).toContain("Аванс 30");
    expect(result.facts[0]?.evidenceIds).toEqual([result.evidence[0]?.id]);
    expect(model.calls).toHaveLength(0);
    expect(tools).not.toContain("telegram.send");
    expect(tools).not.toContain("procurement.search");
    expect(tools).toContain("documents.search");
    expect(tools).toContain("documents.get_page");
  });

  it("drops a model quote that is not on the cited page", async () => {
    const tools: McpToolName[] = [];
    const model = new FakeCommercialExtractor(() => ({
      claims: [
        {
          key: "commercial.advance_percent",
          value: 90,
          confidence: 0.99,
          hash: hashDigital,
          page: 1,
          quote: "Аванс 90 процентов",
        },
      ],
    }));
    const agent = new CommercialTermsAgent({
      caller: recordingCaller(tools, { [hashDigital]: ambiguousText }),
      model,
      clock: () => new Date(now),
      ids: sequentialIds(),
    });

    const result = await agent.run(runInput());
    expect(result.status).toBe("needs_human");
    expect(result.facts).toEqual([]);
    expect(result.humanQuestion).toContain("цитатой");
    expect(model.calls).toHaveLength(1);
  });

  it("skips a poorly read scan instead of inventing payment terms", async () => {
    const tools: McpToolName[] = [];
    const model = new FakeCommercialExtractor();
    const agent = new CommercialTermsAgent({
      caller: recordingCaller(tools, { [hashScan]: "ав нс 45" }),
      model,
      clock: () => new Date(now),
      ids: sequentialIds(),
    });

    const result = await agent.run(
      runInput({
        documents: [{ hash: hashScan, name: "Скан.tiff", status: "ocr_low_confidence" }],
      }),
    );

    expect(result.status).toBe("needs_human");
    expect(result.humanQuestion).toContain("оригиналу");
    expect(tools).toEqual([]);
    expect(model.calls).toHaveLength(0);
  });

  it("does not search when documents.search is not allowed", async () => {
    const tools: McpToolName[] = [];
    const agent = new CommercialTermsAgent({
      caller: recordingCaller(tools, { [hashDigital]: digitalText }),
      model: new FakeCommercialExtractor(),
    });

    const result = await agent.run(runInput({ allowedTools: ["documents.get_page"] }));

    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("permission_denied");
    expect(tools).toEqual([]);
  });
});

function recordingCaller(
  tools: McpToolName[],
  pages: Record<string, string>,
): McpToolCaller {
  return {
    async callTool(toolName, argumentsValue) {
      tools.push(toolName);
      if (toolName === "documents.search") {
        const hash = String(argumentsValue["hash"]);
        const query = String(argumentsValue["query"]);
        const text = pages[hash] ?? "";
        const hit = text.toLocaleLowerCase("ru-BY").includes(query.toLocaleLowerCase("ru-BY"));
        return {
          structuredContent: {
            hash,
            hits: hit ? [{ page: 1, snippet: text.slice(0, 80) }] : [],
          },
        };
      }
      if (toolName === "documents.get_page") {
        const hash = String(argumentsValue["hash"]);
        return {
          structuredContent: {
            hash,
            page: 1,
            text: pages[hash] ?? "",
            ocrApplied: false,
            confidence: 1,
          },
        };
      }
      throw new Error(`unexpected tool ${toolName}`);
    },
  };
}

function sequentialIds(): CommercialTermsIdFactory {
  let n = 30;
  return {
    evidenceId: () => EvidenceId.parse(uuid(n++)),
    factId: () => FactId.parse(uuid(n++)),
    documentId: () => DocumentId.parse(uuid(n++)),
    documentVersionId: () => DocumentVersionId.parse(uuid(n++)),
  };
}

function runInput(options?: {
  allowedTools?: AgentRunInputValue["context"]["allowedTools"];
  documents?: AgentRunInputValue["context"]["documents"];
}) {
  return AgentRunInput.parse({
    runId: AgentRunId.parse(uuid(1)),
    requestId: RequestId.parse("req-commercial"),
    capability: "commercial_terms",
    context: {
      event: {
        kind: "plan_step",
        description: "Извлечь коммерческие условия выбранной закупки",
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
        createdAt: now,
        updatedAt: now,
      }),
      documents: options?.documents ?? [
        { hash: hashDigital, name: "Техническое задание.pdf", status: "extracted" },
      ],
      allowedTools: options?.allowedTools ?? [
        "documents.search",
        "documents.get_page",
        "memory.get",
      ],
      estimatedTokens: 400,
    },
    input: {},
  });
}
