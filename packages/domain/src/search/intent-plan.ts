import { SearchIntentPlan, type SearchIntentPlan as SearchIntentPlanValue } from "@procurement/contracts";
import { stemWord, stemsShareRoot, termOccurs } from "./query-terms.js";

const DESIRED_LEXICON = ["поставка", "изготовление", "производство", "поставки"];
const WORK_LEXICON = [
  "монтаж",
  "ремонт",
  "обслуживание",
  "проектирование",
  "пусконаладка",
  "пуско-наладка",
  "демонтаж",
  "шефмонтаж",
  "строительство",
  "смр",
];
const DEFAULT_EXCLUDED_FOR_PURCHASE = [
  "монтаж",
  "ремонт",
  "обслуживание",
  "проектирование",
  "пусконаладка",
];

const PURPOSE_FILLER = /^(управления|управление|привода|привод)$/iu;

export interface IntentProfileSlice {
  name: string;
  keywords: readonly string[];
  excludeKeywords: readonly string[];
}

/**
 * Deterministic plan when the model is off or returned junk. Keywords that
 * name equipment become objects; a «для …» purpose becomes required_context.
 */
export function inferSearchIntentPlan(profile: IntentProfileSlice): SearchIntentPlanValue {
  const objects: string[] = [];
  const desired: string[] = [];
  const context: string[] = [];
  const lookingForWorks = profile.keywords.some((phrase) => matchesAny(phrase, WORK_LEXICON));
  for (const phrase of profile.keywords) {
    if (matchesAny(phrase, DESIRED_LEXICON)) {
      pushUnique(desired, phrase);
      continue;
    }
    if (matchesAny(phrase, WORK_LEXICON)) {
      pushUnique(desired, phrase);
      continue;
    }
    const split = splitPurposePhrase(phrase);
    if (split.object !== undefined) pushUnique(objects, split.object);
    for (const item of split.context) pushUnique(context, item);
  }
  for (const item of splitPurposePhrase(profile.name).context) pushUnique(context, item);
  if (!lookingForWorks && desired.length === 0 && objects.length > 0) {
    desired.push("поставка", "изготовление");
  }
  const excluded: string[] = [];
  for (const phrase of profile.excludeKeywords) pushUnique(excluded, phrase);
  if (!lookingForWorks) {
    for (const action of DEFAULT_EXCLUDED_FOR_PURCHASE) {
      if (profile.keywords.some((phrase) => matchesAny(phrase, [action]))) continue;
      pushUnique(excluded, action);
    }
  }
  return SearchIntentPlan.parse({
    objects,
    required_context: context,
    excluded_context: [],
    desired_actions: desired,
    excluded_actions: excluded,
    intent: lookingForWorks ? "works" : "equipment_purchase",
  });
}

/** Platform queries: objects when we have them, otherwise the saved keywords. */
export function platformSearchTerms(
  plan: SearchIntentPlanValue,
  fallbackKeywords: readonly string[],
): string[] {
  if (plan.objects.length > 0) return [...plan.objects];
  return [...fallbackKeywords];
}

/**
 * Phrases the model added that the cheap plan did not already send. Empty
 * when both plans name the same objects — the listing did not miss anything.
 */
export function extraPlatformSearchTerms(
  alreadyQueried: readonly string[],
  plan: SearchIntentPlanValue,
  fallbackKeywords: readonly string[],
): string[] {
  const have = new Set(alreadyQueried.map((item) => item.toLocaleLowerCase("ru-BY")));
  return platformSearchTerms(plan, fallbackKeywords).filter(
    (item) => !have.has(item.toLocaleLowerCase("ru-BY")),
  );
}

/**
 * Accepts camelCase aliases and silently drops any score the model tried to
 * add. Invalid JSON becomes undefined so the caller can fall back.
 */
export function parseSearchIntentPlan(raw: unknown): SearchIntentPlanValue | undefined {
  const coerced = coercePlan(raw);
  const parsed = SearchIntentPlan.safeParse(coerced);
  return parsed.success ? parsed.data : undefined;
}

function coercePlan(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const row = raw as Record<string, unknown>;
  return {
    objects: row["objects"] ?? row["equipment"],
    required_context: row["required_context"] ?? row["requiredContext"] ?? row["context"],
    excluded_context: row["excluded_context"] ?? row["excludedContext"],
    desired_actions: row["desired_actions"] ?? row["desiredActions"],
    excluded_actions: row["excluded_actions"] ?? row["excludedActions"],
    intent: row["intent"] ?? "equipment_purchase",
  };
}

/**
 * «изделие для назначения» → object and required_context terms from the purpose.
 */
export function splitPurposePhrase(phrase: string): { object?: string; context: string[] } {
  const trimmed = phrase.trim();
  if (trimmed.length === 0) return { context: [] };
  const match = /^(.+?)\s+для\s+(.+)$/iu.exec(trimmed);
  if (match === null) return { object: trimmed, context: [] };
  const object = match[1]?.trim();
  const purpose = match[2]?.trim() ?? "";
  return {
    ...(object === undefined || object.length === 0 ? {} : { object }),
    context: contextTermsFromPurpose(purpose),
  };
}

function contextTermsFromPurpose(purpose: string): string[] {
  const stripped = purpose.replace(/^управления\s+/iu, "").trim();
  const tokens = stripped.split(/\s+/u).filter((token) => !PURPOSE_FILLER.test(token));
  const terms: string[] = [];
  const head = tokens[0];
  if (head !== undefined) {
    const noun = stemWord(head);
    if (noun.length >= 4) {
      terms.push(noun);
    }
  }
  if (stripped.length > 0) pushUnique(terms, stripped);
  return terms;
}

function matchesAny(phrase: string, lexicon: readonly string[]): boolean {
  return lexicon.some((item) => termOccurs(phrase, item) || stemsShareRoot(stemWord(phrase), stemWord(item)));
}

function pushUnique(target: string[], phrase: string): void {
  const trimmed = phrase.trim();
  if (trimmed.length === 0) return;
  if (target.some((item) => item.toLocaleLowerCase("ru-BY") === trimmed.toLocaleLowerCase("ru-BY"))) {
    return;
  }
  target.push(trimmed);
}
