import {
  AgentRunInput,
  AgentRunOutput,
  DomainSearchCandidate,
  DomainSearchInput,
  DomainSearchOutput,
  SearchClassifierInput,
  SearchQuery,
  type AgentDefinition,
  type AgentRunInput as AgentRunInputValue,
  type AgentRunOutput as AgentRunOutputValue,
  type CapabilityId,
  type DomainSearchCandidate as DomainSearchCandidateValue,
  type McpToolName,
  type ProcedureCard,
  type SearchClassifierInput as SearchClassifierInputValue,
  type SearchHit,
} from "@procurement/contracts";
import { cheapClassifyHit } from "@procurement/domain";
import {
  McpToolCallError,
  ProcurementMcpClient,
  ToolPolicyDeniedError,
  ToolPolicyGate,
  type McpToolCaller,
} from "@procurement/mcp-client";
import { silentLogger, type Logger } from "@procurement/observability";
import { capabilityRegistry } from "../../registry/capabilities.js";
import type { SearchClassifierPort } from "./model-port.js";

const ModelClassification = DomainSearchCandidate.pick({
  verdict: true,
  confidence: true,
  reason: true,
  needDeeper: true,
  matchedTerms: true,
});

const defaultModelLimit = 50;

export interface DomainSearchAgentOptions {
  caller: McpToolCaller;
  model: SearchClassifierPort;
  registry?: Readonly<Record<CapabilityId, AgentDefinition>>;
  logger?: Logger;
  maxModelClassifications?: number;
}

export class DomainSearchAgent {
  readonly #caller: McpToolCaller;
  readonly #model: SearchClassifierPort;
  readonly #registry: Readonly<Record<CapabilityId, AgentDefinition>>;
  readonly #logger: Logger;
  readonly #maxModelClassifications: number;

  constructor(options: DomainSearchAgentOptions) {
    this.#caller = options.caller;
    this.#model = options.model;
    this.#registry = options.registry ?? capabilityRegistry;
    this.#logger = options.logger ?? silentLogger;
    this.#maxModelClassifications = options.maxModelClassifications ?? defaultModelLimit;
    if (
      !Number.isInteger(this.#maxModelClassifications) ||
      this.#maxModelClassifications < 0
    ) {
      throw new Error("maxModelClassifications must be a non-negative integer");
    }
  }

  async run(rawInput: unknown): Promise<AgentRunOutputValue> {
    const input = AgentRunInput.parse(rawInput);
    const logger = this.#logger.child({
      requestId: input.requestId,
      runId: input.runId,
      agentId: "domain_search",
      component: "domain-search-agent",
    });
    if (input.capability !== "domain_search") {
      throw new Error(`DomainSearchAgent cannot run capability ${input.capability}`);
    }
    const agent = this.#registry.domain_search;
    const profile = input.context.domainProfile;
    if (profile === undefined) {
      return escalateRun(input, "Для поиска нужен скомпилированный профиль направления.");
    }
    if (profile.keywords.length === 0) {
      return escalateRun(input, "В профиле нет ключевых слов для поиска. Добавьте их в направление.");
    }

    const payload = DomainSearchInput.parse(input.input);
    const query = SearchQuery.parse({
      sourceId: payload.sourceId,
      keywords: [...profile.keywords],
      excludeKeywords: [],
      kinds: payload.kinds,
      limit: payload.limit,
      offset: payload.offset,
      ...(payload.publishedFrom === undefined ? {} : { publishedFrom: payload.publishedFrom }),
      ...(payload.publishedTo === undefined ? {} : { publishedTo: payload.publishedTo }),
    });

    const client = new ProcurementMcpClient({
      caller: this.#caller,
      policyGate: new ToolPolicyGate({ agentAllowedTools: input.context.allowedTools }),
      timeoutMs: agent.timeoutMs,
      logger,
    });

    let hits: SearchHit[];
    try {
      hits = (await client.search(query, input.requestId)).hits;
    } catch (error) {
      logger.error("Domain search MCP call failed", error);
      return failedRun(input, error);
    }

