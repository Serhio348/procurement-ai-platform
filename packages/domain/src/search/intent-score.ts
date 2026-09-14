import type { SearchIntentPlan } from "@procurement/contracts";
import { inferSearchIntentPlan } from "./intent-plan.js";
import { firstTermIndex, termOccurs } from "./query-terms.js";

/**
 * Listing score weights. Keep every number here; do not sprinkle magic
 * values through the matcher. Existing object/action/veto weights are not
 * retuned for a dataset. CONTEXT_* are new axes from STAGE-51.
 *
 * CONTEXT_MATCH_WEIGHT 15 — same scale as an extra-text object mention:
 * purpose found is a positive signal, not a second full object.
 * CONTEXT_MISMATCH_PENALTY 50 — enough to sink a typical object+implicit
 * 60 below MIN_MATCH; the decision is discard regardless.
 */
export const SEARCH_INTENT_WEIGHTS = {
  OBJECT_MATCH_WEIGHT: 40,
  OBJECT_MENTION_WEIGHT: 15,
  DESIRED_ACTION_WEIGHT: 35,
  COMBO_BONUS: 15,
  IMPLICIT_PURCHASE_WEIGHT: 20,
  EXCLUDED_ACTION_PENALTY: 80,
  EXCLUDED_MENTION_PENALTY: 10,
  CONTEXT_MATCH_WEIGHT: 15,
  CONTEXT_MISMATCH_PENALTY: 50,
  MIN_MATCH_SCORE: 55,
} as const;

export type IntentMatchRole = "subject" | "mention" | "none";
export type IntentContextRole = "match" | "mismatch" | "missing" | "none";
export type IntentScoreDecision = "match" | "review" | "veto" | "discard";

export interface SearchIntentHitText {
  title: string;
  extraText?: string;
}

export interface SearchIntentScore {
  score: number;
  decision: IntentScoreDecision;
  reason: string;
  matchedObjects: readonly string[];
  matchedDesired: readonly string[];
  matchedContext: readonly string[];
  excludedActions: readonly string[];
  excludedRole: IntentMatchRole;
  contextRole: IntentContextRole;
}

const WORK_LEAD =
  /^(выполнение\s+работ\s+по|работы\s+по|услуги\s+по|оказание\s+услуг\s+по|текущий\s+ремонт|капитальный\s+ремонт)/iu;

const SIDE_MENTION =
  /с\s+последующ|силами\s+заказчика|включая\s+|в\s+том\s+числе/iu;

/**
 * Code-owned 0–100 score. The model must not call this and must not invent
 * a parallel number.
 */
export function scoreSearchIntent(
  hit: SearchIntentHitText,
  plan: SearchIntentPlan,
): SearchIntentScore {
  const title = hit.title;
  const extra = hit.extraText ?? "";
  const matchedObjects = plan.objects.filter((item) => termOccurs(title, item));
  const extraObjects =
    matchedObjects.length === 0 ? plan.objects.filter((item) => termOccurs(extra, item)) : [];
  const objectRole: IntentMatchRole =
    matchedObjects.length > 0 ? "subject" : extraObjects.length > 0 ? "mention" : "none";
  const objects = objectRole === "mention" ? extraObjects : matchedObjects;

  const matchedDesired = plan.desired_actions.filter((item) => termOccurs(title, item));
  const excludedInTitle = plan.excluded_actions.filter((item) => termOccurs(title, item));
  const excludedRole = excludedActionRole(title, plan, matchedDesired);
  const context = contextRoleFor(title, extra, plan);
  const matchedContext = context.matched;

  let score = 0;
  if (objectRole === "subject") score += SEARCH_INTENT_WEIGHTS.OBJECT_MATCH_WEIGHT;
  else if (objectRole === "mention") score += SEARCH_INTENT_WEIGHTS.OBJECT_MENTION_WEIGHT;
  if (matchedDesired.length > 0) score += SEARCH_INTENT_WEIGHTS.DESIRED_ACTION_WEIGHT;
  if (objectRole === "subject" && matchedDesired.length > 0 && excludedRole !== "subject") {
    score += SEARCH_INTENT_WEIGHTS.COMBO_BONUS;
  }
  if (
    objectRole === "subject" &&
    matchedDesired.length === 0 &&
    excludedRole !== "subject" &&
    plan.intent !== "works"
  ) {
    score += SEARCH_INTENT_WEIGHTS.IMPLICIT_PURCHASE_WEIGHT;
  }
  if (
    objectRole === "none" &&
    matchedDesired.length > 0 &&
    excludedRole !== "subject" &&
    plan.objects.length === 0
  ) {
    score += SEARCH_INTENT_WEIGHTS.IMPLICIT_PURCHASE_WEIGHT;
  }
  if (context.role === "match") score += SEARCH_INTENT_WEIGHTS.CONTEXT_MATCH_WEIGHT;
  else if (context.role === "mismatch") score -= SEARCH_INTENT_WEIGHTS.CONTEXT_MISMATCH_PENALTY;
  if (excludedRole === "subject") score -= SEARCH_INTENT_WEIGHTS.EXCLUDED_ACTION_PENALTY;
  else if (excludedRole === "mention") score -= SEARCH_INTENT_WEIGHTS.EXCLUDED_MENTION_PENALTY;

  score = clampScore(score);
  const decision = decisionFor(score, excludedRole, objectRole, context.role, matchedDesired.length, plan);
  return {
    score,
    decision,
    reason: relevanceReason({
      objects,
      desired: matchedDesired,
      excluded: excludedInTitle,
      excludedRole,
      objectRole,
      contextRole: context.role,
      matchedContext,
      decision,
    }),
    matchedObjects: objects,
    matchedDesired,
    matchedContext,
    excludedActions: excludedInTitle,
    excludedRole,
    contextRole: context.role,
  };
}

