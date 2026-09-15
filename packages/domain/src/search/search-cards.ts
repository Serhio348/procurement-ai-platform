import {
  ProcedureCard,
  ProcurementId,
  SearchHit,
  SpecialistProcurementCard,
  type ProcedureCard as ProcedureCardValue,
  type SearchHit as SearchHitValue,
  type SearchIntentPlan,
  type SpecialistFoundAs,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
  type ProcedureStatus as ProcedureStatusValue,
} from "@procurement/contracts";
import { statusLabel, uuidFromHex } from "../specialist/case.js";
import { cheapClassifyHit, type CheapClassifyProfile } from "./cheap-classify.js";
import { scoreSearchIntent, SEARCH_INTENT_WEIGHTS } from "./intent-score.js";
import { listingKeepsPlatformHit, termOccurs } from "./query-terms.js";
import { termMatches } from "./term-match.js";

export interface ProfileSearchSelection {
  cards: SpecialistProcurementCardValue[];
  /** Borderline hits kept for human review instead of being dropped. */
  ambiguousCards: SpecialistProcurementCardValue[];
  /** The listing rows behind ambiguousCards, same order, for a second look. */
  ambiguousHits: SearchHitValue[];
  discardedCount: number;
}

/** How many borderline hits one search run may push to the inbox. */
export const MAX_AMBIGUOUS_PER_SEARCH = 50;

/** Profile filters applied to listing hits before classification. */
export interface SearchSelectionProfile extends CheapClassifyProfile {
  /** Watched procedure statuses; empty or absent means no status filter. */
  statuses?: readonly ProcedureStatusValue[];
  /** Drop single-source purchases outright. */
  excludeSingleSource?: boolean;
  /**
   * When set, a hit is not a match just because one keyword appears. Code
   * scores object vs action vs excluded action; the model never writes this.
   */
  intent?: SearchIntentPlan;
}

/**
 * Turns listing hits into specialist cases. Exact profile-keyword matches
 * become cards. Hits where a keyword is only buried inside a foreign code
 * ("КТПБ" in "БКТПБ-746") and hits that match no keyword at all become
 * ambiguous cards for human review, capped at MAX_AMBIGUOUS_PER_SEARCH.
 * With an intent plan, a title that names no object is also review: the
 * platform may have matched lot subject, and procurement.get scores the card.
 * Only an exclude keyword, a veto, or a mismatched purpose drops a hit outright.
 */
