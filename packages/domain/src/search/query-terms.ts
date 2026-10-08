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

const SHORT_NOUN_ENDINGS = ["ей", "ой", "ов", "ам", "ах", "ям", "ях", "а", "я", "у", "ю", "е", "и", "ы", "о", "ь"];

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
  let stripped = false;
  for (const ending of ENDINGS) {
    if (stem.length - ending.length >= 4 && stem.endsWith(ending)) {
      stem = stem.slice(0, -ending.length);
      stripped = true;
      break;
    }
  }
  // Short nouns (сеть / сети / сетей, вода / воды) have a three-letter root.
  // Only plain case endings are taken so «шкаф» and «банк» stay whole.
  if (!stripped && stem.length <= 5) {
    for (const ending of SHORT_NOUN_ENDINGS) {
      if (stem.length - ending.length >= 3 && stem.endsWith(ending)) {
        stem = stem.slice(0, -ending.length);
        break;
      }
    }
  }
  // The adjective suffix is a single «н» («бетонный» → «бетон»). Taking both
  // letters of «нн» eats a root that itself ends in «н»: «электронный» would
  // become the bound prefix «электро», which is a prefix of every
  // электро-compound («электрооборудование», «электромонтажные»).
  if (stem.endsWith("нн") && stem.length > 5) stem = stem.slice(0, -1);
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

const GLUED_UNIT = /^(\d+(?:[.,]\d+)?)(ква|квт|мвт|кв)$/iu;

export interface TokenizedWord {
  stem: string;
  /** The word as written, lower-cased. */
  surface: string;
  /** A preposition or conjunction: not a term, but it separates neighbours. */
  filler: boolean;
}

export function tokenizeWords(text: string): TokenizedWord[] {
  const words: TokenizedWord[] = [];
  const normalised = withoutHyphens(normaliseSearchText(text), " ");
  for (const match of normalised.matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    if (token === undefined) continue;
    const lower = normaliseSearchText(token);
    if (FILLER.has(lower)) {
      words.push({ stem: lower, surface: lower, filler: true });
      continue;
    }
    // "0,4кВ" and "10кВ" are the same term as "0,4 кВ" and "10 кВ".
    // The comma already splits the decimal, so only the unit suffix is glued.
    const glued = GLUED_UNIT.exec(lower);
    const number = glued?.[1];
    const unit = glued?.[2];
    if (number !== undefined && unit !== undefined) {
      words.push({ stem: stemWord(number), surface: number, filler: false });
      words.push({ stem: stemWord(unit), surface: unit, filler: false });
      continue;
    }
    words.push({ stem: stemWord(token), surface: lower, filler: false });
  }
  return words;
}

export function tokenizeStems(text: string): string[] {
  return tokenizeWords(text)
    .filter((word) => !word.filler)
    .map((word) => word.stem);
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
 * How a profile term was found.
 * "exact" is a whole token, a code the term leads ("КТПБ-250"), or an
 * inflection. "embedded" is only inside a foreign code ("ТП" in "ЭТП"):
 * a hint the scorer must not settle by itself.
 */
export type TermEvidence = "exact" | "embedded" | "none";

/**
 * Three-letter abbreviations still use the token matcher so "НКУ" never
 * hits "банку". A stem hit counts as exact: the word itself is there.
 */
export function termEvidence(text: string, term: string): TermEvidence {
  const needle = normaliseSearchText(term);
  if (needle.length === 0) return "none";
  const strength = termMatchStrength(text, term);
  if (strength === "exact") return "exact";
  if (strength === "embedded") return "embedded";
  if (!needle.includes(" ") && withoutHyphens(needle, "").length <= 3) {
    return "none";
  }
  for (const hay of textStemSequences(text)) {
    for (const needles of termStemSequences(term)) {
      if (sequenceOccurs(hay, needles)) return "exact";
    }
  }
  return "none";
}

/** True when the term is present at all, including a code-internal hint. */
export function termOccurs(text: string, term: string): boolean {
  return termEvidence(text, term) !== "none";
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
  // A saved abbreviation inside another uppercase equipment code is a weak
  // candidate (КТПБ in БКТПБ), not ordinary-word noise (НКУ in конкурс).
  if (keywords.some((keyword) => termMatchStrength(haystack, keyword) === "embedded")) {
    return true;
  }
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