    const candidates: DomainSearchCandidateValue[] = [];
    let modelCalls = 0;
    for (const hit of hits) {
      const cheap = cheapClassifyHit(
        {
          title: hit.title,
          ...(hit.buyerName === undefined ? {} : { buyerName: hit.buyerName }),
          ...(hit.sourceStatus === undefined ? {} : { sourceStatus: hit.sourceStatus }),
        },
        profile,
      );
      if (cheap.verdict === "irrelevant") {
        candidates.push(
          candidateFromHit(hit, {
            verdict: "irrelevant",
            confidence: 1,
            reason: `Заголовок содержит исключённое слово «${cheap.excludedBy[0]}».`,
            needDeeper: false,
            matchedTerms: [],
            excludedBy: [...cheap.excludedBy],
            classifiedBy: "exclude",
          }),
        );
        continue;
      }
      if (cheap.verdict === "relevant") {
        candidates.push(
          candidateFromHit(hit, {
            verdict: "relevant",
            confidence: 0.9,
            reason: `Заголовок содержит ключевое слово «${cheap.matchedTerms[0]}».`,
            needDeeper: true,
            matchedTerms: [...cheap.matchedTerms],
            excludedBy: [],
            classifiedBy: "keywords",
          }),
        );
        continue;
      }
      if (modelCalls >= this.#maxModelClassifications) {
        candidates.push(
          candidateFromHit(hit, {
            verdict: "needs_human",
            confidence: 0,
            reason:
              "Неоднозначных процедур больше, чем лимит классификации. Уточните ключевые слова профиля.",
            needDeeper: true,
            matchedTerms: [],
            excludedBy: [],
            classifiedBy: "quota",
          }),
        );
        continue;
      }
      modelCalls += 1;
      candidates.push(
        await classifyWithModel({
          hit,
          profile,
          model: this.#model,
          client,
          requestId: input.requestId,
          allowedTools: input.context.allowedTools,
          minConfidence: agent.minConfidence,
          logger,
        }),
      );
    }

    const output = DomainSearchOutput.parse({
      query: {
        sourceId: query.sourceId,
        keywords: query.keywords,
        limit: query.limit,
        offset: query.offset,
      },
      candidates,
      relevantCount: candidates.filter((item) => item.verdict === "relevant").length,
      discardedCount: candidates.filter((item) => item.verdict === "irrelevant").length,
      modelClassifiedCount: candidates.filter((item) => item.classifiedBy === "model").length,
    });
    const needsHuman = candidates.some((item) => item.verdict === "needs_human");
    const confidences = candidates
      .filter((item) => item.verdict !== "irrelevant")
      .map((item) => item.confidence);
    logger.info("Domain search completed", {
      hitCount: hits.length,
      relevantCount: output.relevantCount,
      discardedCount: output.discardedCount,
      modelClassifiedCount: output.modelClassifiedCount,
    });
    return AgentRunOutput.parse({
      runId: input.runId,
      status: needsHuman ? "needs_human" : "success",
      confidence: confidences.length === 0 ? 1 : Math.min(...confidences),
      payload: output,
      ...(needsHuman
        ? {
            humanQuestion:
              "Часть найденных процедур требует проверки специалиста. Откройте неоднозначные карточки.",
          }
        : {}),
      ...(output.relevantCount > 0 ? { nextRecommendedCapability: "document_ingest" } : {}),
    });
  }
}