export function selectRelevantSearchCards(
  hits: readonly SearchHitValue[],
  profile: SearchSelectionProfile,
  limit: number,
): ProfileSearchSelection {
  const seen = new Set<string>();
  const cards: SpecialistProcurementCardValue[] = [];
  const ambiguousCards: SpecialistProcurementCardValue[] = [];
  const ambiguousHits: SearchHitValue[] = [];
  for (const hit of hits) {
    const key = `${hit.sourceId}:${hit.sourceProcurementId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!hitMatchesProfileStatuses(hit, profile.statuses)) continue;
    if (profile.excludeSingleSource === true && hit.kind === "single_source") continue;
    if (profile.intent !== undefined) {
      const ranked = rankHitByIntent(hit, profile);
      if (ranked === undefined) continue;
      if (ranked.kind === "match") {
        cards.push(ranked.card);
        continue;
      }
      ambiguousCards.push(ranked.card);
      ambiguousHits.push(hit);
      continue;
    }
    const classified = cheapClassifyHit(
      {
        title: hit.title,
        ...(hit.buyerName === undefined ? {} : { buyerName: hit.buyerName }),
        ...(hit.sourceStatus === undefined ? {} : { sourceStatus: hit.sourceStatus }),
      },
      profile,
    );
    if (classified.verdict === "irrelevant") continue;
    if (classified.verdict === "relevant") {
      if (cards.length < limit) cards.push(cardFromRelevantHit(hit, classified.matchedTerms));
      continue;
    }
    if (ambiguousCards.length >= MAX_AMBIGUOUS_PER_SEARCH) continue;
    ambiguousCards.push(
      classified.verdict === "weak"
        ? cardFromWeakHit(hit, classified.matchedTerms)
        : cardFromAmbiguousHit(hit),
    );
    ambiguousHits.push(hit);
  }
  if (profile.intent !== undefined) {
    cards.sort((left, right) => (right.relevanceScore ?? 0) - (left.relevanceScore ?? 0));
    if (cards.length > limit) cards.length = limit;
    capAmbiguousByLotSubjectFirst(ambiguousCards, ambiguousHits);
  }
  const discardedCount = hits.length - cards.length - ambiguousCards.length;
  return { cards, ambiguousCards, ambiguousHits, discardedCount };
}

/**
 * Title-only object hits score ~40 and would fill MAX_AMBIGUOUS before a
 * platform lot-match whose listing title has no object (score 0). Those
 * lot-only rows are why we open the card; give them the review slots.
 */
function capAmbiguousByLotSubjectFirst(
  ambiguousCards: SpecialistProcurementCardValue[],
  ambiguousHits: SearchHitValue[],
): void {
  if (ambiguousCards.length <= MAX_AMBIGUOUS_PER_SEARCH) return;
  const ranked = ambiguousCards.map((card, index) => ({
    card,
    hit: ambiguousHits[index],
    score: card.relevanceScore ?? 0,
    index,
  }));
  ranked.sort((left, right) => left.score - right.score || left.index - right.index);
  ranked.length = MAX_AMBIGUOUS_PER_SEARCH;
  ambiguousCards.length = 0;
  ambiguousHits.length = 0;
  for (const row of ranked) {
    if (row.hit === undefined) continue;
    ambiguousCards.push(row.card);
    ambiguousHits.push(row.hit);
  }
}

export function hitMatchesProfileKeywords(
  hit: SearchHitValue,
  keywords: readonly string[],
): boolean {
  if (keywords.length === 0) return false;
  const haystack = [hit.title, hit.buyerName, hit.sourceStatus]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  return keywords.some((keyword) => termMatches(haystack, keyword));
}

/**
 * A hit without a parsed status is kept: missing data is not a finished
 * procedure. A hit whose status is normalized but not watched is dropped.
 */
export function hitMatchesProfileStatuses(
  hit: SearchHitValue,
  statuses: readonly ProcedureStatusValue[] | undefined,
): boolean {
  if (statuses === undefined || statuses.length === 0) return true;
  if (hit.status === undefined) return true;
  return statuses.includes(hit.status);
}

/**
 * A single-source purchase that exists only because a competitive procedure
 * failed. Decided from the card, never from the listing row: the basis is not
 * shown there. A card without a basis is not treated as "after failed".
 */
export function isSingleSourceAfterFailedProcedure(card: ProcedureCardValue): boolean {
  if (card.kind !== "single_source") return false;
  if (card.precedingProcedureNumber !== undefined) return true;
  const basis = card.singleSourceBasis?.normalize("NFKC").toLocaleLowerCase("ru-BY") ?? "";
  return basis.includes("несостоя");
}

export function searchHitsFromFixtureDump(raw: unknown): SearchHitValue[] {
  if (typeof raw !== "object" || raw === null || !("records" in raw)) {
    throw new Error("fixture dump missing records");
  }
  const records = (raw as { records: unknown }).records;
  if (!Array.isArray(records)) {
    throw new Error("fixture dump records must be an array");
  }
  return records.map((record, index) => {
    if (typeof record !== "object" || record === null || !("card" in record)) {
      throw new Error(`fixture record ${String(index)} missing card`);
    }
    return searchHitFromProcedureCard(ProcedureCard.parse((record as { card: unknown }).card));
  });
}

export function searchHitFromProcedureCard(card: ProcedureCardValue): SearchHitValue {
  const buyerName =
    card.buyer?.name ?? card.parties.find((party) => party.role === "buyer")?.name;
  return SearchHit.parse({
    sourceId: card.sourceId,
    sourceProcurementId: card.sourceProcurementId,
    url: card.url,
    title: card.title,
    pageFamily: card.pageFamily,
    ...(card.sourceStatus === undefined ? {} : { sourceStatus: card.sourceStatus }),
    ...(card.status === "unknown" ? {} : { status: card.status }),
    ...(buyerName === undefined ? {} : { buyerName }),
    ...(card.startingPrice === undefined ? {} : { startingPrice: card.startingPrice }),
    ...(card.amount === undefined ? {} : { amount: card.amount }),
    ...(card.publishedAt === undefined ? {} : { publishedAt: card.publishedAt }),
    ...(card.bidsDeadline === undefined ? {} : { bidsDeadline: card.bidsDeadline }),
  });
}

function rankHitByIntent(
  hit: SearchHitValue,
  profile: SearchSelectionProfile,
): { kind: "match" | "review"; card: SpecialistProcurementCardValue } | undefined {
  if (profile.intent === undefined) return undefined;
  const haystack = [hit.title, hit.buyerName, hit.sourceStatus]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  if (profile.excludeKeywords.some((term) => termOccurs(haystack, term))) return undefined;
  const scored = scoreSearchIntent({ title: hit.title }, profile.intent);
  if (scored.decision === "match" && scored.score >= SEARCH_INTENT_WEIGHTS.MIN_MATCH_SCORE) {
    return { kind: "match", card: cardFromIntentHit(hit, scored.score, scored.reason, "match") };
  }
  if (scored.decision === "veto") return undefined;
  if (scored.decision === "discard" && scored.objectRole !== "none") return undefined;
  if (scored.decision === "discard" && scored.objectRole === "none") {
    const queried = profile.intent.objects.length > 0 ? profile.intent.objects : profile.keywords;
    if (!listingKeepsPlatformHit(haystack, queried)) return undefined;
  }
  // No object in the listing title, and the visible row is not substring
  // noise: the site may have matched lot subject. Cap at MAX_AMBIGUOUS.
  return { kind: "review", card: cardFromIntentHit(hit, scored.score, scored.reason, "review") };
}

export function cardFromRelevantHit(
  hit: SearchHitValue,
  matchedTerms: readonly string[],
): SpecialistProcurementCardValue {
  const terms = matchedTerms.length > 0 ? matchedTerms.join(", ") : "ключевые слова профиля";
  return foundCard(
    hit,
    "match",
    `procurement.search: найдена «${hit.title}». Релевантна по словам: ${terms}. Документы ещё не брали.`,
  );
}

/** A borderline hit: the source returned it, but no profile term matched. */
export function cardFromAmbiguousHit(
  hit: SearchHitValue,
): SpecialistProcurementCardValue {
  return foundCard(
    hit,
    "review",
    `procurement.search: найдена «${hit.title}». Точных совпадений по словам нет — проверьте по смыслу. Документы ещё не брали.`,
  );
}

/** A weak hit: a profile term sits inside a foreign code such as "БКТПБ-746". */
export function cardFromWeakHit(
  hit: SearchHitValue,
  matchedTerms: readonly string[],
): SpecialistProcurementCardValue {
  return foundCard(
    hit,
    "review",
    `procurement.search: найдена «${hit.title}». Слова ${matchedTerms.join(", ")} встречаются только внутри чужого кода — проверьте по смыслу. Документы ещё не брали.`,
  );
}

function foundCard(
  hit: SearchHitValue,
  foundAs: SpecialistFoundAs,
  detail: string,
  extras: { relevanceScore?: number; relevanceReason?: string } = {},
): SpecialistProcurementCardValue {
  const label = amountLabel(hit);
  return SpecialistProcurementCard.parse({
    id: ProcurementId.parse(uuidFromHex(`${hit.sourceId}:${hit.sourceProcurementId}`)),
    title: hit.title,
    status: "unknown",
    statusLabel: hit.sourceStatus ?? statusLabel("unknown"),
    url: hit.url,
    sourceProcurementId: hit.sourceProcurementId,
    live: hit.sourceId === "goszakupki_by",
    foundAs,
    ...(hit.buyerName === undefined ? {} : { buyerName: hit.buyerName }),
    ...(label === undefined ? {} : { amountLabel: label }),
    ...(extras.relevanceScore === undefined ? {} : { relevanceScore: extras.relevanceScore }),
    ...(extras.relevanceReason === undefined ? {} : { relevanceReason: extras.relevanceReason }),
    actions: [{ step: 1, actor: "DomainSearchAgent", status: "done", detail }],
  });
}

function cardFromIntentHit(
  hit: SearchHitValue,
  score: number,
  reason: string,
  foundAs: SpecialistFoundAs,
): SpecialistProcurementCardValue {
  const prefix =
    foundAs === "match"
      ? `procurement.search: найдена «${hit.title}». Оценка ${String(score)}. ${reason}`
      : `procurement.search: найдена «${hit.title}». Оценка ${String(score)} — на проверку. ${reason}`;
  return foundCard(hit, foundAs, prefix, { relevanceScore: score, relevanceReason: reason });
}

function amountLabel(hit: SearchHitValue): string | undefined {
  const amount = hit.amount ?? hit.startingPrice;
  if (amount === undefined) return undefined;
  if ("raw" in amount && typeof amount.raw === "string" && amount.raw.length > 0) return amount.raw;
  if ("amount" in amount && typeof amount.amount === "number") {
    const currency = "currency" in amount ? String(amount.currency) : "";
    return `${String(amount.amount)} ${currency}`.trim();
  }
  return undefined;
}

