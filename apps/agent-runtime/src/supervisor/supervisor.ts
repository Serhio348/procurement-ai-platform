import {
  SupervisorPlan,
  SupervisorRequest,
  type AgentDefinition,
  type CapabilityId,
  type DomainProfile,
  type SupervisorRequest as SupervisorRequestValue,
  type SupervisorPlan as SupervisorPlanValue,
} from "@procurement/contracts";
import { resolveRuleSet } from "@procurement/domain";
import {
  silentLogger,
  type Logger,
} from "@procurement/observability";
import { capabilityRegistry } from "../registry/capabilities.js";
import type {
  SupervisorModelInput,
  SupervisorModelPort,
} from "./model-port.js";

const profileRequiredCapabilities = new Set<CapabilityId>([
  "domain_search",
  "commercial_terms",
  "risk_analysis",
  "monitoring",
]);

export interface SupervisorPlannerOptions {
  model: SupervisorModelPort;
  registry?: Readonly<Record<CapabilityId, AgentDefinition>>;
  minConfidence?: number;
  logger?: Logger;
}

export class SupervisorPlanner {
  readonly #model: SupervisorModelPort;
  readonly #registry: Readonly<Record<CapabilityId, AgentDefinition>>;
  readonly #minConfidence: number;
  readonly #logger: Logger;

  constructor(options: SupervisorPlannerOptions) {
    this.#model = options.model;
    this.#registry = options.registry ?? capabilityRegistry;
    this.#minConfidence = options.minConfidence ?? 0.7;
    this.#logger = options.logger ?? silentLogger;
    if (
      !Number.isFinite(this.#minConfidence) ||
      this.#minConfidence < 0 ||
      this.#minConfidence > 1
    ) {
      throw new Error("minConfidence must be between 0 and 1");
    }
  }

  async plan(rawRequest: SupervisorRequestValue): Promise<SupervisorPlanValue> {
    const request = SupervisorRequest.parse(rawRequest);
    const logger = this.#logger.child({
      requestId: request.requestId,
      component: "supervisor",
    });
    const intentSummary = summariseIntents(request);
    const activeProfiles = request.domainProfiles.filter(
      (profile) => profile.enabled && !profile.archived,
    );
    const preflightQuestion = validateReferencedScope(request, activeProfiles);
    if (preflightQuestion !== undefined) {
      logger.warn("Supervisor input requires human clarification");
      return humanPlan(intentSummary, preflightQuestion);
    }

    const ruleResolution = resolveRuleSet(request.scopedRules);
    if (ruleResolution.needsHuman) {
      logger.info("Supervisor stopped on equal-authority policy conflict", {
        conflictCount: ruleResolution.conflicts.length,
      });
      return humanPlan(
        intentSummary,
        ruleResolution.conflicts.map((conflict) => conflict.question).join("\n\n"),
        1,
      );
    }

    let candidate: unknown;
    try {
      candidate = await this.#model.createPlan(
        toModelInput(request, activeProfiles, this.#registry, ruleResolution.effective),
      );
    } catch (error) {
      logger.error("Supervisor model call failed", error);
      return humanPlan(
        intentSummary,
        "Не удалось составить план автоматически. Повторить попытку или передать задачу специалисту?",
      );
    }

    const parsed = SupervisorPlan.safeParse(candidate);
    if (!parsed.success) {
      logger.warn("Supervisor model returned invalid output", {
        issueCount: parsed.error.issues.length,
      });
      return humanPlan(
        intentSummary,
        "Модель вернула некорректный план. Повторить попытку или уточнить задачу?",
      );
    }

    const guardErrors = validatePlan(parsed.data, request, activeProfiles, this.#registry);
    if (guardErrors.length > 0) {
      logger.warn("Supervisor plan failed deterministic validation", {
        validationErrors: guardErrors,
      });
      return humanPlan(
        intentSummary,
        "План не прошёл проверку разрешений и области задачи. Уточните направление или закупку.",
      );
    }
    if (!parsed.data.needsHuman && parsed.data.confidence < this.#minConfidence) {
      logger.info("Supervisor plan confidence is below threshold", {
        confidence: parsed.data.confidence,
        minConfidence: this.#minConfidence,
      });
      return humanPlan(
        parsed.data.intentSummary,
        "Уверенность в плане недостаточна. Уточните задачу перед запуском агентов.",
        parsed.data.confidence,
      );
    }
    if (!parsed.data.needsHuman && parsed.data.steps.length === 0) {
      logger.warn("Supervisor model returned an empty executable plan");
      return humanPlan(
        parsed.data.intentSummary,
        "Для задачи не удалось определить ни одного действия. Уточните ожидаемый результат.",
        parsed.data.confidence,
      );
    }

    logger.info("Supervisor plan accepted", {
      stepCount: parsed.data.steps.length,
      selectedProfileCount: parsed.data.selectedDomainProfileIds.length,
      needsHuman: parsed.data.needsHuman,
    });
    return parsed.data;
  }
}

