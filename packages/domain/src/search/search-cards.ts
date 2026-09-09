import {
  ProcedureCard,
  ProcurementId,
  SearchHit,
  SpecialistProcurementCard,
  type ProcedureCard as ProcedureCardValue,
  type SearchHit as SearchHitValue,
  type SpecialistFoundAs,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
  type ProcedureStatus as ProcedureStatusValue,
} from "@procurement/contracts";
import { statusLabel, uuidFromHex } from "../specialist/case.js";
import { cheapClassifyHit, type CheapClassifyProfile } from "./cheap-classify.js";
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
}

/**
 * Turns listing hits into specialist cases. Exact profile-keyword matches
 * become cards. Hits where a keyword is only buried inside a foreign code
 * ("КТПБ" in "БКТПБ-746") and hits that match no keyword at all become
 * ambiguous cards for human review, capped at MAX_AMBIGUOUS_PER_SEARCH.
 * Only an exclude keyword drops a hit outright.
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
  const discardedCount = hits.length - cards.length - ambiguousCards.length;
  return { cards, ambiguousCards, ambiguousHits, discardedCount };
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
    actions: [{ step: 1, actor: "DomainSearchAgent", status: "done", detail }],
  });
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

