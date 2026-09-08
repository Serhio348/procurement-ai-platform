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
    expect(selected.ambiguousCards).toHaveLength(3);
    expect(selected.discardedCount).toBe(0);
    expect(selected.cards[0]?.title).toBe("Комплектная трансформаторная подстанция");
    expect(selected.cards[0]?.status).toBe("unknown");
    expect(selected.cards[0]?.statusLabel).toBe("Прием предложений");
    expect(selected.cards[0]?.amountLabel).toBe("125 000,00 BYN");
    expect(selected.cards[0]?.actions[0]?.detail).toContain("подстанция");
    expect(selected.cards[0]?.actions[0]?.detail).toContain("Документы ещё не брали");
    expect(selected.cards[0]?.id).toBe(uuidFromHex("fixture:auction-001"));
    expect(selected.cards[0]?.live).toBe(false);
  });

  it("gives each goszakupki.by procedure its own card id", () => {
    const selected = selectRelevantSearchCards(
      [
        SearchHit.parse({
          sourceId: "goszakupki_by",
          sourceProcurementId: "marketing/3541093",
          url: "https://goszakupki.by/marketing/view/3541093",
          title: "Системы очистки воды картриджи",
        }),
        SearchHit.parse({
          sourceId: "goszakupki_by",
          sourceProcurementId: "request/3552348",
          url: "https://goszakupki.by/request/view/3552348",
          title: "Системы очистки воды осмос",
        }),
        SearchHit.parse({
          sourceId: "goszakupki_by",
          sourceProcurementId: "single-source/3481185",
          url: "https://goszakupki.by/single-source/view/3481185",
          title: "Системы очистки воды обслуживание",
        }),
      ],
      { keywords: ["Системы очистки воды"], excludeKeywords: [] },
      20,
    );
    const ids = new Set(selected.cards.map((card) => card.id));
    expect(selected.cards).toHaveLength(3);
    expect(ids.size).toBe(3);
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

  it("drops hits whose status the profile does not watch", () => {
    const hits = [
      hit("auction-001", "Комплектная трансформаторная подстанция", {
        status: "accepting_bids",
        sourceStatus: "Подать предложение",
      }),
      hit("auction-002", "Комплектная трансформаторная подстанция", {
        status: "completed",
        sourceStatus: "Завершен",
      }),
      hit("auction-003", "Комплектная трансформаторная подстанция"),
    ];

    const activeOnly = selectRelevantSearchCards(
      hits,
      { ...profile, statuses: ["accepting_bids"] },
      20,
    );
    expect(activeOnly.cards.map((card) => card.sourceProcurementId)).toEqual([
      "auction-001",
      "auction-003",
    ]);

    const everything = selectRelevantSearchCards(hits, { ...profile, statuses: [] }, 20);
    expect(everything.cards).toHaveLength(3);
  });

  it("keeps unmatched but unexcluded hits as ambiguous cards for review", () => {
    const hits = [
      hit("auction-001", "Комплектная трансформаторная подстанция"),
      hit("auction-002", "Отправка почтовой корреспонденции", {
        buyerName: "Национальный банк",
      }),
      hit("auction-003", "Бытовой ремонт квартиры"),
    ];

    const selected = selectRelevantSearchCards(
      hits,
      { keywords: ["КТПБ", "подстанция"], excludeKeywords: ["бытов"] },
      20,
    );

    expect(selected.cards.map((card) => card.sourceProcurementId)).toEqual([
      "auction-001",
    ]);
    expect(selected.ambiguousCards.map((card) => card.sourceProcurementId)).toEqual([
      "auction-002",
    ]);
    expect(selected.ambiguousCards[0]?.actions[0]?.detail).toContain(
      "проверьте по смыслу",
    );
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
    // "b" matches but is over the limit, "c" matches nothing and waits for review.
    expect(selected.ambiguousCards.map((card) => card.sourceProcurementId)).toEqual(["c"]);
    expect(selected.discardedCount).toBe(1);
  });
});
