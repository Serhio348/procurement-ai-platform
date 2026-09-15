/**
 * Normalises specialist phrases and listing titles so inflected Russian and
 * hyphen variants count as the same term. Abbreviations stay exact.
 */
import { termMatchStrength } from "./term-match.js";

const TOKEN_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}\-/]*/gu;

const ENDINGS = [
  "иями",
  "ями",
  "ами",
  "иях",
  "ях",
  "ием",
  "иям",
  "ого",
  "ему",
  "ому",
  "его",
  "ыми",
  "ими",
  "ией",
  "иею",
  "ою",
  "ею",
  "ии",
  "ия",
  "ие",
  "ию",
  "ья",
  "ью",
  "ов",
  "ев",
  "ей",
  "ой",
  "ый",
  "ий",
  "ая",
  "яя",
  "ое",
  "ее",
  "ые",
  "ие",
  "ую",
  "юю",
  "ом",
  "ем",
  "ам",
  "ям",
  "ах",
  "ях",
  "ка",
  "ку",
  "ке",
  "ки",
  "ок",
  "а",
  "я",
  "у",
  "ю",
  "е",
  "и",
  "ы",
  "о",
  "ь",
];

const FILLER = new Set(["для", "по", "и", "с", "на", "в", "во", "от", "до", "из", "к", "ко", "о", "об"]);

/** Agent-noun tails that must not share a root with the verb/action. */
const AGENT_TAILS = ["льщик", "щик", "чиц", "чик", "ниц", "тель"];

/**
 * Verb/reflexive tails, longest first. Applied only when the remainder stays
 * long enough that ordinary nouns (монтаж, ремонт) are left untouched.
 */
const VERB_TAILS = [
  "иться",
  "еться",
  "аться",
  "яться",
  "ляется",
  "яется",
  "ается",
  "ить",
  "еть",
  "ать",
  "ять",
  "ется",
  "ится",
  "ляют",
  "ляет",
  "яют",
  "яет",
];

function withoutHyphens(text: string, replacement: string): string {
  return text.replace(/[-‐‑‒–—]/gu, replacement);
}

export function normaliseSearchText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("ru-BY")
    .replace(/ё/gu, "е")
    .replace(/\s+/gu, " ")
    .trim();
}

const AGENT_CASE_ENDINGS = [
  "ами",
  "ях",
  "ах",
  "ам",
  "ов",
  "ом",
  "ем",
  "ой",
  "ей",
  "а",
  "у",
  "е",
  "и",
  "ы",
  "о",
  "ю",
  "я",
];

export function stemWord(raw: string): string {
  const word = withoutHyphens(normaliseSearchText(raw), "");
  if (word.length <= 3) return word;
  let stem = word.replace(/(ся|сь)$/u, "");
  if (stem.length < 4) stem = word;
  for (const tail of VERB_TAILS) {
    if (stem.length - tail.length >= 5 && stem.endsWith(tail)) {
      stem = stem.slice(0, -tail.length);
      break;
    }
  }
  // Keep поставщик / монтажник-style agent nouns before generic "ка":
  // поставщика otherwise becomes поставщи and shares a prefix with поставка.
  const agent = agentNounStem(stem);
  if (agent !== undefined) return agent;
  for (const ending of ENDINGS) {
    if (stem.length - ending.length >= 4 && stem.endsWith(ending)) {
      stem = stem.slice(0, -ending.length);
      break;
    }
  }
  if (stem.endsWith("нн") && stem.length > 5) stem = stem.slice(0, -2);
  else if (stem.endsWith("н") && stem.length > 5) {
    const stripped = stem.slice(0, -1);
    // Keep «проектн» (проектной документации). Stripping «н» would
    // collapse it to the noun «проект» (Проект застройки).
    if (stripped !== "проект") stem = stripped;
  }
  return stem;
}

function agentNounStem(word: string): string | undefined {
  for (const tail of AGENT_TAILS) {
    const index = word.indexOf(tail);
    if (index < 4) continue;
    const core = word.slice(0, index + tail.length);
    if (core.length < 5) continue;
    const rest = word.slice(core.length);
    if (rest.length === 0 || AGENT_CASE_ENDINGS.includes(rest)) return core;
  }
  return undefined;
}

/**
 * Action «поставка» and person «поставщик» share a prefix but are not the
 * same word. Agent tails (щик, тель, …) never count as inflection.
 */
export function stemsShareRoot(left: string, right: string): boolean {
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  const leftFamily = wordFamily(left);
  const rightFamily = wordFamily(right);
  if (leftFamily !== undefined && rightFamily !== undefined && leftFamily !== rightFamily) {
    return false;
  }
  if (leftFamily !== undefined && leftFamily === rightFamily) return true;
  const leftAgent = hasAgentTail(left);
  const rightAgent = hasAgentTail(right);
  if (leftAgent !== rightAgent) return false;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length < 4) return false;
  if (!longer.startsWith(shorter)) return false;
  const remainder = longer.slice(shorter.length);
  return !AGENT_TAILS.some((tail) => remainder.startsWith(tail) || tail.startsWith(remainder));
}

