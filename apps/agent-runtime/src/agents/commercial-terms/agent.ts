import {
  AgentRunInput,
  AgentRunOutput,
  CommercialClaim,
  CommercialExtractionInput,
  CommercialExtractionOutput,
  CommercialExtractorInput,
  CommercialExtractorOutput,
  DocumentId,
  DocumentVersionId,
  Evidence,
  EvidenceId,
  Fact,
  FactId,
  type AgentDefinition,
  type AgentRunInput as AgentRunInputValue,
  type AgentRunOutput as AgentRunOutputValue,
  type CapabilityId,
  type CompiledDocumentRef,
  type CommercialClaim as CommercialClaimValue,
  type CommercialExtractorPage,
  type Evidence as EvidenceValue,
  type Fact as FactValue,
  type ProcurementId,
} from "@procurement/contracts";
import {
  assembleCommercialTerms,
  cheapExtractCommercialClaims,
  keepQuotedClaims,
  pageKey,
} from "@procurement/domain";
import {
  DocumentsMcpClient,
  McpToolCallError,
  ToolPolicyDeniedError,
  ToolPolicyGate,
  type McpToolCaller,
} from "@procurement/mcp-client";
import { silentLogger, type Logger } from "@procurement/observability";
import { capabilityRegistry } from "../../registry/capabilities.js";
import type { CommercialExtractorPort } from "./model-port.js";

const commercialSearchQueries = [
  "аванс",
  "оплата",
  "платеж",
  "гарантия",
  "обеспечение",
  "срок поставки",
  "неустойка",
] as const;

export interface CommercialTermsIdFactory {
  evidenceId: () => EvidenceId;
  factId: () => FactId;
  documentId: () => DocumentId;
  documentVersionId: () => DocumentVersionId;
}

export interface CommercialTermsAgentOptions {
  caller: McpToolCaller;
  model: CommercialExtractorPort;
  registry?: Readonly<Record<CapabilityId, AgentDefinition>>;
  logger?: Logger;
  clock?: () => Date;
  ids?: CommercialTermsIdFactory;
}

export class CommercialTermsAgent {
  readonly #caller: McpToolCaller;
  readonly #model: CommercialExtractorPort;
  readonly #registry: Readonly<Record<CapabilityId, AgentDefinition>>;
  readonly #logger: Logger;
  readonly #clock: () => Date;
  readonly #ids: CommercialTermsIdFactory;

  constructor(options: CommercialTermsAgentOptions) {
    this.#caller = options.caller;
    this.#model = options.model;
    this.#registry = options.registry ?? capabilityRegistry;
    this.#logger = options.logger ?? silentLogger;
    this.#clock = options.clock ?? (() => new Date());
    this.#ids = options.ids ?? randomIds();
  }

  async run(rawInput: unknown): Promise<AgentRunOutputValue> {
    const input = AgentRunInput.parse(rawInput);
    const logger = this.#logger.child({
      requestId: input.requestId,
      runId: input.runId,
      agentId: "commercial_terms",
      component: "commercial-terms-agent",
    });
    if (input.capability !== "commercial_terms") {
      throw new Error(`CommercialTermsAgent cannot run capability ${input.capability}`);
    }
    const agent = this.#registry.commercial_terms;
    const procurementId = input.context.procurement?.id ?? input.procurementId;
    if (procurementId === undefined) {
      return escalateRun(input, "Для извлечения условий нужна выбранная закупка.");
    }

    const payload = CommercialExtractionInput.parse(input.input ?? {});
    const documents =
      payload.documents.length > 0 ? payload.documents : (input.context.documents ?? []);
    const readable = documents.filter((item) => item.status === "extracted");
    const skippedDocumentCount = documents.length - readable.length;
    if (readable.length === 0) {
      return escalateRun(
        input,
        "Нет документов с надёжно извлечённым текстом. Проверьте коммерческие условия по оригиналу.",
      );
    }

    const gate = new ToolPolicyGate({ agentAllowedTools: input.context.allowedTools });
    const documentsClient = new DocumentsMcpClient({
      caller: this.#caller,
      policyGate: gate,
      timeoutMs: agent.timeoutMs,
      logger,
    });

    let pages: CommercialExtractorPage[];
    try {
      pages = await collectPages(documentsClient, readable, input.requestId);
    } catch (error) {
      logger.error("Commercial terms document search failed", error);
      return failedRun(input, error);
    }

    const pageText = new Map(pages.map((page) => [pageKey(page.hash, page.page), page.text]));
    let claims = keepQuotedClaims(
      pages.flatMap((page) => cheapExtractCommercialClaims(page)),
      pageText,
    );

    if (claims.length === 0 && pages.length > 0) {
      try {
        const raw = await this.#model.extract(CommercialExtractorInput.parse({ pages }));
        claims = keepQuotedClaims(CommercialExtractorOutput.parse(raw).claims, pageText);
      } catch (error) {
        logger.error("Commercial terms model call failed", error);
        return failedRun(input, error);
      }
    }

    const extractedAt = this.#clock().toISOString();
    const { facts, evidence } = toFacts(claims, pages, procurementId, extractedAt, this.#ids);
    const assembled = assembleCommercialTerms(facts);
    const output = CommercialExtractionOutput.parse({
      terms: assembled.terms,
      skippedDocumentCount,
      extractedAt,
    });

    const lowConfidence =
      facts.length > 0 && Math.min(...facts.map((fact) => fact.confidence)) < agent.minConfidence;
    const needsHuman = facts.length === 0 || assembled.conflicts.length > 0 || lowConfidence;
    const humanQuestion = needsHuman
      ? assembled.conflicts[0]?.question ??
        "Не удалось подтвердить коммерческие условия цитатой со страницы документа."
      : undefined;

    logger.info("Commercial terms extraction completed", {
      factCount: facts.length,
      conflictCount: assembled.conflicts.length,
      skippedDocumentCount,
    });
    return AgentRunOutput.parse({
      runId: input.runId,
      status: needsHuman ? "needs_human" : "success",
      confidence: facts.length === 0 ? 0 : Math.min(...facts.map((fact) => fact.confidence)),
      payload: output,
      facts,
      evidence,
      ...(humanQuestion === undefined ? {} : { humanQuestion }),
    });
  }
}

