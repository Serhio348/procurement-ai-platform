import type { CommercialClaim } from "@procurement/contracts";

/**
 * A commercial claim is only a fact if the quoted wording is on the cited page.
 * The model may propose a quote; this check is the provenance gate.
 */

export function pageKey(hash: string, page: number): string {
  return `${hash}:${String(page)}`;
}

export function quoteIsOnPage(quote: string, pageText: string): boolean {
  const needle = normalise(quote);
  if (needle.length === 0) return false;
  return normalise(pageText).includes(needle);
}

export function keepQuotedClaims(
  claims: readonly CommercialClaim[],
  pageText: ReadonlyMap<string, string>,
): CommercialClaim[] {
  return claims.filter((claim) =>
    quoteIsOnPage(claim.quote, pageText.get(pageKey(claim.hash, claim.page)) ?? ""),
  );
}

function normalise(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-BY").replace(/\s+/g, " ").trim();
}
