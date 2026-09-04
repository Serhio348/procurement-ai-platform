import {
  ProcedureCard,
  ProcurementId,
  SearchHit,
  SpecialistProcurementCard,
  type ProcedureCard as ProcedureCardValue,
  type SearchHit as SearchHitValue,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
} from "@procurement/contracts";
import { statusLabel, uuidFromHex } from "../specialist/case.js";
import { cheapClassifyHit, type CheapClassifyProfile } from "./cheap-classify.js";

export interface ProfileSearchSelection {
  cards: SpecialistProcurementCardValue[];
  discardedCount: number;
}

/**
 * Turns listing hits into specialist cases. Only exact profile-keyword matches
 * become cards; ambiguous titles wait for the model and are not shown yet.
 */
export function selectRelevantSearchCards(
  hits: readonly SearchHitValue[],
  profile: CheapClassifyProfile,
  limit: number,
): ProfileSearchSelection {
  const listed = hits
    .filter((hit) => hitMatchesProfileKeywords(hit, profile.keywords))
    .slice(0, limit);
  const cards: SpecialistProcurementCardValue[] = [];
  let discardedCount = hits.length - listed.length;
  for (const hit of listed) {
    const classified = cheapClassifyHit(
      {
        title: hit.title,
        ...(hit.buyerName === undefined ? {} : { buyerName: hit.buyerName }),
        ...(hit.sourceStatus === undefined ? {} : { sourceStatus: hit.sourceStatus }),
      },
      profile,
    );
    if (classified.verdict !== "relevant") {
      discardedCount += 1;
      continue;
    }
    cards.push(cardFromRelevantHit(hit, classified.matchedTerms));
  }
  return { cards, discardedCount };
}

export function hitMatchesProfileKeywords(
  hit: SearchHitValue,
  keywords: readonly string[],
): boolean {
  if (keywords.length === 0) return false;
  const haystack = normalise(
    [hit.title, hit.buyerName, hit.sourceStatus]
      .filter((part): part is string => part !== undefined)
      .join(" "),
  );
  return keywords.some((keyword) => haystack.includes(normalise(keyword)));
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
  const label = amountLabel(hit);
  return SpecialistProcurementCard.parse({
    id: ProcurementId.parse(uuidFromHex(`${hit.sourceId}:${hit.sourceProcurementId}`)),
    title: hit.title,
    status: "unknown",
    statusLabel: hit.sourceStatus ?? statusLabel("unknown"),
    url: hit.url,
    sourceProcurementId: hit.sourceProcurementId,
    ...(hit.buyerName === undefined ? {} : { buyerName: hit.buyerName }),
    ...(label === undefined ? {} : { amountLabel: label }),
    actions: [
      {
        step: 1,
        actor: "DomainSearchAgent",
        status: "done",
        detail: `procurement.search: найдена «${hit.title}». Релевантна по словам: ${terms}. Документы ещё не брали.`,
      },
    ],
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

function normalise(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-BY").replace(/\s+/g, " ").trim();
}
