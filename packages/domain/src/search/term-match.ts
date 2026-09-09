const TOKEN_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}\-/]*/gu;

/**
 * Matches a profile term against listing text.
 *
 * A single-word term counts when it is a whole token or a substring of a
 * code-like token such as "2БКТПБ" or "БКТПБ-746". Terms of 4+ letters also
 * match a token prefix (word inflection: "трансформатор" →
 * "трансформаторной"); shorter abbreviations like "НКУ" never match inside
 * ordinary words ("банку", "круглосуточной"). Multi-word terms match as a
 * phrase bounded by non-word characters.
 */
export function termMatches(text: string, term: string): boolean {
  const needle = normalise(term);
  if (needle.length === 0) return false;
  if (needle.includes(" ")) {
    return phraseMatches(normalise(text), needle);
  }
  const cleaned = text.normalize("NFKC").replace(/\s+/g, " ");
  for (const match of cleaned.matchAll(TOKEN_PATTERN)) {
    const raw = match[0];
    const token = raw.toLocaleLowerCase("ru-BY");
    if (token === needle) return true;
    if (needle.length >= 4 && token.startsWith(needle)) return true;
    if (token.includes(needle) && isCodeLikeToken(raw)) {
      let index = token.indexOf(needle);
      while (index !== -1) {
        const before = index > 0 ? raw[index - 1] : undefined;
        const after = index + needle.length < raw.length ? raw[index + needle.length] : undefined;
        const beforeLower = before !== undefined && /^\p{Ll}$/u.test(before);
        const afterLower = after !== undefined && /^\p{Ll}$/u.test(after);
        if (!(beforeLower && afterLower)) return true;
        index = token.indexOf(needle, index + 1);
      }
    }
  }
  return false;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalise(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-BY").replace(/\s+/g, " ").trim();
}
