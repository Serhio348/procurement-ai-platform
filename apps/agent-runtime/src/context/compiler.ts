import {
  ContextCompilation,
  ContextCompileRequest,
  MinimalAgentContext,
  type AgentDefinition,
  type CapabilityId,
  type ContextCompilation as ContextCompilationValue,
  type ContextCompileRequest as ContextCompileRequestValue,
  type ContextHistoryItem,
  type DomainProfile,
  type Intent,
  type MinimalAgentContext as MinimalAgentContextValue,
  type ScopedRule,
} from "@procurement/contracts";
import { authorityOf, resolveRuleSet } from "@procurement/domain";
import { ToolPolicyGate } from "@procurement/mcp-client";
import { silentLogger, type Logger } from "@procurement/observability";
import { capabilityRegistry } from "../registry/capabilities.js";

const defaultHistoryLimit = 8;

export interface ContextCompilerOptions {
  registry?: Readonly<Record<CapabilityId, AgentDefinition>>;
  logger?: Logger;
  maxHistoryItems?: number;
}

export class ContextCompiler {
  readonly #registry: Readonly<Record<CapabilityId, AgentDefinition>>;
  readonly #logger: Logger;
  readonly #maxHistoryItems: number;

  constructor(options: ContextCompilerOptions = {}) {
    this.#registry = options.registry ?? capabilityRegistry;
    this.#logger = options.logger ?? silentLogger;
    this.#maxHistoryItems = options.maxHistoryItems ?? defaultHistoryLimit;
    if (!Number.isInteger(this.#maxHistoryItems) || this.#maxHistoryItems < 0) {
      throw new Error("maxHistoryItems must be a non-negative integer");
    }
  }

  compile(rawRequest: ContextCompileRequestValue): ContextCompilationValue {
    const request = ContextCompileRequest.parse(rawRequest);
    const logger = this.#logger.child({
      requestId: request.requestId,
      component: "context-compiler",
      agentId: request.capability,
    });
    const agent = this.#registry[request.capability];
    if (agent === undefined) {
      throw new Error(`capability ${request.capability} is not registered`);
    }

    const ruleResolution = resolveRuleSet(request.scopedRules);
    if (ruleResolution.needsHuman) {
      logger.info("Context compiler stopped on equal-authority policy conflict", {
        conflictCount: ruleResolution.conflicts.length,
      });
      return escalate(ruleResolution.conflicts.map((conflict) => conflict.question).join("\n\n"));
    }

    const profileQuestion = resolveProfile(request, agent);
    if (typeof profileQuestion === "string") return escalate(profileQuestion);
    const procurementQuestion = resolveProcurement(request, agent);
    if (typeof procurementQuestion === "string") return escalate(procurementQuestion);
    const intentQuestion = resolveIntent(request, agent);
    if (typeof intentQuestion === "string") return escalate(intentQuestion);

    const profile = profileQuestion;
    const procurement = procurementQuestion;
    const intent = intentQuestion;
    const requirements = new Set(agent.contextRequirements);
    const allowedTools = new ToolPolicyGate({
      agentAllowedTools: agent.allowedTools,
      agentForbiddenTools: agent.forbiddenTools,
      systemForbiddenTools: request.systemForbiddenTools,
      ...(profile === undefined ? {} : { profileAllowedTools: profile.associatedMcpTools }),
    }).allowedTools();
    if (allowedTools.length === 0) {
      logger.warn("Context compiler produced an empty tool allowlist");
      return escalate(
        "Для агента не осталось разрешённых инструментов. Проверьте профиль и политику доступа.",
      );
    }

    const candidate: Omit<MinimalAgentContextValue, "estimatedTokens"> = {
      event: request.event,
      constraints: requirements.has("constraints")
        ? [...ruleResolution.effective.values()]
            .sort(compareConstraints)
            .map((rule) => ({ scope: rule.scope, statement: rule.statement }))
        : [],
      allowedTools,
      ...(requirements.has("intent") && intent !== undefined
        ? {
            intent: {
              type: intent.type,
              scope: intent.scope,
              statement: intent.statement,
            },
          }
        : {}),
      ...(requirements.has("domain_profile") && profile !== undefined
        ? { domainProfile: profileSlice(profile) }
        : {}),
      ...(requirements.has("procurement") && procurement !== undefined ? { procurement } : {}),
      relevantHistory: requirements.has("relevant_history")
        ? selectHistory(
            request.relevantHistory,
            request.procurementId,
            request.domainProfileId,
            this.#maxHistoryItems,
          )
        : [],
    };

    const fitted = fitToBudget(candidate, agent.maxContextTokens);
    if (fitted === undefined) {
      logger.warn("Active constraints exceeded the agent context budget", {
        maxContextTokens: agent.maxContextTokens,
      });
      return escalate(
        "Ограничения не помещаются в контекст агента. Сократите правила или разбейте задачу.",
      );
    }

    const context = MinimalAgentContext.parse({
      ...fitted,
      estimatedTokens: estimateTokens(fitted),
    });
    logger.info("Agent context compiled", {
      estimatedTokens: context.estimatedTokens,
      maxContextTokens: agent.maxContextTokens,
      historyCount: context.relevantHistory.length,
      constraintCount: context.constraints.length,
    });
    return ContextCompilation.parse({ status: "compiled", context });
  }
}

function escalate(humanQuestion: string): ContextCompilationValue {
  return ContextCompilation.parse({ status: "needs_human", humanQuestion });
}

