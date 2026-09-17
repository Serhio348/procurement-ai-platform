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
const DEFAULT_EXCLUDED_FOR_WORKS = [
  "поставка",
  "изготовление",
  "ремонт",
  "демонтаж",
  "обслуживание",
];

const PURPOSE_FILLER = /^(управления|управление|привода|привод)$/iu;

/**
 * Roots that mark a token as the work itself inside a saved phrase
 * («электромонтажные» carries монтаж, «пусконаладочные» carries наладк).
 * Generic carriers («работы», «услуги», «выполнение») name no object either.
 */
const WORK_TOKEN_ROOTS = [
  "монтаж",
  "ремонт",
  "обслуживан",
  "проектирован",
  "наладк",
  "наладоч",
  "строительств",
];
const WORK_CARRIER = /^(работ|услуг|выполнен|оказан|производств|комплекс)/iu;
const SPLIT_FILLER = new Set(["и", "или", "с", "со", "по", "на", "в", "для", "к", "а", "также"]);

export interface IntentProfileSlice {
  name: string;
  keywords: readonly string[];
  excludeKeywords: readonly string[];
}

/**
 * Deterministic plan when the model is off or returned junk. Keywords that
 * name equipment become objects; a «для …» purpose becomes required_context.
 */

/**
 * Work phrases that name the type of work only — no industry object.
 * Used for works profiles: listing queries and desired_actions must not flood
 * the site (or the plan) with bare СМР / монтаж / пусконаладка alone.
 */
export function isGenericWorkPhrase(phrase: string): boolean {
  const normalized = phrase.toLocaleLowerCase("ru-BY").replace(/ё/gu, "е").trim();
  if (normalized.length === 0) return true;
  if (/^(смр|пнр)$/u.test(normalized)) return true;
  if (/строительно[-\s]?монтажн/u.test(normalized)) return true;
  if (/^строительн\p{L}*\s+работ/u.test(normalized)) return true;
  if (/пуско[-\s]?наладочн/u.test(normalized)) return true;
  if (/^пусконалад/u.test(normalized)) return true;
  if (/^(ген)?подряд/u.test(normalized) || /^субподряд/u.test(normalized)) return true;
  if (/подрядн\p{L}*\s+работ/u.test(normalized)) return true;
  if (/^монтажн\p{L}*\s+работ/u.test(normalized)) return true;
  if (/^(монтаж|работы|услуги|ремонт|реконструкция|строительство|модернизация)$/u.test(normalized)) {
    return true;
  }
  return false;
}

