const TOKEN_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}\-/]*/gu;

/**
 * How confidently a profile term was found in listing text.
 *
 * - "exact": whole token, bounded phrase, word inflection ("трансформатор" →
 *   "трансформаторной") or the term leading a model code ("КТПБ-250").
 * - "embedded": the term sits inside a foreign code such as "БКТПБ-746" or
 *   "2БКТПБ". This is a hint, not proof; a human or model must confirm it.
 * - "none": no match. Short abbreviations never match inside ordinary words
 *   ("НКУ" in "банку", "инкубатор").
 */
export type TermMatchStrength = "exact" | "embedded" | "none";

export function termMatchStrength(text: string, term: string): TermMatchStrength {
  const needle = normalise(term);
  if (needle.length === 0) return "none";
  if (needle.includes(" ")) {
    return phraseMatches(normalise(text), needle) ? "exact" : "none";
  }
  const cleaned = text.normalize("NFKC").replace(/\s+/g, " ");
  let embedded = false;
  for (const match of cleaned.matchAll(TOKEN_PATTERN)) {
    const raw = match[0];
    const token = raw.toLocaleLowerCase("ru-BY");
    if (token === needle) return "exact";
    if (needle.length >= 4 && token.startsWith(needle)) return "exact";
    if (token.startsWith(needle) && isCodeLikeToken(raw) && !isLetter(raw[needle.length])) {
      return "exact";
    }
    if (!embedded && token.includes(needle) && isCodeLikeToken(raw)) {
      let index = token.indexOf(needle);
      while (index !== -1) {
        const before = index > 0 ? raw[index - 1] : undefined;
        const after = index + needle.length < raw.length ? raw[index + needle.length] : undefined;
        const beforeLower = before !== undefined && /^\p{Ll}$/u.test(before);
        const afterLower = after !== undefined && /^\p{Ll}$/u.test(after);
        if (!(beforeLower && afterLower)) {
          embedded = true;
          break;
        }
        index = token.indexOf(needle, index + 1);
      }
    }
  }
  return embedded ? "embedded" : "none";
}

/** True for any match, exact or embedded. */
export function termMatches(text: string, term: string): boolean {
  return termMatchStrength(text, term) !== "none";
}

function phraseMatches(haystack: string, needle: string): boolean {
  const pattern = new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}(?=$|[^\\p{L}\\p{N}])`,
    "iu",
  );
  return pattern.test(haystack);
}

function isCodeLikeToken(raw: string): boolean {
  return (
    /[\p{N}\-/]/u.test(raw) ||
    (raw.length > 1 && raw === raw.toUpperCase() && /\p{L}/u.test(raw))
  );
}

function isLetter(char: string | undefined): boolean {
  return char !== undefined && /\p{L}/u.test(char);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalise(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-BY").replace(/\s+/g, " ").trim();
}
