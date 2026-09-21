import {
  SpecialistProcurementCard,
  type SpecialistCardAssessment as SpecialistCardAssessmentValue,
  type SpecialistFoundAs as SpecialistFoundAsValue,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
  type SpecialistWorkingProfile as SpecialistWorkingProfileValue,
} from "@procurement/contracts";
import { termMatches } from "../search/term-match.js";

/**
 * The verdict one profile's search produced for a card. Falls back to the
 * card-level field for rows stored before per-profile assessments existed
 * and linked to no assessment yet (R04).
 */
export function cardAssessmentVerdictFor(
  card: Pick<SpecialistProcurementCardValue, "assessments" | "foundAs">,
  profileId: string,
): SpecialistFoundAsValue | undefined {
  return card.assessments?.[profileId]?.verdict ?? card.foundAs;
}

/**
 * Writes one profile's verdict into the card and refreshes the derived
 * card-level fields: a "match" from any direction wins, score and reason
 * come from the freshest verdict of the winning class (R04).
 */
export function withCardAssessment(
  card: SpecialistProcurementCardValue,
  profileId: string,
  assessment: SpecialistCardAssessmentValue,
): SpecialistProcurementCardValue {
  const assessments = { ...card.assessments };
  if (Object.keys(assessments).length === 0 && card.foundAs !== undefined) {
    // A card scored before per-profile verdicts existed: attribute the old
    // card-level answer to every linked profile so the next run under one
    // direction cannot silently take it away from the others.
    for (const id of card.profileIds) {
      assessments[id] = {
        verdict: card.foundAs,
        ...(card.relevanceScore === undefined ? {} : { score: card.relevanceScore }),
        ...(card.relevanceReason === undefined ? {} : { reason: card.relevanceReason }),
        evaluatedAt: card.lastSeenAt ?? assessment.evaluatedAt,
      };
    }
  }
  assessments[profileId] = assessment;
  const derived = deriveAssessmentView(assessments);
  return SpecialistProcurementCard.parse({
    ...card,
    assessments,
    ...(derived === undefined
      ? {}
      : {
          foundAs: derived.verdict,
          relevanceScore: derived.score,
          relevanceReason: derived.reason,
        }),
  });
}

/**
 * The card as one profile sees it: its own assessment becomes the visible
 * verdict, score and reason. Without an entry the card is returned as is —
 * the caller decides whether the derived view applies (R04).
 */
export function projectCardForProfile(
  card: SpecialistProcurementCardValue,
  profileId: string,
): SpecialistProcurementCardValue {
  const own = card.assessments[profileId];
  if (own === undefined) return card;
  return SpecialistProcurementCard.parse({
    ...card,
    foundAs: own.verdict,
    relevanceScore: own.score,
    relevanceReason: own.reason,
  });
}

function deriveAssessmentView(
  assessments: Readonly<Record<string, SpecialistCardAssessmentValue>>,
): SpecialistCardAssessmentValue | undefined {
  const entries = Object.values(assessments);
  if (entries.length === 0) return undefined;
  const matches = entries.filter((entry) => entry.verdict === "match");
  const pool = matches.length > 0 ? matches : entries;
  return pool.reduce((left, right) => (left.evaluatedAt >= right.evaluatedAt ? left : right));
}

export function attachProfileToCard(
  card: SpecialistProcurementCardValue,
  profileId: string,
): SpecialistProcurementCardValue {
  if (card.profileIds.includes(profileId)) return card;
  return SpecialistProcurementCard.parse({
    ...card,
    profileIds: [...card.profileIds, profileId],
  });
}

export function mergeProfileIds(
  previous: readonly string[] | undefined,
  incoming: readonly string[],
): string[] {
  const ids: string[] = [];
  for (const id of [...(previous ?? []), ...incoming]) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function procurementsForProfile(
  cards: readonly SpecialistProcurementCardValue[],
  profile: SpecialistWorkingProfileValue | undefined,
): SpecialistProcurementCardValue[] {
  if (profile === undefined) return [...cards];
  return cards.filter((card) => procurementBelongsToProfile(card, profile));
}

export function procurementBelongsToProfile(
  card: SpecialistProcurementCardValue,
  profile: SpecialistWorkingProfileValue,
): boolean {
  if (card.profileIds.includes(profile.id)) return true;
  if (card.profileIds.length > 0) return false;
  return titleMatchesKeywords(card, profile.keywords);
}

function titleMatchesKeywords(
  card: SpecialistProcurementCardValue,
  keywords: readonly string[],
): boolean {
  if (keywords.length === 0) return false;
  const haystack = [card.title, card.buyerName]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  return keywords.some((keyword) => termMatches(haystack, keyword));
}