function resolveProfile(
  request: ContextCompileRequestValue,
  agent: AgentDefinition,
): DomainProfile | undefined | string {
  const requiresProfile = agent.contextRequirements.includes("domain_profile");
  if (request.domainProfileId === undefined) {
    return requiresProfile
      ? "Укажите профиль направления для этой задачи."
      : undefined;
  }
  const profile = request.domainProfiles.find((item) => item.id === request.domainProfileId);
  if (profile === undefined || !profile.enabled || profile.archived) {
    return "Указанный профиль направления отсутствует или отключён. Выберите активный профиль.";
  }
  if (!profile.associatedCapabilities.includes(request.capability)) {
    return "Профиль не разрешает эту возможность. Выберите другое направление или уточните задачу.";
  }
  return profile;
}

function resolveProcurement(
  request: ContextCompileRequestValue,
  agent: AgentDefinition,
): ContextCompileRequestValue["procurement"] | string {
  const requiresProcurement = agent.contextRequirements.includes("procurement");
  if (request.procurementId === undefined) {
    return requiresProcurement
      ? "Указанная закупка отсутствует в контексте задачи. Выберите доступную закупку."
      : undefined;
  }
  if (request.procurement === undefined || request.procurement.id !== request.procurementId) {
    return "Указанная закупка отсутствует в контексте задачи. Выберите доступную закупку.";
  }
  return request.procurement;
}

function resolveIntent(
  request: ContextCompileRequestValue,
  agent: AgentDefinition,
): Intent | undefined | string {
  if (!agent.contextRequirements.includes("intent")) return undefined;
  const active = request.intents.filter((intent) => intent.active);
  const matching = active.filter((intent) => {
    if (
      request.domainProfileId !== undefined &&
      intent.domainProfileIds.length > 0 &&
      !intent.domainProfileIds.includes(request.domainProfileId)
    ) {
      return false;
    }
    if (
      request.procurementId !== undefined &&
      intent.procurementId !== undefined &&
      intent.procurementId !== request.procurementId
    ) {
      return false;
    }
    return true;
  });
  const profileId = request.domainProfileId;
  const explicit =
    profileId === undefined
      ? undefined
      : matching.find((intent) => intent.domainProfileIds.includes(profileId));
  const selected = explicit ?? matching[0];
  if (active.length > 0 && selected === undefined) {
    return "Не удалось сопоставить задачу с выбранным профилем или закупкой. Уточните направление.";
  }
  return selected;
}

function selectHistory(
  items: readonly ContextHistoryItem[],
  procurementId: ContextCompileRequestValue["procurementId"],
  domainProfileId: ContextCompileRequestValue["domainProfileId"],
  limit: number,
): Array<{ at: string; summary: string }> {
  return items
    .filter((item) => historyMatches(item, procurementId, domainProfileId))
    .sort((left, right) => right.at.localeCompare(left.at) || left.summary.localeCompare(right.summary))
    .slice(0, limit)
    .map((item) => ({ at: item.at, summary: item.summary }));
}

function historyMatches(
  item: ContextHistoryItem,
  procurementId: ContextCompileRequestValue["procurementId"],
  domainProfileId: ContextCompileRequestValue["domainProfileId"],
): boolean {
  if (item.procurementId === undefined && item.domainProfileId === undefined) return false;
  if (
    item.procurementId !== undefined &&
    (procurementId === undefined || item.procurementId !== procurementId)
  ) {
    return false;
  }
  if (
    item.domainProfileId !== undefined &&
    (domainProfileId === undefined || item.domainProfileId !== domainProfileId)
  ) {
    return false;
  }
  return true;
}

function profileSlice(
  profile: DomainProfile,
): NonNullable<MinimalAgentContextValue["domainProfile"]> {
  return {
    slug: profile.slug,
    name: profile.name,
    purpose: profile.purpose,
    instructions: profile.instructions,
    keywords: profile.keywords,
    excludeKeywords: profile.excludeKeywords,
    semanticConcepts: profile.semanticConcepts,
    positiveCriteria: profile.positiveCriteria,
    negativeCriteria: profile.negativeCriteria,
    constraints: profile.constraints,
  };
}

function compareConstraints(left: ScopedRule, right: ScopedRule): number {
  const byAuthority = authorityOf(left.scope) - authorityOf(right.scope);
  if (byAuthority !== 0) return byAuthority;
  return left.key.localeCompare(right.key) || left.id.localeCompare(right.id);
}

/**
 * Character/3 is a conservative stand-in for a provider tokenizer. The compiler
 * must not depend on a specific model vocabulary.
 */
function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 3));
}

function fitToBudget(
  candidate: Omit<MinimalAgentContextValue, "estimatedTokens">,
  budget: number,
): Omit<MinimalAgentContextValue, "estimatedTokens"> | undefined {
  const next = structuredClone(candidate);
  while (estimateTokens(next) > budget) {
    if (next.relevantHistory.length > 0) {
      next.relevantHistory = next.relevantHistory.slice(0, -1);
      continue;
    }
    if (trimProfileFluff(next)) continue;
    return undefined;
  }
  return next;
}

function trimProfileFluff(
  context: Omit<MinimalAgentContextValue, "estimatedTokens">,
): boolean {
  const profile = context.domainProfile;
  if (profile === undefined) return false;
  if (profile.instructions.length > 0) {
    context.domainProfile = { ...profile, instructions: "" };
    return true;
  }
  if (profile.semanticConcepts.length > 0) {
    context.domainProfile = { ...profile, semanticConcepts: [] };
    return true;
  }
  if (profile.positiveCriteria.length > 0) {
    context.domainProfile = { ...profile, positiveCriteria: [] };
    return true;
  }
  if (profile.negativeCriteria.length > 0) {
    context.domainProfile = { ...profile, negativeCriteria: [] };
    return true;
  }
  return false;
}
