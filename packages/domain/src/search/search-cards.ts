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
import { listingKeepsPlatformHit, termOccurs } from "./query-terms.js";
import { termMatches } from "./term-match.js";

export interface ProfileSearchSelection {
  cards: SpecialistProcurementCardValue[];
  /** Borderline hits kept for human review instead of being dropped. */
  ambiguousCards: SpecialistProcurementCardValue[];
  /** The listing rows behind ambiguousCards, same order, for a second look. */
  ambiguousHits: SearchHitValue[];
  discardedCount: number;
  /** Why each dropped row was dropped, for the search trace; never shown as a verdict. */
  discarded: Array<{ hit: SearchHitValue; reason: string; score?: number }>;
}

/** How many borderline hits one search run may push to the inbox. */
export const MAX_AMBIGUOUS_PER_SEARCH = 50;

/** Listing placeholder: the site row is not a scored card yet. */
export const LISTING_PENDING_REASON =
  "В строке списка нет полного предмета закупки — карточка дочитывается.";

/** A site listing row waiting for procurement.get. Not an actionable card. */
export function isListingPlaceholder(card: {
  relevanceReason?: string | undefined;
}): boolean {
  return card.relevanceReason === LISTING_PENDING_REASON;
}

/** Закупки may show a hit only after procurement.get and a code score. */
export function isScoredSearchMatch(card: {
  foundAs?: string | undefined;
  relevanceReason?: string | undefined;
}): boolean {
  return card.foundAs === "match" && !isListingPlaceholder(card);
}

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
  /** Review verdicts already settled for this exact profile version. */
  skipReviewSourceIds?: ReadonlySet<string>;
}

/**
 * Listing is retrieval, not a verdict. Profile filters (status, single-source,
 * exclude words, substring noise) may drop a row. Everything the platform
 * returned otherwise waits for procurement.get so lot subject can score.
 * Without an intent plan the cheap keyword classifier still runs on the title.
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
  const discarded: ProfileSearchSelection["discarded"] = [];
  for (const hit of hits) {
    const key = `${hit.sourceId}:${hit.sourceProcurementId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!hitMatchesProfileStatuses(hit, profile.statuses)) {
      discarded.push({ hit, reason: "статус процедуры не входит в профиль" });
      continue;
    }
    if (profile.excludeSingleSource === true && hit.kind === "single_source") {
      discarded.push({ hit, reason: "закупка из одного источника исключена профилем" });
      continue;
    }
    if (profile.intent !== undefined) {
      const ranked = rankHitByIntent(hit, profile);
      if (ranked.kind === "discard") {
        discarded.push({ hit, reason: ranked.reason, score: ranked.score });
        continue;
      }
      if (ranked.kind === "match") {
        cards.push(ranked.card);
        continue;
      }
      if (profile.skipReviewSourceIds?.has(hit.sourceProcurementId) === true) {
        discarded.push({ hit, reason: "уже проверена и отклонена для этого профиля" });
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
    if (classified.verdict === "irrelevant") {
      discarded.push({ hit, reason: `исключающее слово: ${classified.excludedBy.join(", ")}` });
      continue;
    }
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
  if (profile.intent === undefined) {
    cards.sort((left, right) => (right.relevanceScore ?? 0) - (left.relevanceScore ?? 0));
    if (cards.length > limit) cards.length = limit;
  }
  const discardedCount = hits.length - cards.length - ambiguousCards.length;
  return { cards, ambiguousCards, ambiguousHits, discardedCount, discarded };
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

type IntentRank =
  | { kind: "match" | "review"; card: SpecialistProcurementCardValue }
  | { kind: "discard"; reason: string; score: number };

function rankHitByIntent(hit: SearchHitValue, profile: SearchSelectionProfile): IntentRank {
  if (profile.intent === undefined) return { kind: "discard", reason: "нет плана поиска", score: 0 };
  const haystack = [hit.title, hit.buyerName, hit.sourceStatus]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  const excluded = profile.excludeKeywords.find((term) => termOccurs(haystack, term));
  if (excluded !== undefined) {
    return { kind: "discard", reason: `исключающее слово профиля: ${excluded}`, score: 0 };
  }
  const queried =
    hit.matchedSearchTerms !== undefined && hit.matchedSearchTerms.length > 0
      ? hit.matchedSearchTerms
      : profile.intent.objects.length > 0
        ? profile.intent.objects
        : profile.keywords;
  if (!listingKeepsPlatformHit(haystack, queried)) {
    return {
      kind: "discard",
      reason: "поисковое слово встречается только как часть другого слова в строке списка",
      score: 0,
    };
  }
  return {
    kind: "review",
    card: cardFromIntentHit(
      hit,
      0,
      LISTING_PENDING_REASON,
      "review",
    ),
  };
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
    status: hit.status ?? "unknown",
    statusLabel: hit.sourceStatus ?? statusLabel(hit.status ?? "unknown"),
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
  const foundBy =
    hit.matchedSearchTerms !== undefined && hit.matchedSearchTerms.length > 0
      ? ` Найдена по: ${hit.matchedSearchTerms.join(", ")}.`
      : "";
  const prefix =
    foundAs === "match"
      ? `procurement.search: найдена «${hit.title}».${foundBy} Оценка ${String(score)}. ${reason}`
      : `procurement.search: найдена «${hit.title}».${foundBy} Оценка ${String(score)} — на проверку. ${reason}`;
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

