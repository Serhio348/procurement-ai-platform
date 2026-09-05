import { SearchHit, electricalEquipmentSeedV1 } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { uuidFromHex } from "../specialist/case.js";
import { selectRelevantSearchCards } from "./search-cards.js";

const profile = {
  keywords: electricalEquipmentSeedV1.keywords,
  excludeKeywords: electricalEquipmentSeedV1.excludeKeywords,
};

function hit(sourceProcurementId: string, title: string, extra: Record<string, unknown> = {}) {
  return SearchHit.parse({
    sourceId: "fixture",
    sourceProcurementId,
    url: `https://example.test/${sourceProcurementId}`,
    title,
    ...extra,
  });
}

describe("selectRelevantSearchCards", () => {
  it("keeps exact profile-keyword titles and drops cable, power transformers, and inflected near-misses", () => {
    const hits = [
      hit("auction-001", "Комплектная трансформаторная подстанция", {
        sourceStatus: "Прием предложений",
        buyerName: "Покупатель А",
        amount: { kind: "limit", amount: 125000, currency: "BYN", raw: "125 000,00 BYN" },
      }),
      hit("marketing-001", "Трансформаторы силовые"),
      hit("request-001", "Ремонт трансформаторной подстанции"),
      hit("etrade-001", "Кабель силовой"),
    ];

    const selected = selectRelevantSearchCards(hits, profile, 20);

    expect(selected.cards.map((card) => card.sourceProcurementId)).toEqual(["auction-001"]);
    expect(selected.discardedCount).toBe(3);
    expect(selected.cards[0]?.title).toBe("Комплектная трансформаторная подстанция");
    expect(selected.cards[0]?.status).toBe("unknown");
    expect(selected.cards[0]?.statusLabel).toBe("Прием предложений");
    expect(selected.cards[0]?.amountLabel).toBe("125 000,00 BYN");
    expect(selected.cards[0]?.actions[0]?.detail).toContain("подстанция");
    expect(selected.cards[0]?.actions[0]?.detail).toContain("Документы ещё не брали");
    expect(selected.cards[0]?.id).toBe(uuidFromHex("fixture:auction-001"));
    expect(selected.cards[0]?.live).toBe(false);
  });

  it("marks goszakupki.by hits as live cases", () => {
    const selected = selectRelevantSearchCards(
      [
        SearchHit.parse({
          sourceId: "goszakupki_by",
          sourceProcurementId: "auction/3629820",
          url: "https://goszakupki.by/auction/view/3629820",
          title: "2БКТПБ 400кВА-10/0,4 кВ",
        }),
      ],
      profile,
      20,
    );
    expect(selected.cards[0]?.live).toBe(true);
  });

  it("lets an exclude keyword discard a hit even when a profile keyword is present", () => {
    const hits = [hit("home-001", "Бытовой щиток и КТПБ для дачи")];
    const selected = selectRelevantSearchCards(
      hits,
      { keywords: ["КТПБ", "подстанция"], excludeKeywords: ["бытов"] },
      20,
    );
    expect(selected.cards).toEqual([]);
    expect(selected.discardedCount).toBe(1);
  });

  it("caps the listed keyword matches at the requested limit", () => {
    const hits = [
      hit("a", "подстанция 1"),
      hit("b", "подстанция 2"),
      hit("c", "кабель"),
    ];
    const selected = selectRelevantSearchCards(hits, profile, 1);
    expect(selected.cards).toHaveLength(1);
    expect(selected.cards[0]?.sourceProcurementId).toBe("a");
    expect(selected.discardedCount).toBe(2);
  });
});
