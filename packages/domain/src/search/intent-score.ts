import type { ProcedureCard, SearchIntentPlan } from "@procurement/contracts";
import { inferSearchIntentPlan, planAllowsBareObject } from "./intent-plan.js";
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
/**
 * Where an excluded work verb stands relative to the desired action.
 * "peer": both are equal members of one enumeration («монтаж КТП, поставка
 * и пусконаладка») — word order alone must not decide, so the case is left
 * open for the model instead of a veto.
 */
export type IntentExcludedRole = IntentMatchRole | "peer";
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
  excludedRole: IntentExcludedRole;
  objectRole: IntentMatchRole;
  contextRole: IntentContextRole;
  /** Supply and works listed as equals: the model must weigh which is the subject. */
  mixedActions?: { desired: readonly string[]; excluded: readonly string[] };
}

const SIDE_CLAUSE = /включая|в\s+том\s+числе|с\s+последующ/iu;
const CUSTOMER_WORKS = /силами\s+заказчика/iu;

const HEAD_FILLER = /^(по|на|для|к|ко|о|об|с|со|от|до|из|и|или|при)$/iu;

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
  const serviceHead =
    matchedDesired.length === 0 ? purchaseWorkHead(leadingClause(title)) : undefined;
  const excludedInTitle = [
    ...plan.excluded_actions.filter((item) => termOccurs(title, item)),
    ...(serviceHead === undefined ? [] : [serviceHead.trim()]),
  ];
  const excludedRole: IntentExcludedRole =
    serviceHead !== undefined ? "subject" : excludedActionRole(title, plan, matchedDesired);
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
    planAllowsBareObject(plan)
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
  else if (excludedRole === "mention" || excludedRole === "peer") {
    score -= SEARCH_INTENT_WEIGHTS.EXCLUDED_MENTION_PENALTY;
  }

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
    objectRole,
    contextRole: context.role,
    ...(excludedRole === "peer"
      ? { mixedActions: { desired: matchedDesired, excluded: excludedInTitle } }
      : {}),
  };
}

export function scoreSearchIntentFromProfile(
  hit: SearchIntentHitText,
  profile: { name: string; keywords: readonly string[]; excludeKeywords: readonly string[] },
): SearchIntentScore {
  return scoreSearchIntent(hit, inferSearchIntentPlan(profile));
}

/**
 * Title plus lot subject, description and positions. Passed as `title` so a
 * term in «Предмет закупки» is scored as the subject, not as weak extraText.
 */
export function procedureIntentText(card: ProcedureCard): string {
  const parts: string[] = [card.title];
  for (const lot of card.lots) {
    parts.push(lot.title);
    if (lot.description !== undefined && lot.description.length > 0) {
      parts.push(lot.description);
    }
    for (const position of lot.positions) parts.push(position.title);
  }
  return parts.join("\n");
}

export function scoreSearchIntentFromProcedure(
  card: ProcedureCard,
  plan: SearchIntentPlan,
): SearchIntentScore {
  return scoreIntentProcedure(card, plan);
}

export function lotIntentText(lot: ProcedureCard["lots"][number]): string {
  const parts: string[] = [lot.title];
  if (lot.description !== undefined && lot.description.length > 0) {
    parts.push(lot.description);
  }
  for (const position of lot.positions) parts.push(position.title);
  return parts.join(" ");
}

/**
 * Every lot scored against the plan, in stable order. The aggregated card
 * verdict uses this list; the classifier prompt uses it to quote the lots
 * that actually matched instead of the first N titles (R14).
 */
export function scoreIntentLots(
  card: ProcedureCard,
  plan: SearchIntentPlan,
): { lot: ProcedureCard["lots"][number]; scored: SearchIntentScore }[] {
  return [...card.lots]
    .sort((left, right) =>
      left.number.localeCompare(right.number, "ru", { numeric: true }) ||
      lotIntentText(left).localeCompare(lotIntentText(right), "ru"),
    )
    .map((lot) => {
      const scored = scoreSearchIntent({ title: lotIntentText(lot) }, plan);
      return { lot, scored: { ...scored, reason: `Лот ${lot.number}: ${scored.reason}` } };
    });
}

