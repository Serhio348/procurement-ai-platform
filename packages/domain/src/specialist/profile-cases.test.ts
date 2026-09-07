import { describe, expect, it } from "vitest";
import { SpecialistProcurementCard, SpecialistWorkingProfile } from "@procurement/contracts";
import {
  attachProfileToCard,
  procurementBelongsToProfile,
  procurementsForProfile,
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
});