function hasAgentTail(stem: string): boolean {
  return AGENT_TAILS.some((tail) => stem.includes(tail));
}

function wordFamily(
  stem: string,
): "supply-action" | "supplier-person" | "project-object" | "design-work" | undefined {
  if (stem.includes("поставщик") || stem.startsWith("поставщи")) return "supplier-person";
  if (stem.startsWith("поставк") || stem.startsWith("поставл") || stem === "постав") {
    return "supply-action";
  }
  // Noun «проект» (a named construction object) is not the activity
  // «проектирование» and not the adjective «проектный». Prefix matching
  // would otherwise treat «проект» as a root of «проектирова».
  if (stem === "проект") return "project-object";
  if (hasAgentTail(stem)) return undefined;
  if (stem.startsWith("проектн") || stem.startsWith("проектир")) return "design-work";
  return undefined;
}

export function tokenizeStems(text: string): string[] {
  const stems: string[] = [];
  const normalised = withoutHyphens(normaliseSearchText(text), " ");
  for (const match of normalised.matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    if (token === undefined) continue;
    const lower = normaliseSearchText(token);
    if (FILLER.has(lower)) continue;
    stems.push(stemWord(token));
  }
  return stems;
}

function termStemSequences(term: string): string[][] {
  const normalised = normaliseSearchText(term);
  if (normalised.length === 0) return [];
  const spaced = withoutHyphens(normalised, " ");
  const joined = withoutHyphens(normalised, "");
  const sequences = [tokenizeStems(spaced)];
  if (joined !== spaced) sequences.push(tokenizeStems(joined));
  return sequences.filter((item) => item.length > 0);
}

function textStemSequences(text: string): string[][] {
  return termStemSequences(text);
}

/**
 * True when every content stem of `term` appears in order in `text`.
 * Three-letter abbreviations still use the exact token matcher so "НКУ"
 * never hits "банку".
 */
export function termOccurs(text: string, term: string): boolean {
  const needle = normaliseSearchText(term);
  if (needle.length === 0) return false;
  if (!needle.includes(" ") && withoutHyphens(needle, "").length <= 3) {
    return termMatchStrength(text, term) === "exact";
  }
  for (const hay of textStemSequences(text)) {
    for (const needles of termStemSequences(term)) {
      if (sequenceOccurs(hay, needles)) return true;
    }
  }
  return false;
}

/** True when any profile/platform keyword is a real term in the listing text. */
export function listingMatchesAnyKeyword(
  haystack: string,
  keywords: readonly string[],
): boolean {
  if (keywords.length === 0) return true;
  return keywords.some((keyword) => termOccurs(haystack, keyword));
}

/**
 * A listing row the platform already returned. Keep it when a keyword is a
 * real term in the visible row, or when the keyword is not on the row at
 * all — goszakupki.by may have matched «Предмет закупки» on the card, which
 * the listing HTML does not show. Still drop «НКУ» inside «конкурс»: that is
 * the site's substring filter, not a hidden lot match.
 */
export function listingKeepsPlatformHit(
  haystack: string,
  keywords: readonly string[],
): boolean {
  if (keywords.length === 0) return true;
  if (listingMatchesAnyKeyword(haystack, keywords)) return true;
  const foldedHay = compactSearchText(haystack);
  return !keywords.some((keyword) => {
    const foldedNeedle = compactSearchText(keyword);
    return foldedNeedle.length > 0 && foldedHay.includes(foldedNeedle);
  });
}

function compactSearchText(text: string): string {
  return withoutHyphens(normaliseSearchText(text), "");
}

export function firstTermIndex(text: string, term: string): number {
  if (!term.includes(" ") && needleIsShort(term) && termMatchStrength(text, term) === "exact") {
    const hay = tokenizeStems(text);
    const needle = stemWord(term);
    const index = hay.findIndex((item) => item === needle);
    return index;
  }
  let best = -1;
  for (const hay of textStemSequences(text)) {
    for (const needles of termStemSequences(term)) {
      const index = sequenceIndex(hay, needles);
      if (index === -1) continue;
      if (best === -1 || index < best) best = index;
    }
  }
  return best;
}

function sequenceOccurs(hay: readonly string[], needles: readonly string[]): boolean {
  return sequenceIndex(hay, needles) !== -1;
}

function sequenceIndex(hay: readonly string[], needles: readonly string[]): number {
  if (needles.length === 0 || hay.length < needles.length) return -1;
  for (let start = 0; start <= hay.length - needles.length; start += 1) {
    let ok = true;
    for (let index = 0; index < needles.length; index += 1) {
      const fromText = hay[start + index];
      const fromTerm = needles[index];
      if (fromText === undefined || fromTerm === undefined || !stemsShareRoot(fromText, fromTerm)) {
        ok = false;
        break;
      }
    }
    if (ok) return start;
  }
  return -1;
}

function needleIsShort(term: string): boolean {
  return withoutHyphens(normaliseSearchText(term), "").length <= 3;
}