/**
 * One picker for every profile. Title and each lot are scored with the same
 * matcher; the strongest clause wins. A work-headed title is not an implicit
 * match just because the object is named somewhere. A lot that itself names
 * the desired action and the object can still match.
 */
function scoreIntentProcedure(
  card: ProcedureCard,
  plan: SearchIntentPlan,
): SearchIntentScore {
  const titleScore = scoreSearchIntent({ title: card.title }, plan);
  const lotScores = scoreIntentLots(card, plan).map((entry) => entry.scored);
  const priority: Record<IntentScoreDecision, number> = { match: 3, review: 2, veto: 1, discard: 0 };
  const clauses = [titleScore, ...lotScores].sort(
    (left, right) => priority[right.decision] - priority[left.decision] || right.score - left.score,
  );
  const explicit = clauses.filter(
    (item) =>
      item.matchedDesired.length > 0 &&
      item.objectRole !== "none" &&
      item.excludedRole !== "subject",
  );
  const matched = explicit.find((item) => item.decision === "match");
  if (matched !== undefined) return matched;
  const mixed = clauses.find((item) => item.excludedRole === "peer" && item.objectRole !== "none");
  if (mixed !== undefined) return mixed;
  const review = explicit.find((item) => item.decision === "review");
  if (review !== undefined) return review;
  const workWithObject = clauses.find(
    (item) => item.excludedRole === "subject" && item.objectRole !== "none",
  );
  if (workWithObject !== undefined) return workWithObject;
  const work = clauses.find((item) => item.excludedRole === "subject");
  if (work !== undefined) return work;
  const implicit = clauses.find(
    (item) => item.objectRole !== "none" && item.decision !== "discard",
  );
  if (implicit !== undefined) return implicit;
  return explicit[0] ?? titleScore;
}

function contextRoleFor(
  title: string,
  extra: string,
  plan: SearchIntentPlan,
): { role: IntentContextRole; matched: string[] } {
  const required = plan.required_context ?? [];
  const excluded = plan.excluded_context ?? [];
  // An exclusion is the stronger rule: even a required-context word loses to
  // an excluded purpose, so a model-added required term cannot whitelist it.
  const excludedMatched = excluded.filter((item) => termOccurs(`${title} ${extra}`, item));
  if (excludedMatched.length > 0) return { role: "mismatch", matched: excludedMatched };
  const inTitle = required.filter((item) => termOccurs(title, item));
  const inExtra =
    inTitle.length === 0 ? required.filter((item) => termOccurs(extra, item)) : [];
  const matched = inTitle.length > 0 ? inTitle : inExtra;
  if (matched.length > 0) return { role: "match", matched };
  if (required.length === 0) return { role: "none", matched: [] };
  return { role: "missing", matched: [] };
}

interface IntentClause {
  text: string;
  incidental: boolean;
  customerWorks: boolean;
}

/**
 * «Включая» / «в том числе» / «с последующим» scope what follows them, not
 * the verb that leads the title: in «Монтаж НКУ, включая поставку крепежа»
 * the incidental part is the fastener supply while монтаж stays the subject.
 * «Силами заказчика» instead downgrades the verb it trails in the same
 * sentence («Поставка НКУ, монтаж силами заказчика»).
 */
function splitIntentClauses(title: string): IntentClause[] {
  const clauses: IntentClause[] = [];
  for (const sentence of title.split(/[\n.;:]+/u)) {
    const marker = SIDE_CLAUSE.exec(sentence);
    if (marker === null) {
      clauses.push({
        text: sentence,
        incidental: false,
        customerWorks: CUSTOMER_WORKS.test(sentence),
      });
      continue;
    }
    const main = sentence.slice(0, marker.index);
    const side = sentence.slice(marker.index);
    clauses.push({ text: main, incidental: false, customerWorks: CUSTOMER_WORKS.test(main) });
    clauses.push({ text: side, incidental: true, customerWorks: CUSTOMER_WORKS.test(side) });
  }
  return clauses;
}

