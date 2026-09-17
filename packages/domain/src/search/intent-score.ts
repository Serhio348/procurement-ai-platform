import type { ProcedureCard, SearchIntentPlan } from "@procurement/contracts";
import {
  inferSearchIntentPlan,
  isGenericWorkPhrase,
  planAllowsBareObject,
} from "./intent-plan.js";

export { isGenericWorkPhrase } from "./intent-plan.js";
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

const WORK_LEAD =
  /^(выполнение\s+работ\s+по|работы\s+по|услуги\s+по|оказание\s+услуг\s+по|текущий\s+ремонт|капитальный\s+ремонт)/iu;

const SIDE_MENTION =
  /с\s+последующ|силами\s+заказчика|включая\s+|в\s+том\s+числе/iu;

const HEAD_FILLER = /^(по|на|для|к|ко|о|об|с|со|от|до|из|и|или|при)$/iu;

/**
 * Code-owned 0–100 score. The model must not call this and must not invent
 * a parallel number.
 */

/** True when the text names a plan object or a required_context term. */
export function hasProfileSubjectSignal(text: string, plan: SearchIntentPlan): boolean {
  if (plan.objects.some((item) => termOccurs(text, item))) return true;
  const required = plan.required_context ?? [];
  return required.some((item) => termOccurs(text, item));
}

const WORKS_NO_SUBJECT_REASON =
  "В тексте нет объектов или назначения из профиля — совпали только общие слова работ, закупка отброшена.";

/**
 * Works profiles are domain-agnostic: the profile's objects/context define the
 * industry. Without those in the text, a bare SMR/ПНР hit is dropped (veto).
 * If a specific profile work phrase matched but the object is still missing,
 * the hit stays open for the model (review), never auto-match.
 */
function applyWorksSubjectGate(
  scored: SearchIntentScore,
  plan: SearchIntentPlan,
  text: string,
): SearchIntentScore {
  if (plan.intent !== "works") return scored;
  if (scored.decision === "veto") return scored;
  if (scored.objectRole !== "none") return scored;
  if (scored.contextRole === "match") return scored;
  if (hasProfileSubjectSignal(text, plan)) return scored;

  const desired = scored.matchedDesired;
  const onlyGeneric =
    desired.length === 0 || desired.every((item) => isGenericWorkPhrase(item));
  if (onlyGeneric) {
    return {
      ...scored,
      score: 0,
      decision: "veto",
      reason: WORKS_NO_SUBJECT_REASON,
    };
  }
  // Profile-specific work phrase without its object: let the model judge by profile.
  if (scored.decision === "match" || scored.decision === "discard") {
    return {
      ...scored,
      decision: "review",
      reason:
        "Есть специфичная фраза работ из профиля, но объект профиля в тексте не назван — нужна проверка модели.",
    };
  }
  return scored;
}

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
  const workHead =
    matchedDesired.length === 0 ? purchaseWorkHead(leadingClause(title)) : undefined;
  // Purchase profiles: a work-headed title is not supply. Works profiles: the
  // opposite — work in the title is the desired shape, never an exclusion.
  const serviceHead = plan.intent === "works" ? undefined : workHead;
  const excludedInTitle = [
    ...plan.excluded_actions.filter((item) => termOccurs(title, item)),
    ...(serviceHead === undefined ? [] : [serviceHead.trim()]),
  ];
  const excludedRole: IntentExcludedRole =
    serviceHead !== undefined ? "subject" : excludedActionRole(title, plan, matchedDesired);
  const context = contextRoleFor(title, extra, plan);
  const matchedContext = context.matched;

  // Soft A+C keeps keywords separate («электрооборудование», «монтаж») and
  // strips bare work verbs from desired. When the plan has no desired phrases
  // left, the object is present, and the title still names works, score that
  // as an implicit desired action — specialists must not glue chips into one
  // site query. If the plan still lists specific desired phrases that simply
  // did not match this title, do not invent a works match.
  const implicitWorks =
    plan.intent === "works" &&
    plan.desired_actions.length === 0 &&
    matchedDesired.length === 0 &&
    objectRole !== "none" &&
    excludedRole !== "subject" &&
    titleHasWorksSignal(title, workHead);
  const effectiveDesired = implicitWorks
    ? [implicitWorksDesiredLabel(title, workHead)]
    : matchedDesired;

  let score = 0;
  if (objectRole === "subject") score += SEARCH_INTENT_WEIGHTS.OBJECT_MATCH_WEIGHT;
  else if (objectRole === "mention") score += SEARCH_INTENT_WEIGHTS.OBJECT_MENTION_WEIGHT;
  if (effectiveDesired.length > 0) score += SEARCH_INTENT_WEIGHTS.DESIRED_ACTION_WEIGHT;
  if (objectRole === "subject" && effectiveDesired.length > 0 && excludedRole !== "subject") {
    score += SEARCH_INTENT_WEIGHTS.COMBO_BONUS;
  }
  if (
    objectRole === "subject" &&
    effectiveDesired.length === 0 &&
    excludedRole !== "subject" &&
    planAllowsBareObject(plan)
  ) {
    score += SEARCH_INTENT_WEIGHTS.IMPLICIT_PURCHASE_WEIGHT;
  }
  if (
    objectRole === "none" &&
    effectiveDesired.length > 0 &&
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
  const decision = decisionFor(
    score,
    excludedRole,
    objectRole,
    context.role,
    effectiveDesired.length,
    plan,
  );
  const scored: SearchIntentScore = {
    score,
    decision,
    reason: relevanceReason({
      objects,
      desired: effectiveDesired,
      excluded: excludedInTitle,
      excludedRole,
      objectRole,
      contextRole: context.role,
      matchedContext,
      decision,
    }),
    matchedObjects: objects,
    matchedDesired: effectiveDesired,
    matchedContext,
    excludedActions: excludedInTitle,
    excludedRole,
    objectRole,
    contextRole: context.role,
    ...(excludedRole === "peer"
      ? { mixedActions: { desired: effectiveDesired, excluded: excludedInTitle } }
      : {}),
  };

  // Works profile with a subject hit and a work signal in the title, but none
  // of the saved desired phrases matched (e.g. profile has «электромонтажные
  // работы» while the site says «строительно-монтажные … РЭС/КРУН»). Do not
  // discard: send to the model instead of requiring glued keywords.
  if (
    plan.intent === "works" &&
    objectRole !== "none" &&
    effectiveDesired.length === 0 &&
    plan.desired_actions.length > 0 &&
    excludedRole !== "subject" &&
    titleHasWorksSignal(title, workHead) &&
    (decision === "discard" || decision === "review")
  ) {
    const label = implicitWorksDesiredLabel(title, workHead);
    return applyWorksSubjectGate(
      {
        ...scored,
        decision: "review",
        matchedDesired: [label],
        reason:
          "Предмет профиля есть, в заголовке видны работы, но точная фраза из профиля не совпала — нужна проверка модели.",
      },
      plan,
      `${title}\n${extra}`,
    );
  }

  return applyWorksSubjectGate(scored, plan, `${title}\n${extra}`);
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
  return applyWorksSubjectGate(scoreIntentProcedure(card, plan), plan, procedureIntentText(card));
}