async function classifyWithModel(options: {
  hit: SearchHit;
  profile: NonNullable<AgentRunInputValue["context"]["domainProfile"]>;
  model: SearchClassifierPort;
  client: ProcurementMcpClient;
  requestId: AgentRunInputValue["requestId"];
  allowedTools: readonly McpToolName[];
  minConfidence: number;
  logger: Logger;
}): Promise<DomainSearchCandidateValue> {
  const classifierInput = SearchClassifierInput.parse({
    profile: {
      name: options.profile.name,
      purpose: options.profile.purpose,
      instructions: options.profile.instructions,
      keywords: options.profile.keywords,
      excludeKeywords: options.profile.excludeKeywords,
      semanticConcepts: options.profile.semanticConcepts,
      positiveCriteria: options.profile.positiveCriteria.map((item) => item.text),
      negativeCriteria: options.profile.negativeCriteria.map((item) => item.text),
    },
    hit: options.hit,
    ...(options.allowedTools.includes("procurement.get")
      ? { card: await optionalCard(options) }
      : {}),
  });

  try {
    const parsed = ModelClassification.safeParse(await options.model.classify(classifierInput));
    if (!parsed.success) {
      return candidateFromHit(options.hit, {
        verdict: "needs_human",
        confidence: 0,
        reason: "Модель вернула некорректную классификацию. Нужна проверка специалиста.",
        needDeeper: true,
        matchedTerms: [],
        excludedBy: [],
        classifiedBy: "model",
      });
    }
    const cheap = cheapClassifyHit(
      {
        title: options.hit.title,
        ...(options.hit.buyerName === undefined ? {} : { buyerName: options.hit.buyerName }),
      },
      options.profile,
    );
    if (cheap.verdict === "irrelevant") {
      return candidateFromHit(options.hit, {
        verdict: "irrelevant",
        confidence: 1,
        reason: `Заголовок содержит исключённое слово «${cheap.excludedBy[0]}».`,
        needDeeper: false,
        matchedTerms: [],
        excludedBy: [...cheap.excludedBy],
        classifiedBy: "exclude",
      });
    }
    const verdict =
      parsed.data.verdict === "relevant" && parsed.data.confidence < options.minConfidence
        ? "needs_human"
        : parsed.data.verdict;
    return candidateFromHit(options.hit, {
      verdict,
      confidence: parsed.data.confidence,
      reason:
        verdict === "needs_human" && parsed.data.verdict === "relevant"
          ? "Уверенность модели недостаточна, чтобы принять процедуру без специалиста."
          : parsed.data.reason,
      needDeeper: parsed.data.needDeeper,
      matchedTerms: parsed.data.matchedTerms,
      excludedBy: [],
      classifiedBy: "model",
    });
  } catch (error) {
    options.logger.error("Search classifier failed", error);
    return candidateFromHit(options.hit, {
      verdict: "needs_human",
      confidence: 0,
      reason: "Не удалось классифицировать процедуру автоматически. Нужна проверка специалиста.",
      needDeeper: true,
      matchedTerms: [],
      excludedBy: [],
      classifiedBy: "model",
    });
  }
}

async function optionalCard(options: {
  hit: SearchHit;
  client: ProcurementMcpClient;
  requestId: AgentRunInputValue["requestId"];
  logger: Logger;
}): Promise<SearchClassifierInputValue["card"] | undefined> {
  try {
    const card = await options.client.get(
      {
        sourceId: options.hit.sourceId,
        sourceProcurementId: options.hit.sourceProcurementId,
      },
      options.requestId,
    );
    return projectCard(card);
  } catch (error) {
    options.logger.warn("Domain search skipped card fetch for classifier", {
      sourceProcurementId: options.hit.sourceProcurementId,
      err: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function projectCard(card: ProcedureCard): NonNullable<SearchClassifierInputValue["card"]> {
  return {
    title: card.title,
    lotTitles: card.lots.map((lot) => lot.title).slice(0, 8),
    rawFields: Object.fromEntries(Object.entries(card.rawFields).slice(0, 12)),
  };
}

function candidateFromHit(
  hit: SearchHit,
  fields: Omit<
    DomainSearchCandidateValue,
    "sourceId" | "sourceProcurementId" | "url" | "title"
  >,
): DomainSearchCandidateValue {
  return DomainSearchCandidate.parse({
    sourceId: hit.sourceId,
    sourceProcurementId: hit.sourceProcurementId,
    url: hit.url,
    title: hit.title,
    ...fields,
  });
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
