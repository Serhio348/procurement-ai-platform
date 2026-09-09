/**
 * Title-level classification before any LLM call. Exact keyword hits can be
 * kept; exclude keywords always win. A keyword found only inside a foreign
 * code ("КТПБ" in "БКТПБ-746") is a weak hint that needs a human or model.
 * Titles with no keyword at all are ambiguous and also left for review.
 */
import { termMatchStrength } from "./term-match.js";

export interface CheapClassifyProfile {
  keywords: readonly string[];
  excludeKeywords: readonly string[];
}

export interface CheapClassifyText {
  title: string;
  buyerName?: string;
  sourceStatus?: string;
}

export type CheapClassifyVerdict = "relevant" | "weak" | "irrelevant" | "ambiguous";

export interface CheapClassifyResult {
  verdict: CheapClassifyVerdict;
  matchedTerms: readonly string[];
  excludedBy: readonly string[];
}

export function cheapClassifyHit(
  text: CheapClassifyText,
  profile: CheapClassifyProfile,
): CheapClassifyResult {
  const haystack = [text.title, text.buyerName, text.sourceStatus]
    .filter((part) => part !== undefined)
    .join(" ");
  const excludedBy = profile.excludeKeywords.filter(
    (term) => termMatchStrength(haystack, term) !== "none",
  );
  if (excludedBy.length > 0) {
    return { verdict: "irrelevant", matchedTerms: [], excludedBy };
  }
  const exact: string[] = [];
  const embedded: string[] = [];
  for (const term of profile.keywords) {
    const strength = termMatchStrength(haystack, term);
    if (strength === "exact") exact.push(term);
    else if (strength === "embedded") embedded.push(term);
  }
  if (exact.length > 0) {
    return { verdict: "relevant", matchedTerms: exact, excludedBy: [] };
  }
  if (embedded.length > 0) {
    return { verdict: "weak", matchedTerms: embedded, excludedBy: [] };
  }
  return { verdict: "ambiguous", matchedTerms: [], excludedBy: [] };
}
