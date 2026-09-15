import { ProcedureCard, SearchHit, electricalEquipmentSeedV1 } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { uuidFromHex } from "../specialist/case.js";
import { inferSearchIntentPlan } from "./intent-plan.js";
import { isSingleSourceAfterFailedProcedure, selectRelevantSearchCards } from "./search-cards.js";

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

  it("keeps a БКТПВ row found by «КТП» as a review candidate, never an automatic match, and traces discards", () => {
    const plan = inferSearchIntentPlan({
      name: "КТП",
      keywords: ["КТПБ", "КТП", "сети электроснабжения"],
      excludeKeywords: [],
    });
    const selected = selectRelevantSearchCards(
      [
        hit("auction-1", "Поставка БКТПВ-630", { matchedSearchTerms: ["КТП"] }),
        hit("auction-2", "Закупка КТП 10/0,4 кВ", { matchedSearchTerms: ["КТП", "КТПБ"] }),
        hit("auction-3", "Монтаж КТП на объекте", { matchedSearchTerms: ["КТП"] }),
      ],
      { keywords: ["КТПБ", "КТП", "сети электроснабжения"], excludeKeywords: [], intent: plan },
      20,
    );
    expect(selected.cards.map((card) => card.sourceProcurementId)).toEqual([]);
    expect(selected.ambiguousCards.map((card) => card.sourceProcurementId).sort()).toEqual([
      "auction-1",
      "auction-2",
      "auction-3",
    ]);
    expect(selected.discarded).toEqual([]);
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

  it("sends a keyword buried inside a foreign code to review instead of the list", () => {
    const hits = [
      hit(
        "etrade/3643981",
        "Выбор подрядной организации на выполнение строительно-монтажных работ по объекту «Реконструкция ВЛ-0,4 кВ от БКТПБ-746 в аг. Каменюки»",
      ),
      hit("auction-002", "Поставка КТПБ-250 для подстанции"),
    ];

    const selected = selectRelevantSearchCards(
      hits,
      { keywords: ["КТПБ", "КТП"], excludeKeywords: [] },
      20,
    );

    expect(selected.cards.map((card) => card.sourceProcurementId)).toEqual(["auction-002"]);
    expect(selected.ambiguousCards.map((card) => card.sourceProcurementId)).toEqual([
      "etrade/3643981",
    ]);
    expect(selected.ambiguousCards[0]?.actions[0]?.detail).toContain("внутри чужого кода");
    expect(selected.ambiguousCards[0]?.actions[0]?.detail).toContain("КТПБ, КТП");
    expect(selected.discardedCount).toBe(0);
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

  it("drops single-source purchases only when the profile asks for it, and never a hit without a kind", () => {
    const hits = [
      hit("single-source/1", "Комплектная трансформаторная подстанция", { kind: "single_source" }),
      hit("auction/1", "Комплектная трансформаторная подстанция", { kind: "electronic_auction" }),
      hit("request/1", "Комплектная трансформаторная подстанция"),
    ];
    expect(
      selectRelevantSearchCards(hits, profile, 20).cards.map((card) => card.sourceProcurementId),
    ).toEqual(["single-source/1", "auction/1", "request/1"]);
    const excluded = selectRelevantSearchCards(hits, { ...profile, excludeSingleSource: true }, 20);
    expect(excluded.cards.map((card) => card.sourceProcurementId)).toEqual(["auction/1", "request/1"]);
    expect(excluded.discardedCount).toBe(1);
  });
});

describe("isSingleSourceAfterFailedProcedure", () => {
  const base = {
    sourceId: "goszakupki_by",
    sourceProcurementId: "single-source/1",
    url: "https://goszakupki.by/single-source/view/1",
    title: "Выбор генподрядчика",
    kind: "single_source",
    fetchedAt: "2026-09-11T00:00:00.000Z",
  };

  it("is decided by the basis or the preceding procedure number, not by kind alone", () => {
    expect(isSingleSourceAfterFailedProcedure(ProcedureCard.parse(base))).toBe(false);
    expect(
      isSingleSourceAfterFailedProcedure(
        ProcedureCard.parse({
          ...base,
          singleSourceBasis: "7. Признание процедуры государственной закупки несостоявшейся.",
        }),
      ),
    ).toBe(true);
    expect(
      isSingleSourceAfterFailedProcedure(
        ProcedureCard.parse({ ...base, precedingProcedureNumber: "auc0003541262" }),
      ),
    ).toBe(true);
    expect(
      isSingleSourceAfterFailedProcedure(
        ProcedureCard.parse({ ...base, singleSourceBasis: "3. Закупка у единственного поставщика" }),
      ),
    ).toBe(false);
  });

  it("ignores the basis on a competitive procedure", () => {
    expect(
      isSingleSourceAfterFailedProcedure(
        ProcedureCard.parse({
          ...base,
          kind: "electronic_auction",
          singleSourceBasis: "несостоявшейся",
        }),
      ),
    ).toBe(false);
  });
});

describe("selectRelevantSearchCards with intent", () => {
  const intent = {
    objects: ["НКУ", "шкаф управления"],
    required_context: ["насос", "насосное оборудование"],
    excluded_context: [],
    desired_actions: ["поставка", "изготовление"],
    excluded_actions: ["монтаж", "ремонт", "обслуживание", "проектирование", "пусконаладка"],
    intent: "equipment_purchase" as const,
  };
  const profile = { keywords: ["НКУ"], excludeKeywords: [], intent };

  it("does not settle supply vs installation from the listing title", () => {
    const selected = selectRelevantSearchCards(
      [
        hit("a", "Поставка НКУ для насосной станции"),
        hit("b", "Изготовление шкафа управления насосами"),
        hit("c", "Монтаж НКУ"),
        hit("d", "Ремонт НКУ"),
        hit("e", "Пусконаладка НКУ"),
        hit("f", "Поставка НКУ для насосов с последующим монтажом силами заказчика"),
      ],
      profile,
      20,
    );
    expect(selected.cards).toEqual([]);
    expect(selected.ambiguousCards.map((card) => card.sourceProcurementId).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
  });

  it("drops substring noise on the listing and leaves purpose mismatches for the card", () => {
    const selected = selectRelevantSearchCards(
      [
        hit("light", "Закупка шкаф управления наружным освещением"),
        hit("contest", "Открытый конкурс по закупке аудиторских услуг"),
      ],
      {
        ...profile,
        intent: { ...intent, excluded_context: ["освещение"] },
      },
      20,
    );
    expect(selected.cards).toEqual([]);
    expect(selected.ambiguousCards.map((card) => card.sourceProcurementId)).toEqual(["light"]);
    expect(selected.discarded.map((item) => item.hit.sourceProcurementId)).toEqual(["contest"]);
  });

  it("reviews a listing whose title has no object when the site still returned it", () => {
    const selected = selectRelevantSearchCards(
      [
        hit(
          "zhlobin",
          "Выбор субподрядной организации по объекту: «Проект застройки микрорайона №21 в г.Жлобине. Генплан и инженерные сети» 1 очередь строительства.",
        ),
      ],
      {
        keywords: ["электрооборудование"],
        excludeKeywords: [],
        intent: {
          objects: ["электрооборудование"],
          required_context: [],
          excluded_context: [],
          desired_actions: ["монтаж", "пусконаладка"],
          excluded_actions: [],
          intent: "works",
        },
      },
      20,
    );
    expect(selected.cards).toEqual([]);
    expect(selected.ambiguousCards.map((card) => card.sourceProcurementId)).toEqual(["zhlobin"]);
  });

  it("reviews a lot-only platform hit before title-object rows that already scored", () => {
    const works = {
      keywords: ["электрооборудование"],
      excludeKeywords: [] as string[],
      intent: {
        objects: ["электрооборудование"],
        required_context: [],
        excluded_context: [],
        desired_actions: ["монтаж", "пусконаладка"],
        excluded_actions: [],
        intent: "works" as const,
      },
    };
    const titleHits = Array.from({ length: 50 }, (_item, index) =>
      hit(`supply-${String(index)}`, `Поставка электрооборудования ${String(index)}`),
    );
    const selected = selectRelevantSearchCards(
      [
        ...titleHits,
        hit(
          "limited/3669746",
          "Выбор субподрядной организации по объекту: «Проект застройки микрорайона №21 в г.Жлобине. Генплан и инженерные сети» 1 очередь строительства.",
        ),
      ],
      works,
      20,
    );
    expect(selected.ambiguousCards).toHaveLength(51);
    expect(selected.ambiguousCards.some((card) => card.sourceProcurementId === "limited/3669746")).toBe(
      true,
    );
  });

  it("uses review capacity for the unexamined tail after earlier candidates were rejected", () => {
    const works = {
      keywords: ["электрооборудование"],
      excludeKeywords: [] as string[],
      intent: {
        objects: ["электрооборудование"],
        required_context: [],
        excluded_context: [],
        desired_actions: ["монтаж"],
        excluded_actions: [],
        intent: "works" as const,
      },
      skipReviewSourceIds: new Set(
        Array.from({ length: 50 }, (_item, index) => `old-${String(index)}`),
      ),
    };
    const selected = selectRelevantSearchCards(
      [
        ...Array.from({ length: 50 }, (_item, index) =>
          hit(`old-${String(index)}`, `Объект без предмета ${String(index)}`),
        ),
        hit("fresh", "Новый объект без предмета"),
      ],
      works,
      20,
    );
    expect(selected.ambiguousCards.map((card) => card.sourceProcurementId)).toEqual(["fresh"]);
    expect(selected.discardedCount).toBe(50);
  });
});
