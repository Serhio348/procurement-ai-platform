const STOPWORDS = new Set([
  "а",
  "без",
  "в",
  "во",
  "для",
  "до",
  "и",
  "из",
  "или",
  "ищу",
  "ищем",
  "закупка",
  "закупки",
  "закупок",
  "к",
  "как",
  "ко",
  "мне",
  "на",
  "но",
  "нужно",
  "нужны",
  "о",
  "от",
  "по",
  "под",
  "поиск",
  "с",
  "со",
  "также",
  "что",
  "это",
]);

const MAX_PHRASES = 50;

/**
 * Turns the specialist's «что ищем» text into platform search lines.
 * Commas and new lines are separate queries; filler words are dropped.
 */
export function searchPhrasesFromLookingFor(text: string): string[] {
  const segments = text
    .split(/[\n,;]/u)
    .flatMap((segment) => segment.split(/\s+и\s+/iu))
    .map((segment) => segment.replace(/[«»""]/gu, "").replace(/\s+/gu, " ").trim())
    .filter((segment) => segment.length > 0);

  const phrases: string[] = [];
  for (const segment of segments) {
    const content = segment
      .split(" ")
      .map((word) => word.replace(/^[.,:;—\-()]+|[.,:;—\-()]+$/gu, ""))
      .filter((word) => word.length > 0 && !isStopword(word));
    if (content.length === 0) continue;
    if (content.length <= 4) {
      phrases.push(content.join(" "));
      continue;
    }
    for (const word of content) {
      if (word.length >= 3) phrases.push(word);
    }
  }
  return dedupe(phrases).slice(0, MAX_PHRASES);
}

/** Explicit platform lines win; otherwise collect them from «что ищем». */
export function resolvePlatformKeywords(
  lookingFor: string,
  explicit: readonly string[],
): string[] {
  const trimmed = explicit.map((phrase) => phrase.trim()).filter((phrase) => phrase.length > 0);
  return trimmed.length > 0 ? trimmed : searchPhrasesFromLookingFor(lookingFor);
}

export function sameSearchPhrases(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((phrase, index) => phrase.toLowerCase() === (right[index] ?? "").toLowerCase());
}

export function platformKeywordEdits(
  lookingFor: string,
  saved: readonly string[],
): { extras: string[]; removed: string[] } {
  const derived = searchPhrasesFromLookingFor(lookingFor);
  if (saved.length === 0) return { extras: [], removed: [] };
  const savedKeys = new Set(saved.map((phrase) => phrase.toLowerCase()));
  const derivedKeys = new Set(derived.map((phrase) => phrase.toLowerCase()));
  return {
    extras: saved.filter((phrase) => !derivedKeys.has(phrase.toLowerCase())),
    removed: derived.filter((phrase) => !savedKeys.has(phrase.toLowerCase())),
  };
}

export function mergePlatformKeywords(
  lookingFor: string,
  extras: readonly string[],
  removed: readonly string[],
): string[] {
  const removedKeys = new Set(removed.map((phrase) => phrase.toLowerCase()));
  const kept = searchPhrasesFromLookingFor(lookingFor).filter(
    (phrase) => !removedKeys.has(phrase.toLowerCase()),
  );
  return dedupe([...kept, ...extras.map((phrase) => phrase.trim()).filter((phrase) => phrase.length > 0)]).slice(
    0,
    MAX_PHRASES,
  );
}

export function addPlatformKeyword(
  lookingFor: string,
  extras: readonly string[],
  removed: readonly string[],
  raw: string,
): { extras: string[]; removed: string[] } {
  const phrase = raw.trim();
  if (phrase.length === 0) return { extras: [...extras], removed: [...removed] };
  const key = phrase.toLowerCase();
  const derived = searchPhrasesFromLookingFor(lookingFor);
  if (derived.some((item) => item.toLowerCase() === key)) {
    return {
      extras: [...extras],
      removed: removed.filter((item) => item.toLowerCase() !== key),
    };
  }
  if (extras.some((item) => item.toLowerCase() === key)) {
    return { extras: [...extras], removed: [...removed] };
  }
  return { extras: [...extras, phrase], removed: [...removed] };
}

export function removePlatformKeyword(
  lookingFor: string,
  extras: readonly string[],
  removed: readonly string[],
  raw: string,
): { extras: string[]; removed: string[] } {
  const key = raw.trim().toLowerCase();
  if (key.length === 0) return { extras: [...extras], removed: [...removed] };
  if (extras.some((item) => item.toLowerCase() === key)) {
    return {
      extras: extras.filter((item) => item.toLowerCase() !== key),
      removed: [...removed],
    };
  }
  const derived = searchPhrasesFromLookingFor(lookingFor);
  const match = derived.find((item) => item.toLowerCase() === key);
  if (match === undefined || removed.some((item) => item.toLowerCase() === key)) {
    return { extras: [...extras], removed: [...removed] };
  }
  return { extras: [...extras], removed: [...removed, match] };
}

function isStopword(word: string): boolean {
  return STOPWORDS.has(word.toLowerCase());
}

function dedupe(phrases: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const phrase of phrases) {
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(phrase);
  }
  return unique;
}