function lotIntentText(lot: ProcedureCard["lots"][number]): string {
  const parts: string[] = [lot.title];
  if (lot.description !== undefined && lot.description.length > 0) {
    parts.push(lot.description);
  }
  for (const position of lot.positions) parts.push(position.title);
  return parts.join(" ");
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
  const lotScores = card.lots.map((lot) => scoreSearchIntent({ title: lotIntentText(lot) }, plan));
  const clauses = [titleScore, ...lotScores];
  const mixed = clauses.find((item) => item.excludedRole === "peer" && item.objectRole !== "none");
  if (mixed !== undefined) return mixed;
  const explicit = clauses.find(
    (item) =>
      item.matchedDesired.length > 0 &&
      item.objectRole !== "none" &&
      item.excludedRole !== "subject",
  );
  if (explicit !== undefined) return explicit;
  const workWithObject = clauses.find(
    (item) => item.excludedRole === "subject" && item.objectRole !== "none",
  );
  if (workWithObject !== undefined) return workWithObject;
  const work = clauses.find((item) => item.excludedRole === "subject");
  if (work !== undefined) return work;
  const energyVeto = clauses.find((item) => item.decision === "veto");
  if (energyVeto !== undefined) return energyVeto;
  const implicit = clauses.find(
    (item) => item.objectRole !== "none" && item.decision !== "discard",
  );
  if (implicit !== undefined) return implicit;
  return titleScore;
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
): IntentExcludedRole {
  const found = plan.excluded_actions.filter((item) => termOccurs(title, item));
  if (found.length === 0) return "none";
  if (SIDE_MENTION.test(title)) return "mention";
  const desiredIndex = earliestIndex(title, matchedDesired);
  const excludedIndex = earliestIndex(title, found);
  if (desiredIndex !== -1 && excludedIndex > desiredIndex) return "mention";
  const lead = leadingClause(title);
  const inLead = found.some((item) => termOccurs(lead, item));
  if (!inLead) return "mention";
  if (desiredIndex !== -1 && enumeratesTogether(title, found, matchedDesired)) return "peer";
  if (
    found.some((item) => startsWithTerm(lead, item)) ||
    WORK_LEAD.test(lead.trim()) ||
    purchaseWorkHead(lead) !== undefined
  ) {
    return "subject";
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
 * True when the title names works even if desired_actions has no glued phrase.
 * Bare «монтаж» / СМР stay out of the plan; the title still carries the signal.
 */
function titleHasWorksSignal(title: string, workHead: string | undefined): boolean {
  if (workHead !== undefined) return true;
  if (termOccurs(title, "монтаж") || termOccurs(title, "пусконаладка")) return true;
  if (termOccurs(title, "смр") || termOccurs(title, "пнр")) return true;
  if (/строительно[-\s]?монтажн/iu.test(title)) return true;
  if (/пуско[-\s]?наладочн/iu.test(title)) return true;
  if (/электромонтажн/iu.test(title)) return true;
  return false;
}

function implicitWorksDesiredLabel(title: string, workHead: string | undefined): string {
  const fromHead = workHead?.trim() ?? "";
  if (fromHead.length > 0) return fromHead;
  if (termOccurs(title, "монтаж")) return "монтаж";
  if (termOccurs(title, "пусконаладка")) return "пусконаладка";
  if (termOccurs(title, "смр") || /строительно[-\s]?монтажн/iu.test(title)) return "СМР";
  return "работы";
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
  if (/^подряд/u.test(lower) || /^субподряд/u.test(lower) || /^генподряд/u.test(lower)) {
    return "подрядные работы";
  }
  if (/^демонтаж/u.test(lower)) return "демонтаж";
  if (/^электромонтаж/u.test(lower) || /^шефмонтаж/u.test(lower)) return "монтажные работы";
  if (/^модернизац/u.test(lower)) return "работы";
  return undefined;
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
