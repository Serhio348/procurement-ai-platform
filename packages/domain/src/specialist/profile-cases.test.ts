import { describe, expect, it } from "vitest";
import { SpecialistProcurementCard, SpecialistWorkingProfile } from "@procurement/contracts";
import {
  attachProfileToCard,
  cardAssessmentVerdictFor,
  procurementBelongsToProfile,
  procurementsForProfile,
  projectCardForProfile,
  withCardAssessment,
} from "./profile-cases.js";

const substations = SpecialistWorkingProfile.parse({
  id: "00000000-0000-4000-8000-000000000901",
  name: "Подстанции",
  keywords: ["подстанция"],
});
const water = SpecialistWorkingProfile.parse({
  id: "00000000-0000-4000-8000-000000000902",
  name: "Водоподготовка",
  keywords: ["вода"],
});

function card(title: string, profileIds: readonly string[] = []) {
  return SpecialistProcurementCard.parse({
    id: "00000000-0000-4000-8000-000000000401",
    title,
    status: "unknown",
    statusLabel: "Прием предложений",
    url: "https://example.test/auction/001",
    sourceProcurementId: "auction-001",
    profileIds,
  });
}

describe("profile-owned procurements", () => {
  it("does not list a case from another profile when a direction is selected", () => {
    const owned = attachProfileToCard(card("Комплектная трансформаторная подстанция"), substations.id);
    const other = attachProfileToCard(
      SpecialistProcurementCard.parse({
        ...card("Системы очистки воды"),
        id: "00000000-0000-4000-8000-000000000402",
        sourceProcurementId: "auction-002",
      }),
      water.id,
    );

    expect(procurementsForProfile([owned, other], substations).map((item) => item.title)).toEqual([
      "Комплектная трансформаторная подстанция",
    ]);
    expect(procurementBelongsToProfile(owned, water)).toBe(false);
  });

  it("keeps an untied legacy title on the profile whose keywords match it", () => {
    const legacy = card("Комплектная трансформаторная подстанция");
    expect(procurementBelongsToProfile(legacy, substations)).toBe(true);
    expect(procurementBelongsToProfile(legacy, water)).toBe(false);
  });

  it("keeps each profile's verdict on the same card and projects it per profile", () => {
    const owned = attachProfileToCard(card("Кабель ВВГнг"), substations.id);
    const afterA = withCardAssessment(owned, substations.id, {
      verdict: "match",
      score: 90,
      reason: "причина А",
      evaluatedAt: "2026-09-10T00:00:00.000Z",
    });
    const linked = attachProfileToCard(afterA, water.id);
    const afterB = withCardAssessment(linked, water.id, {
      verdict: "review",
      score: 40,
      reason: "причина Б",
      evaluatedAt: "2026-09-11T00:00:00.000Z",
    });

    // The derived card-level view: a match from any direction wins.
    expect(afterB.foundAs).toBe("match");
    expect(afterB.relevanceScore).toBe(90);
    // Each profile still sees its own answer.
    const forA = projectCardForProfile(afterB, substations.id);
    expect(forA.foundAs).toBe("match");
    expect(forA.relevanceReason).toBe("причина А");
    const forB = projectCardForProfile(afterB, water.id);
    expect(forB.foundAs).toBe("review");
    expect(forB.relevanceScore).toBe(40);
    expect(forB.relevanceReason).toBe("причина Б");
    // A re-run under A updates only A's entry.
    const reA = withCardAssessment(afterB, substations.id, {
      verdict: "review",
      score: 10,
      reason: "переоценка А",
      evaluatedAt: "2026-09-12T00:00:00.000Z",
    });
    expect(projectCardForProfile(reA, substations.id).relevanceReason).toBe("переоценка А");
    expect(projectCardForProfile(reA, water.id).relevanceReason).toBe("причина Б");
    // No profile matched anymore — the derived view follows honestly.
    expect(reA.foundAs).toBe("review");
  });

  it("seeds a legacy card-level verdict onto linked profiles instead of losing it", () => {
    const legacy = attachProfileToCard(
      SpecialistProcurementCard.parse({
        ...card("Кабель"),
        foundAs: "match",
        relevanceScore: 77,
        relevanceReason: "старый вердикт",
        lastSeenAt: "2026-09-01T00:00:00.000Z",
      }),
      substations.id,
    );
    const afterB = withCardAssessment(
      attachProfileToCard(legacy, water.id),
      water.id,
      { verdict: "review", evaluatedAt: "2026-09-11T00:00:00.000Z" },
    );

    expect(cardAssessmentVerdictFor(afterB, substations.id)).toBe("match");
    expect(cardAssessmentVerdictFor(afterB, water.id)).toBe("review");
    expect(projectCardForProfile(afterB, substations.id).relevanceScore).toBe(77);
    expect(afterB.foundAs).toBe("match");
  });
});