function toModelInput(
  request: SupervisorRequestValue,
  profiles: DomainProfile[],
  registry: Readonly<Record<CapabilityId, AgentDefinition>>,
  effectiveRules: ReadonlyMap<string, SupervisorRequestValue["scopedRules"][number]>,
): SupervisorModelInput {
  return {
    requestId: request.requestId,
    intents: request.intents.map((intent) => ({
      id: intent.id,
      type: intent.type,
      scope: intent.scope,
      statement: intent.statement,
      domainProfileIds: intent.domainProfileIds,
      ...(intent.procurementId === undefined ? {} : { procurementId: intent.procurementId }),
    })),
    domainProfiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      purpose: profile.purpose,
      associatedCapabilities: profile.associatedCapabilities,
      priority: profile.priority,
    })),
    effectiveRules: [...effectiveRules.values()].map((rule) => ({
      key: rule.key,
      value: rule.value,
      statement: rule.statement,
      scope: rule.scope,
    })),
    ...(request.procurement === undefined
      ? {}
      : {
          procurement: {
            id: request.procurement.id,
            title: request.procurement.title,
            status: request.procurement.status,
            stage: request.procurement.stage,
          },
        }),
    availableCapabilities: Object.values(registry).map((definition) => ({
      capability: definition.capability,
      role: definition.role,
      responsibility: definition.responsibility,
    })),
  };
}

function validateReferencedScope(
  request: SupervisorRequestValue,
  activeProfiles: DomainProfile[],
): string | undefined {
  const profileIds = new Set(activeProfiles.map((profile) => profile.id));
  const missingProfile = request.intents
    .flatMap((intent) => intent.domainProfileIds)
    .find((id) => !profileIds.has(id));
  if (missingProfile !== undefined) {
    return "Указанный профиль направления отсутствует или отключён. Выберите активный профиль.";
  }

  const intentProcurementIds = request.intents
    .map((intent) => intent.procurementId)
    .filter((id) => id !== undefined);
  if (
    intentProcurementIds.some(
      (id) => request.procurement === undefined || id !== request.procurement.id,
    )
  ) {
    return "Указанная закупка отсутствует в контексте задачи. Выберите доступную закупку.";
  }
  return undefined;
}

function validatePlan(
  plan: SupervisorPlanValue,
  request: SupervisorRequestValue,
  activeProfiles: DomainProfile[],
  registry: Readonly<Record<CapabilityId, AgentDefinition>>,
): string[] {
  const errors: string[] = [];
  const profiles = new Map(activeProfiles.map((profile) => [profile.id, profile]));
  const selected = new Set(plan.selectedDomainProfileIds);
  if (selected.size !== plan.selectedDomainProfileIds.length) {
    errors.push("selectedDomainProfileIds contains duplicates");
  }
  for (const id of selected) {
    if (!profiles.has(id)) errors.push(`unknown or inactive domain profile ${id}`);
  }

  if (!plan.needsHuman) {
    for (const id of request.intents.flatMap((intent) => intent.domainProfileIds)) {
      if (!selected.has(id)) errors.push(`explicit intent profile ${id} was not selected`);
    }
  }

  for (const step of plan.steps) {
    if (registry[step.capability] === undefined) {
      errors.push(`capability ${step.capability} is not registered`);
    }
    if (
      profileRequiredCapabilities.has(step.capability) &&
      step.domainProfileId === undefined
    ) {
      errors.push(`capability ${step.capability} requires a domain profile`);
    }
    if (step.domainProfileId !== undefined) {
      const profile = profiles.get(step.domainProfileId);
      if (profile === undefined) {
        errors.push(`step references unknown or inactive profile ${step.domainProfileId}`);
      } else {
        if (!selected.has(step.domainProfileId)) {
          errors.push(`step profile ${step.domainProfileId} is not selected`);
        }
        if (!profile.associatedCapabilities.includes(step.capability)) {
          errors.push(
            `profile ${step.domainProfileId} does not allow ${step.capability}`,
          );
        }
      }
    }
    if (
      step.procurementId !== undefined &&
      (request.procurement === undefined || step.procurementId !== request.procurement.id)
    ) {
      errors.push(`step references procurement outside the request`);
    }
  }
  return errors;
}

function summariseIntents(request: SupervisorRequestValue): string {
  return request.intents.map((intent) => intent.statement).join(" ");
}

function humanPlan(
  intentSummary: string,
  humanQuestion: string,
  confidence = 0,
): SupervisorPlanValue {
  return SupervisorPlan.parse({
    intentSummary,
    selectedDomainProfileIds: [],
    steps: [],
    needsHuman: true,
    humanQuestion,
    confidence,
  });
}
