import {
  SpecialistProcurementCard,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
  type SpecialistWorkingProfile as SpecialistWorkingProfileValue,
} from "@procurement/contracts";
import { termMatches } from "../search/term-match.js";

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
