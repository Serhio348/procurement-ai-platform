import type { SpecialistProcurementCard } from "@procurement/contracts";

export function RelevanceNote({ card }: { card: SpecialistProcurementCard }) {
  if (card.relevanceScore === undefined && card.relevanceReason === undefined) return null;
  return (
    <p className="relevance-note">
      {card.relevanceScore === undefined ? null : <strong>Оценка {String(card.relevanceScore)}</strong>}
      {card.relevanceReason === undefined ? null : (
        <span>
          {card.relevanceScore === undefined ? "" : " · "}
          {card.relevanceReason}
        </span>
      )}
    </p>
  );
}