export function inferSearchIntentPlan(profile: IntentProfileSlice): SearchIntentPlanValue {
  const objects: string[] = [];
  const desired: string[] = [];
  const context: string[] = [];
  const lookingForWorks = profile.keywords.some((phrase) => splitWorkPhrase(phrase) !== undefined);
  for (const phrase of profile.keywords) {
    if (matchesAny(phrase, DESIRED_LEXICON)) {
      pushUnique(desired, phrase);
      continue;
    }
    const work = splitWorkPhrase(phrase);
    if (work !== undefined) {
      // «монтаж электрооборудования» names both the work and its object:
      // the phrase stays a desired action, the noun becomes an object so a
      // lot that says «работы по монтажу электрооборудования РП» can score.
      // Bare keywords («монтаж», «СМР») stay out of desired. A phrase that
      // already names the object stays as one desired action — do not also
      // push the bare verb; scoring treats work verbs in the title as an
      // implicit works signal when the profile object is present, so
      // specialists can keep keywords separate without gluing.
      if (!isGenericWorkPhrase(phrase)) {
        pushUnique(desired, phrase);
      }
      if (work.object !== undefined) pushUnique(objects, work.object);
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
  } else {
    for (const action of DEFAULT_EXCLUDED_FOR_WORKS) {
      if (desired.some((phrase) => matchesAny(phrase, [action]))) continue;
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

/**
 * True when the object noun without a desired verb is still "ours"
 * (typical supply). Works and design need the verb from the plan.
 */
export function planAllowsBareObject(plan: { intent: string }): boolean {
  return plan.intent !== "works" && plan.intent !== "design";
}

/**
 * Every saved phrase remains a platform query. When the plan allows a bare
 * object to count as a match, those objects may add extra site queries.
 */
export function platformSearchTerms(
  plan: SearchIntentPlanValue,
  fallbackKeywords: readonly string[],
): string[] {
  // Works: still query plan objects (the subject), but never bare СМР/монтаж.
  const extra =
    planAllowsBareObject(plan) || plan.intent === "works" ? plan.objects : [];
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const value of [...fallbackKeywords, ...extra]) {
    const term = value.trim();
    const key = term.toLocaleLowerCase("ru-BY");
    if (term.length === 0 || seen.has(key)) continue;
    if (plan.intent === "works" && isGenericWorkPhrase(term)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

/**
 * The model may widen the deterministic plan, never narrow it. Objects and
 * actions are unioned; the intent label follows the model only when the
 * cheap plan did not see work phrases (a model cannot turn a works profile
 * back into a purchase). Required/excluded context comes from the model
 * when it named any, because the cheap parser only reads «для …».
 */
export function mergeSearchIntentPlans(
  inferred: SearchIntentPlanValue,
  fromModel: SearchIntentPlanValue,
): SearchIntentPlanValue {
  const union = (left: readonly string[], right: readonly string[]): string[] => {
    const out: string[] = [];
    for (const item of [...left, ...right]) pushUnique(out, item);
    return out;
  };
  const intent = inferred.intent === "works" ? "works" : fromModel.intent;
  const excluded = union(inferred.excluded_actions, fromModel.excluded_actions).filter(
    // A works profile must not veto its own work verbs even if the model listed them.
    (item) => intent !== "works" || !inferred.desired_actions.some((d) => matchesAny(d, [item])),
  );
  return SearchIntentPlan.parse({
    objects: union(inferred.objects, fromModel.objects),
    required_context:
      fromModel.required_context.length > 0 ? fromModel.required_context : inferred.required_context,
    excluded_context: union(inferred.excluded_context, fromModel.excluded_context),
    desired_actions: union(inferred.desired_actions, fromModel.desired_actions).filter(
      (item) => intent !== "works" || !isGenericWorkPhrase(item),
    ),
    excluded_actions: excluded,
    intent,
  });
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

/**
 * Splits a work phrase into the action tokens and the remaining noun group.
 * Undefined when the phrase names no work at all. «пусконаладочные работы»
 * → actions only; «монтаж электросилового оборудования» → action «монтаж»,
 * object «электросилового оборудования».
 */
export function splitWorkPhrase(
  phrase: string,
): { actions: string[]; object?: string } | undefined {
  const tokens = phrase
    .normalize("NFKC")
    .split(/\s+/u)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((token) => token.length > 0);
  const actions: string[] = [];
  const rest: string[] = [];
  for (const token of tokens) {
    const lower = normaliseToken(token);
    if (SPLIT_FILLER.has(lower)) continue;
    if (isWorkToken(lower)) {
      pushUnique(actions, token);
      continue;
    }
    if (WORK_CARRIER.test(lower)) continue;
    rest.push(token);
  }
  if (actions.length === 0 && !matchesAny(phrase, WORK_LEXICON)) return undefined;
  const object = rest.join(" ");
  return object.length >= 4 ? { actions, object } : { actions };
}

function isWorkToken(lower: string): boolean {
  if (lower === "смр" || lower === "пнр") return true;
  if (WORK_TOKEN_ROOTS.some((root) => lower.includes(root))) return true;
  return matchesAny(lower, WORK_LEXICON);
}

function normaliseToken(token: string): string {
  return token.toLocaleLowerCase("ru-BY").replace(/ё/gu, "е").replace(/[-‐‑‒–—]/gu, "");
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
