import { z } from "zod";
import { termOccurs, tokenizeStems } from "../search/query-terms.js";

/**
 * One direction the model found inside a profile's rejected procurements:
 * a human name plus the phrases the purchases are actually called by in
 * listing titles. The name is shown to the specialist; the phrases are
 * what «Принять» writes into the profile's exclusions — but only after
 * code validates each of them.
 */
export interface AssistantDirection {
  name: string;
  phrases: string[];
}

/** What a phrase is matched against: the subject the specialist saw. */
export interface DirectionSubject {
  /** The remembered title, shown in the offer as an example. */
  title: string;
  /** Subject contexts joined; lot subjects are already merged in. */
  subject: string;
}

export interface ValidatedAssistantDirection {
  name: string;
  phrases: string[];
  /** Distinct rejected cases any surviving phrase covers. */
  rejectCount: number;
  /** Titles of the covered rejects, for the offer card. */
  examples: string[];
}

/** A direction must explain at least two different rejects to be one. */
const MIN_PHRASE_REJECTS = 2;
const PHRASE_LIMIT = 4;
const EXAMPLE_LIMIT = 3;
const DIRECTION_LIMIT = 3;

const ModelDirections = z.object({
  directions: z
    .array(
      z.object({
        name: z.string().max(200).catch(""),
        phrases: z.array(z.string().min(1).max(200)).catch([]),
      }),
    )
    .catch([]),
});

/**
 * Lenient parse of the model's answer: a broken direction drops out
 * instead of failing the whole analysis.
 */
export function parseAssistantDirections(raw: unknown): AssistantDirection[] {
  const envelope = ModelDirections.safeParse(
    typeof raw === "object" && raw !== null && "directions" in raw ? raw : { directions: [] },
  );
  if (!envelope.success) return [];
  return envelope.data.directions
    .map((direction) => ({
      name: direction.name.trim().slice(0, 200),
      phrases: dedupe(direction.phrases).slice(0, PHRASE_LIMIT),
    }))
    .filter((direction) => direction.name.length > 0 && direction.phrases.length > 0)
    .slice(0, DIRECTION_LIMIT);
}

/**
 * The model names directions; code decides what may become an exclusion.
 * A phrase survives only when it covers at least two different rejected
 * subjects, matches not a single taken one, is not already a search term
 * or exclusion of the profile, and was not already offered to the
 * specialist in a previous suggestion.
 */
export function validateAssistantDirections(input: {
  directions: readonly AssistantDirection[];
  rejected: readonly DirectionSubject[];
  accepted: readonly DirectionSubject[];
  keywords: readonly string[];
  excludeKeywords: readonly string[];
  offeredTermKeys: readonly string[];
}): ValidatedAssistantDirection[] {
  const keywordStems = new Set(input.keywords.flatMap((keyword) => tokenizeStems(keyword)));
  const exclusions = input.excludeKeywords
    .map((keyword) => tokenizeStems(keyword))
    .filter((stems) => stems.length > 0);
  const offered = input.offeredTermKeys.map((key) => key.split(" "));
  const acceptedSubjects = input.accepted.map((item) => item.subject);
  const validated: ValidatedAssistantDirection[] = [];
  for (const direction of input.directions) {
    const covered = new Set<number>();
    const phrases: string[] = [];
    for (const phrase of direction.phrases) {
      const stems = tokenizeStems(phrase);
      if (stems.length === 0) continue;
      if (stems.every((stem) => keywordStems.has(stem))) continue;
      if (exclusions.some((exclusion) => stemRunsOverlap(stems, exclusion))) continue;
      if (offered.some((previous) => stemRunsOverlap(stems, previous))) continue;
      if (acceptedSubjects.some((subject) => termOccurs(subject, phrase))) continue;
      const hits = input.rejected.flatMap((item, index) =>
        termOccurs(item.subject, phrase) ? [index] : [],
      );
      if (hits.length < MIN_PHRASE_REJECTS) continue;
      for (const index of hits) covered.add(index);
      phrases.push(phrase);
    }
    if (phrases.length === 0 || covered.size < MIN_PHRASE_REJECTS) continue;
    validated.push({
      name: direction.name,
      phrases,
      rejectCount: covered.size,
      examples: [...covered].slice(0, EXAMPLE_LIMIT).map((index) => input.rejected[index]!.title),
    });
  }
  return validated.sort((left, right) => right.rejectCount - left.rejectCount);
}

/** The stems of a direction phrase, stored like a term key for dedupe. */
export function directionTermKey(phrase: string): string {
  return tokenizeStems(phrase).join(" ");
}

function stemRunsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return containsRun(left, right) || containsRun(right, left);
}

function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((stem, offset) => haystack[start + offset] === stem)) return true;
  }
  return false;
}

function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    const key = item.toLowerCase();
    if (item.length === 0 || seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

export const ASSISTANT_DIRECTION_PROMPT = [
  "Ты помощник кабинета закупок. Специалист разбирает очередь одного профиля.",
  "На вход JSON: { profileName, keywords, excludeKeywords, rejected, accepted }.",
  "rejected — предметы закупок, которые специалист отклонил; accepted — которые взял.",
  "Сгруппируй rejected в направления: одна тема закупок, объединяющая минимум два разных предмета.",
  "Для каждого направления:",
  "name — короткое название направления по-русски (например «тепловые пункты», «пожарная сигнализация»).",
  "phrases — 1-4 фразы, которыми эти закупки реально названы в предметах: подстроки из rejected, не пересказ.",
  "Фраза обязана встречаться минимум в двух предметах rejected и ни в одном accepted.",
  "Не используй общие слова вместо направления («работы», «объект», «государственный», «текущий»).",
  "Не придумывай направление из одного предмета и не объединяй разные темы в одну.",
  "Верни только один JSON-объект без markdown:",
  '{ "directions": [ { "name": "", "phrases": [] } ] }.',
  "Если направлений нет — верни пустой массив directions.",
].join("\n");
