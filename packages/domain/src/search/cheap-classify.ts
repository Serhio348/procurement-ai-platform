/**
 * Title-level classification before any LLM call. Exact keyword hits can be
 * kept; exclude keywords always win. Ambiguous titles are left for the model.
 */

export interface CheapClassifyProfile {
  keywords: readonly string[];
  excludeKeywords: readonly string[];
}

export interface CheapClassifyText {
  title: string;
  buyerName?: string;
  sourceStatus?: string;
}

export type CheapClassifyVerdict = "relevant" | "irrelevant" | "ambiguous";

export interface CheapClassifyResult {
  verdict: CheapClassifyVerdict;
  matchedTerms: readonly string[];
  excludedBy: readonly string[];
}

export function cheapClassifyHit(
  text: CheapClassifyText,
  profile: CheapClassifyProfile,
): CheapClassifyResult {
  const haystack = normalise(
    [text.title, text.buyerName, text.sourceStatus].filter((part) => part !== undefined).join(" "),
  );
  const excludedBy = profile.excludeKeywords.filter((term) => haystack.includes(normalise(term)));
  if (excludedBy.length > 0) {
    return { verdict: "irrelevant", matchedTerms: [], excludedBy };
  }
  const matchedTerms = profile.keywords.filter((term) => haystack.includes(normalise(term)));
  if (matchedTerms.length > 0) {
    return { verdict: "relevant", matchedTerms, excludedBy: [] };
  }
  return { verdict: "ambiguous", matchedTerms: [], excludedBy: [] };
}

function normalise(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-BY").replace(/\s+/g, " ").trim();
}