export function scoreSearchIntentFromProfile(
  hit: SearchIntentHitText,
  profile: { name: string; keywords: readonly string[]; excludeKeywords: readonly string[] },
): SearchIntentScore {
  return scoreSearchIntent(hit, inferSearchIntentPlan(profile));
}

function contextRoleFor(
  title: string,
  extra: string,
  plan: SearchIntentPlan,
): { role: IntentContextRole; matched: string[] } {
  const required = plan.required_context ?? [];
  const excluded = plan.excluded_context ?? [];
  const inTitle = required.filter((item) => termOccurs(title, item));
  const inExtra =
    inTitle.length === 0 ? required.filter((item) => termOccurs(extra, item)) : [];
  const matched = inTitle.length > 0 ? inTitle : inExtra;
  if (matched.length > 0) return { role: "match", matched };
  const hay = `${title} ${extra}`;
  if (excluded.some((item) => termOccurs(hay, item))) {
    return { role: "mismatch", matched: [] };
  }
  if (required.length === 0) return { role: "none", matched: [] };
  return { role: "missing", matched: [] };
}

function excludedActionRole(
  title: string,
  plan: SearchIntentPlan,
  matchedDesired: readonly string[],
): IntentMatchRole {
  const found = plan.excluded_actions.filter((item) => termOccurs(title, item));
  if (found.length === 0) return "none";
  if (SIDE_MENTION.test(title)) return "mention";
  const desiredIndex = earliestIndex(title, matchedDesired);
  const excludedIndex = earliestIndex(title, found);
  if (desiredIndex !== -1 && excludedIndex > desiredIndex) return "mention";
  const lead = leadingClause(title);
  const inLead = found.some((item) => termOccurs(lead, item));
  if (!inLead) return "mention";
  if (found.some((item) => startsWithTerm(lead, item)) || WORK_LEAD.test(lead.trim())) {
    return "subject";
  }
  return "subject";
}

function leadingClause(title: string): string {
  const cut = title.search(/[,;(]|с\s+последующ/iu);
  return cut === -1 ? title : title.slice(0, cut);
}

function startsWithTerm(text: string, term: string): boolean {
  return firstTermIndex(text, term) === 0;
}

function earliestIndex(text: string, terms: readonly string[]): number {
  let best = -1;
  for (const term of terms) {
    const index = firstTermIndex(text, term);
    if (index === -1) continue;
    if (best === -1 || index < best) best = index;
  }
  return best;
}

function decisionFor(
  score: number,
  excludedRole: IntentMatchRole,
  objectRole: IntentMatchRole,
  contextRole: IntentContextRole,
  desiredCount: number,
  plan: SearchIntentPlan,
): IntentScoreDecision {
  if (excludedRole === "subject") return "veto";
  if (contextRole === "mismatch") return "discard";
  if (objectRole === "none") {
    if (plan.objects.length > 0) return "discard";
    if (desiredCount > 0) return "review";
    return "discard";
  }
  if (contextRole === "missing") return "review";
  if (score >= SEARCH_INTENT_WEIGHTS.MIN_MATCH_SCORE) return "match";
  return "review";
}

function clampScore(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function relevanceReason(input: {
  objects: readonly string[];
  desired: readonly string[];
  excluded: readonly string[];
  excludedRole: IntentMatchRole;
  objectRole: IntentMatchRole;
  contextRole: IntentContextRole;
  matchedContext: readonly string[];
  decision: IntentScoreDecision;
}): string {
  const equipment =
    input.objects.length > 0 ? input.objects.join(", ") : undefined;
  if (input.decision === "veto" && equipment !== undefined) {
    const work = input.excluded[0] ?? "работы";
    return `Оборудование ${equipment} найдено, но предмет закупки — ${workLabel(work)}.`;
  }
  if (input.contextRole === "mismatch" && equipment !== undefined) {
    return `Оборудование ${equipment} найдено, но назначение не совпадает с профилем.`;
  }
  if (input.objectRole === "none") {
    return "Целевое оборудование в названии не найдено.";
  }
  if (input.objectRole === "mention" && equipment !== undefined) {
    return `Слово «${equipment}» есть только в дополнительном тексте, этого недостаточно.`;
  }
  if (input.contextRole === "missing" && equipment !== undefined) {
    return `Оборудование ${equipment} найдено, назначение в названии не указано — нужна проверка.`;
  }
  const parts: string[] = [];
  if (equipment !== undefined) parts.push(`Совпадает оборудование: ${equipment}.`);
  if (input.matchedContext.length > 0) {
    parts.push(`Назначение: ${input.matchedContext.join(", ")}.`);
  }
  if (input.desired.length > 0) {
    parts.push(`Тип закупки: ${input.desired.join(", ")}.`);
  } else if (input.decision === "match") {
    parts.push("Тип закупки по названию — поставка оборудования.");
  }
  if (input.excludedRole === "mention") {
    parts.push("Упоминается сопутствующая работа, но не как предмет закупки.");
  } else if (input.excluded.length === 0 && input.decision === "match") {
    parts.push("Признаков монтажных работ не обнаружено.");
  }
  if (parts.length === 0) return "По смыслу профиля закупка неясна — нужна проверка.";
  return parts.join(" ");
}

function workLabel(action: string): string {
  const lower = action.toLocaleLowerCase("ru-BY");
  if (lower.includes("монтаж")) return "монтажные работы";
  if (lower.includes("ремонт")) return "ремонт";
  if (lower.includes("обслуж")) return "обслуживание";
  if (lower.includes("проект")) return "проектирование";
  if (lower.includes("налад")) return "пусконаладочные работы";
  return action;
}