function excludedActionRole(
  title: string,
  plan: SearchIntentPlan,
  matchedDesired: readonly string[],
): IntentExcludedRole {
  const found = plan.excluded_actions.filter((item) => termOccurs(title, item));
  if (found.length === 0) return "none";
  const mainClauses = splitIntentClauses(title).filter((clause) => !clause.incidental);
  const inMain = found.filter((item) =>
    mainClauses.some((clause) => termOccurs(clause.text, item)),
  );
  const governed = inMain.filter((item) =>
    mainClauses.some((clause) => !clause.customerWorks && termOccurs(clause.text, item)),
  );
  if (governed.length === 0) return "mention";
  const mainText = mainClauses.map((clause) => clause.text).join("\n");
  const mainDesired = matchedDesired.filter((item) => termOccurs(mainText, item));
  const desiredIndex = earliestIndex(mainText, mainDesired);
  const excludedIndex = earliestIndex(mainText, governed);
  if (desiredIndex !== -1 && excludedIndex > desiredIndex) return "mention";
  const lead = leadingClause(mainText);
  const inLead = governed.some((item) => termOccurs(lead, item));
  if (!inLead) return "mention";
  if (desiredIndex !== -1 && enumeratesTogether(mainText, governed, mainDesired)) {
    return "peer";
  }
  return "subject";
}

/**
 * True when an excluded verb and a desired verb sit in one sentence joined
 * as list members («монтаж КТП, поставка и пусконаладка»). Sentence and
 * lot boundaries (newline, period, semicolon, colon) split the check so a
 * works lot does not borrow «поставка» from another lot.
 */
function enumeratesTogether(
  text: string,
  excluded: readonly string[],
  desired: readonly string[],
): boolean {
  for (const sentence of text.split(/[\n.;:]+/u)) {
    if (!/,|\sи\s|\+|\/|\sа\s+также\s/iu.test(sentence)) continue;
    const hasExcluded = excluded.some((item) => termOccurs(sentence, item));
    const hasDesired = desired.some((item) => termOccurs(sentence, item));
    if (hasExcluded && hasDesired) return true;
  }
  return false;
}