async function collectPages(
  documents: DocumentsMcpClient,
  refs: readonly CompiledDocumentRef[],
  requestId: AgentRunInputValue["requestId"],
): Promise<CommercialExtractorPage[]> {
  const pages = new Map<string, CommercialExtractorPage>();
  for (const ref of refs) {
    for (const query of commercialSearchQueries) {
      const search = await documents.search({ hash: ref.hash, query }, requestId);
      for (const hit of search.hits) {
        const key = pageKey(ref.hash, hit.page);
        if (pages.has(key)) continue;
        const page = await documents.getPage({ hash: ref.hash, page: hit.page }, requestId);
        pages.set(key, {
          hash: ref.hash,
          name: ref.name,
          page: page.page,
          text: page.text,
        });
      }
    }
  }
  return [...pages.values()].sort(
    (left, right) => left.hash.localeCompare(right.hash) || left.page - right.page,
  );
}

function toFacts(
  claims: readonly CommercialClaimValue[],
  pages: readonly CommercialExtractorPage[],
  procurementId: ProcurementId,
  extractedAt: string,
  ids: CommercialTermsIdFactory,
): { facts: FactValue[]; evidence: EvidenceValue[] } {
  const names = new Map(pages.map((page) => [page.hash, page.name]));
  const documentIds = new Map<string, { documentId: DocumentId; documentVersionId: DocumentVersionId }>();
  const facts: FactValue[] = [];
  const evidence: EvidenceValue[] = [];
  for (const claim of claims) {
    const parsed = CommercialClaim.parse(claim);
    let doc = documentIds.get(parsed.hash);
    if (doc === undefined) {
      doc = { documentId: ids.documentId(), documentVersionId: ids.documentVersionId() };
      documentIds.set(parsed.hash, doc);
    }
    const evidenceId = ids.evidenceId();
    evidence.push(
      Evidence.parse({
        id: evidenceId,
        location: {
          kind: "document",
          documentId: doc.documentId,
          documentVersionId: doc.documentVersionId,
          documentName: names.get(parsed.hash) ?? parsed.hash,
          page: parsed.page,
        },
        quote: parsed.quote,
        capturedAt: extractedAt,
      }),
    );
    facts.push(
      Fact.parse({
        id: ids.factId(),
        procurementId,
        key: parsed.key,
        value: parsed.value,
        ...(parsed.unit === undefined ? {} : { unit: parsed.unit }),
        evidenceIds: [evidenceId],
        confidence: parsed.confidence,
        extractedBy: "commercial_terms",
        extractedAt,
      }),
    );
  }
  return { facts, evidence };
}

function randomIds(): CommercialTermsIdFactory {
  return {
    evidenceId: () => EvidenceId.parse(crypto.randomUUID()),
    factId: () => FactId.parse(crypto.randomUUID()),
    documentId: () => DocumentId.parse(crypto.randomUUID()),
    documentVersionId: () => DocumentVersionId.parse(crypto.randomUUID()),
  };
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
