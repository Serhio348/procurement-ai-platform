import {
  AgentRunId,
  AgentRunInput,
  DocumentIngestOutput,
  ProcurementCaseHeader,
  RequestId,
  SourceDocument,
  electricalEquipmentSeedV1,
  type AgentRunInput as AgentRunInputValue,
  type McpToolName,
} from "@procurement/contracts";
import type { McpToolCaller } from "@procurement/mcp-client";
import { describe, expect, it } from "vitest";
import { DocumentAgent } from "./agent.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-09-03T06:00:00.000Z";
const hashDigital = "a".repeat(64);
const hashScan = "b".repeat(64);

describe("DocumentAgent", () => {
  it("extracts digital text and tables without calling OCR or telegram", async () => {
    const tools: McpToolName[] = [];
    const agent = new DocumentAgent({
      caller: recordingCaller(tools, [digitalSource()]),
      clock: () => new Date(now),
    });

    const result = await agent.run(runInput());
    const payload = DocumentIngestOutput.parse(result.payload);

    expect(result.status).toBe("success");
    expect(payload.documents[0]).toMatchObject({
      unchanged: false,
      status: "extracted",
      ocrApplied: false,
      tableCount: 1,
    });
    expect(payload.documents[0]?.textPreview).toContain("Аванс 30");
    expect(result.nextRecommendedCapability).toBe("commercial_terms");
    expect(tools).toEqual([
      "procurement.get_documents",
      "documents.download",
      "documents.extract_text",
      "documents.extract_tables",
    ]);
    expect(tools).not.toContain("telegram.send");
    expect(tools).not.toContain("files.delete");
  });

  it("skips extraction when the same bytes are downloaded again", async () => {
    const tools: McpToolName[] = [];
    const agent = new DocumentAgent({
      caller: recordingCaller(tools, [digitalSource()]),
      clock: () => new Date(now),
    });

    await agent.run(runInput());
    tools.length = 0;
    const second = await agent.run(runInput());
    const payload = DocumentIngestOutput.parse(second.payload);

    expect(payload.documents[0]?.unchanged).toBe(true);
    expect(payload.unchangedCount).toBe(1);
    expect(tools).toEqual(["procurement.get_documents", "documents.download"]);
  });

  it("asks a human instead of inventing text from a poorly read scan", async () => {
    const tools: McpToolName[] = [];
    const agent = new DocumentAgent({
      caller: recordingCaller(tools, [scanSource()]),
      clock: () => new Date(now),
    });

    const result = await agent.run(runInput());
    const payload = DocumentIngestOutput.parse(result.payload);

    expect(result.status).toBe("needs_human");
    expect(result.humanQuestion).toContain("скан");
    expect(payload.documents[0]?.status).toBe("ocr_low_confidence");
    expect(payload.documents[0]?.ocrApplied).toBe(true);
    expect(tools).toContain("documents.ocr");
    expect(result.nextRecommendedCapability).toBeUndefined();
  });

  it("does not list documents when procurement.get_documents is not allowed", async () => {
    const tools: McpToolName[] = [];
    const agent = new DocumentAgent({
      caller: recordingCaller(tools, [digitalSource()]),
    });

    const result = await agent.run(runInput({ allowedTools: ["documents.download"] }));

    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("permission_denied");
    expect(tools).toEqual([]);
  });
});

function recordingCaller(tools: McpToolName[], documents: ReturnType<typeof digitalSource>[]): McpToolCaller {
  return {
    async callTool(toolName, argumentsValue) {
      tools.push(toolName);
      if (toolName === "procurement.get_documents") {
        return { structuredContent: { documents } };
      }
      if (toolName === "documents.download") {
        const sourceUrl = String(argumentsValue["sourceUrl"]);
        const scan = sourceUrl.includes("scan");
        const hash = scan ? hashScan : hashDigital;
        return {
          structuredContent: {
            hash,
            storageKey: `blobs/${hash}`,
            sizeBytes: 32,
            contentType: scan ? "image/tiff" : "application/pdf",
          },
        };
      }
      if (toolName === "documents.extract_text") {
        const hash = String(argumentsValue["hash"]);
        if (hash === hashScan) {
          return {
            structuredContent: {
              hash,
              status: "ocr_required",
              text: "",
              pages: [],
              ocrApplied: false,
              confidence: 0,
            },
          };
        }
        return {
          structuredContent: {
            hash,
            status: "extracted",
            text: "Техническое задание. Аванс 30 процентов.",
            pages: [
              {
                page: 1,
                text: "Техническое задание. Аванс 30 процентов.",
                ocrApplied: false,
                confidence: 1,
              },
            ],
            ocrApplied: false,
            confidence: 1,
          },
        };
      }
      if (toolName === "documents.ocr") {
        return {
          structuredContent: {
            hash: hashScan,
            status: "ocr_low_confidence",
            text: "ав нс 45",
            pages: [{ page: 1, text: "ав нс 45", ocrApplied: true, confidence: 0.31 }],
            ocrApplied: true,
            confidence: 0.31,
          },
        };
      }
      if (toolName === "documents.extract_tables") {
        const hash = String(argumentsValue["hash"]);
        return {
          structuredContent: {
            hash,
            tables:
              hash === hashDigital ? [{ page: 1, rows: [["Аванс", "30%"]] }] : [],
          },
        };
      }
      throw new Error(`unexpected tool ${toolName}`);
    },
  };
}

function digitalSource() {
  return SourceDocument.parse({
    name: "Техническое задание.pdf",
    sourceUrl: "https://example.test/files/spec-001.pdf",
    mimeType: "application/pdf",
    discoveredAt: now,
  });
}

function scanSource() {
  return SourceDocument.parse({
    name: "Скан договора.tiff",
    sourceUrl: "https://example.test/files/scan-low.tiff",
    mimeType: "image/tiff",
    discoveredAt: now,
  });
}

function runInput(options?: { allowedTools?: AgentRunInputValue["context"]["allowedTools"] }) {
  return AgentRunInput.parse({
    runId: AgentRunId.parse(uuid(1)),
    requestId: RequestId.parse("req-docs"),
    capability: "document_ingest",
    context: {
      event: {
        kind: "plan_step",
        description: "Загрузить документы выбранной закупки",
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
      allowedTools: options?.allowedTools ?? [
        "procurement.get_documents",
        "documents.list",
        "documents.download",
        "documents.extract_text",
        "documents.extract_tables",
        "documents.ocr",
        "files.put",
        "files.get",
        "files.exists",
      ],
      estimatedTokens: 400,
    },
    input: {},
  });
}
