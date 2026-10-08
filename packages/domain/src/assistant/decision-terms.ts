import type {
  AssistantTermStat,
  DecisionMemoryEntry,
  SpecialistWorkingProfile,
} from "@procurement/contracts";
import { tokenizeStems, tokenizeWords, type TokenizedWord } from "../search/query-terms.js";

/**
 * The words of remembered decisions are counted per profile; nothing here
 * knows a procurement domain or keeps a list of "common procurement words".
 * A word is generic only because this cabinet's own decisions say so: it
 * also occurs in something the specialist took.
 */
export const REJECT_SIGNAL_THRESHOLDS = {
  /** Distinct rejects that must share the term. One reject can be chance. */
  minRejects: 5,
  /** Without a few taken cases nothing separates a reason from a common word. */
  minAccepts: 3,
} as const;

const EXAMPLE_LIMIT = 3;
const SEGMENT_BREAK = /[.,;:!?()[\]{}«»"“”„\n]+/u;

export interface DecisionTerm {
  key: string;
  surface: string;
}

/**
 * Words and adjacent word pairs of one decision. Pairs never cross a
 * preposition or punctuation, so «работ по ремонту» does not invent
 * «работ ремонт». Each term counts once per decision.
 */
export function decisionTerms(
  entry: Pick<DecisionMemoryEntry, "title" | "lotTitles">,
): DecisionTerm[] {
  const terms = new Map<string, string>();
  for (const text of [entry.title, ...entry.lotTitles]) {
    for (const segment of text.split(SEGMENT_BREAK)) {
      const words = tokenizeWords(segment);
      words.forEach((word, index) => {
        if (word.filler) return;
        if (isUnigramTerm(word) && !terms.has(word.stem)) terms.set(word.stem, word.surface);
        const next = words[index + 1];
        if (next === undefined || next.filler || !isPairTerm(word, next)) return;
        const key = `${word.stem} ${next.stem}`;
        if (!terms.has(key)) terms.set(key, `${word.surface} ${next.surface}`);
      });
    }
  }
  return [...terms].map(([key, surface]) => ({ key, surface }));
}

/**
 * Per-term reject / accept counts over the decisions of one profile.
 * Terms the profile already searches for or excludes are not candidates:
 * the first are why the case was found, the second are already cut by code.
 */
export function profileTermTable(
  entries: readonly DecisionMemoryEntry[],
  profile: Pick<SpecialistWorkingProfile, "id" | "keywords" | "excludeKeywords">,
): { rejectCount: number; acceptCount: number; terms: AssistantTermStat[] } {
  const own = entries
    .filter((entry) => entry.profileIds.includes(profile.id))
    .sort((left, right) => Date.parse(right.decidedAt) - Date.parse(left.decidedAt));
  const keywordStems = new Set(profile.keywords.flatMap((keyword) => tokenizeStems(keyword)));
  const excluded = profile.excludeKeywords
    .map((keyword) => tokenizeStems(keyword))
    .filter((stems) => stems.length > 0);
  const counts = new Map<
    string,
    { rejects: number; accepts: number; surfaces: Map<string, number>; examples: string[] }
  >();
  let rejectCount = 0;
  let acceptCount = 0;
  for (const entry of own) {
    const rejected = entry.kind === "reject";
    if (rejected) rejectCount += 1;
    else acceptCount += 1;
    for (const term of decisionTerms(entry)) {
      const stems = term.key.split(" ");
      if (stems.every((stem) => keywordStems.has(stem))) continue;
      if (excluded.some((exclusion) => overlapsExclusion(stems, exclusion))) continue;
      const row = counts.get(term.key) ?? {
        rejects: 0,
        accepts: 0,
        surfaces: new Map<string, number>(),
        examples: [],
      };
      if (rejected) {
        row.rejects += 1;
        if (row.examples.length < EXAMPLE_LIMIT) row.examples.push(entry.title);
      } else {
        row.accepts += 1;
      }
      row.surfaces.set(term.surface, (row.surfaces.get(term.surface) ?? 0) + 1);
      counts.set(term.key, row);
    }
  }
  const terms = [...counts]
    .map(([key, row]) => ({
      key,
      label: mostFrequent(row.surfaces),
      rejectCount: row.rejects,
      acceptCount: row.accepts,
      rejectExamples: row.examples,
    }))
    .sort(
      (left, right) =>
        right.rejectCount - left.rejectCount ||
        left.acceptCount - right.acceptCount ||
        left.key.localeCompare(right.key),
    );
  return { rejectCount, acceptCount, terms };
}

/**
 * Terms that repeat across rejects and never occur in a taken case. A word
 * pair wins over its single word when the pair explains the same rejects,
 * so the specialist sees «наружного освещения», not «освещения» and
 * «наружного» separately.
 */
export function rejectSignals(
  table: { rejectCount: number; acceptCount: number; terms: readonly AssistantTermStat[] },
  thresholds: typeof REJECT_SIGNAL_THRESHOLDS = REJECT_SIGNAL_THRESHOLDS,
): AssistantTermStat[] {
  if (table.acceptCount < thresholds.minAccepts) return [];
  const candidates = table.terms.filter(
    (term) => term.acceptCount === 0 && term.rejectCount >= thresholds.minRejects,
  );
  const pairs = candidates.filter((term) => term.key.includes(" "));
  return candidates.filter((term) => {
    if (term.key.includes(" ")) return true;
    return !pairs.some(
      (pair) => pair.key.split(" ").includes(term.key) && pair.rejectCount >= term.rejectCount,
    );
  });
}

/**
 * The one signal worth offering next. A term offered before — accepted or
 * dismissed — is not offered again, and neither is a narrower or wider form
 * of it: after «Отклонить» on «наружного освещения» the assistant must not
 * come back with «освещения».
 */
export function nextSuggestionTerm(
  signals: readonly AssistantTermStat[],
  offeredKeys: Iterable<string>,
): AssistantTermStat | undefined {
  const offered = [...offeredKeys].map((key) => key.split(" "));
  return signals.find((signal) => {
    const stems = signal.key.split(" ");
    return !offered.some((previous) => overlapsExclusion(stems, previous));
  });
}

function isUnigramTerm(word: TokenizedWord): boolean {
  return word.stem.length >= 3 && !/^\d+$/u.test(word.stem);
}

function isPairTerm(left: TokenizedWord, right: TokenizedWord): boolean {
  if (/^\d+$/u.test(left.stem) && /^\d+$/u.test(right.stem)) return false;
  return isUnigramTerm(left) || isUnigramTerm(right);
}

function overlapsExclusion(stems: readonly string[], exclusion: readonly string[]): boolean {
  return containsRun(stems, exclusion) || containsRun(exclusion, stems);
}

function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((stem, offset) => haystack[start + offset] === stem)) return true;
  }
  return false;
}

function mostFrequent(surfaces: ReadonlyMap<string, number>): string {
  let best = "";
  let bestCount = -1;
  for (const [surface, count] of surfaces) {
    if (count > bestCount) {
      best = surface;
      bestCount = count;
    }
  }
  return best;
}