function leadingClause(title: string): string {
  const cut = title.search(/[\n,;(]|с\s+последующ/iu);
  return cut === -1 ? title : title.slice(0, cut);
}

/**
 * First content words of the title name the subject. For a purchase profile
 * «Реконструкция КТП» / «Выбор подрядчика … КТП» is works, not an implicit
 * supply of the equipment mentioned later or only in a lot line.
 */
function purchaseWorkHead(lead: string): string | undefined {
  const trimmed = lead.trim();
  if (trimmed.length === 0) return undefined;
  const prefix = trimmed.slice(0, 120);
  if (/выполнени[ея]\s+работ/iu.test(prefix)) return "работы";
  if (/оказани[ея]\s+услуг/iu.test(prefix)) return "услуги";
  if (/(?:капитальн|текущ)\p{L}*\s+ремонт/iu.test(prefix)) return "ремонт";
  if (/устройств\p{L}*\s+(?:сетей|дорог|фундамент|покрыт|систем)/iu.test(prefix)) {
    return "работы";
  }
  const tokens = trimmed.split(/[^\p{L}\p{N}-]+/u).filter((token) => token.length > 0);
  const content: string[] = [];
  for (const token of tokens) {
    if (HEAD_FILLER.test(token)) continue;
    content.push(token);
    if (content.length === 2) break;
  }
  for (const token of content) {
    const label = workHeadLabel(token);
    if (label !== undefined) return label;
  }
  return undefined;
}

function workHeadLabel(token: string): string | undefined {
  const lower = token.toLocaleLowerCase("ru-BY").replace(/ё/gu, "е");
  if (lower === "смр") return "СМР";
  if (lower === "пнр") return "пусконаладочные работы";
  if (/^услуг/u.test(lower)) return "услуги";
  if (/^работ/u.test(lower) && !/^разработ/u.test(lower)) return "работы";
  if (/^выполнени/u.test(lower)) return "работы";
  if (/^оказани/u.test(lower)) return "услуги";
  if (/^обслуживан/u.test(lower)) return "обслуживание";
  if (/^инжиниринг/u.test(lower)) return "услуги";
  if (/^эксплуатац/u.test(lower)) return "эксплуатация";
  if (/^реконструкц/u.test(lower)) return "реконструкция";
  if (/^строительств/u.test(lower) || /^строительно/u.test(lower)) return "строительство";
  if (/^прокладк/u.test(lower)) return "прокладка";
  if (/^подряд/u.test(lower) || /^субподряд/u.test(lower)) return "подрядные работы";
  if (/^демонтаж/u.test(lower)) return "демонтаж";
  if (/^электромонтаж/u.test(lower) || /^шефмонтаж/u.test(lower)) return "монтажные работы";
  if (/^модернизац/u.test(lower)) return "работы";
  return undefined;
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
  excludedRole: IntentExcludedRole,
  objectRole: IntentMatchRole,
  contextRole: IntentContextRole,
  desiredCount: number,
  plan: SearchIntentPlan,
): IntentScoreDecision {
  if (excludedRole === "subject") return "veto";
  if (contextRole === "mismatch") return "discard";
  if (excludedRole === "peer" && objectRole !== "none") return "review";
  if (objectRole === "none") {
    if (plan.objects.length > 0) return "discard";
    if (desiredCount > 0) return "review";
    return "discard";
  }
  if (!planAllowsBareObject(plan) && desiredCount === 0) {
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
  excludedRole: IntentExcludedRole;
  objectRole: IntentMatchRole;
  contextRole: IntentContextRole;
  matchedContext: readonly string[];
  decision: IntentScoreDecision;
}): string {
  const equipment =
    input.objects.length > 0 ? input.objects.join(", ") : undefined;
  if (input.excludedRole === "peer" && equipment !== undefined) {
    const work = input.excluded[0] ?? "работы";
    return `Смешанная закупка: ${input.desired.join(", ")} и ${workLabel(work)} перечислены как равные части предмета — нужна проверка по смыслу.`;
  }
  if (input.decision === "veto" && equipment !== undefined) {
    const work = input.excluded[0] ?? "работы";
    return `Оборудование ${equipment} найдено, но предмет закупки — ${workLabel(work)}.`;
  }
  if (input.contextRole === "mismatch" && equipment !== undefined) {
    const excluded =
      input.matchedContext.length > 0 ? `: ${input.matchedContext.join(", ")}` : "";
    return `Оборудование ${equipment} найдено, но назначение исключено профилем${excluded}.`;
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
  } else if (
    input.excluded.length === 0 &&
    input.decision === "match" &&
    !input.desired.some((item) => /монтаж|наладк|проект|строительств/iu.test(item))
  ) {
    parts.push("Признаков монтажных работ не обнаружено.");
  }
  if (parts.length === 0) return "По смыслу профиля закупка неясна — нужна проверка.";
  return parts.join(" ");
}

function workLabel(action: string): string {
  const lower = action.toLocaleLowerCase("ru-BY");
  if (lower.includes("услуг") || lower.includes("инжиниринг")) return "услуги";
  if (/^работ|выполнени/u.test(lower)) return "работы";
  if (lower.includes("эксплуатац")) return "эксплуатация";
  if (lower.includes("реконструкц")) return "реконструкция";
  if (lower.includes("строительств") || lower === "смр") return "строительство";
  if (lower.includes("проклад")) return "прокладка";
  if (lower.includes("подряд")) return "подрядные работы";
  if (lower.includes("демонтаж")) return "демонтаж";
  if (lower.includes("монтаж")) return "монтажные работы";
  if (lower.includes("ремонт")) return "ремонт";
  if (lower.includes("обслуж")) return "обслуживание";
  if (lower.includes("проект")) return "проектирование";
  if (lower.includes("налад")) return "пусконаладочные работы";
  return action;
}
