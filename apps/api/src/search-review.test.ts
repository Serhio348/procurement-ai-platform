import { ProcedureCard, SearchHit, type SearchClassifierInput } from "@procurement/contracts";
import { inferSearchIntentPlan } from "@procurement/domain";
import type { McpToolCaller } from "@procurement/mcp-client";
import { describe, expect, it, vi } from "vitest";
import { createProcurementSearchReview } from "./search-review.js";

const profile = {
  name: "Электротехническое оборудование",
  purpose: "Поставка КТПБ и НКУ",
  keywords: ["КТПБ", "НКУ"],
  excludeKeywords: ["ремонт"],
};

function hit(id: string, title: string) {
  return SearchHit.parse({
    sourceId: "goszakupki_by",
    sourceProcurementId: id,
    url: `https://goszakupki.by/auction/view/${id.replace("/", "-")}`,
    title,
  });
}

function cardWithLots(id: string, title: string, lotTitles: readonly string[]) {
  return ProcedureCard.parse({
    sourceId: "goszakupki_by",
    sourceProcurementId: id,
    url: `https://goszakupki.by/auction/view/${id.replace("/", "-")}`,
    title,
    lots: lotTitles.map((lotTitle, index) => ({ number: String(index + 1), title: lotTitle })),
    fetchedAt: "2026-09-09T00:00:00.000Z",
  });
}

function cardCaller(cards: Record<string, unknown>): McpToolCaller {
  return {
    callTool: vi.fn(async (_name, input) => {
      const key = String((input as { sourceProcurementId?: unknown }).sourceProcurementId);
      const card = cards[key];
      if (card === undefined) throw new Error("card not found");
      return { structuredContent: card };
    }) as McpToolCaller["callTool"],
  };
}

describe("createProcurementSearchReview", () => {
  it("accepts a hit whose lot names the equipment, without spending a model call", async () => {
    const classify = vi.fn(async (_input: SearchClassifierInput) => ({}));
    const review = createProcurementSearchReview({
      caller: cardCaller({
        "auction/1": cardWithLots("auction/1", "Поставка оборудования", ["НКУ-0,4 кВ, 2 шт."]),
      }),
      classifier: { classify },
    });

    const [outcome] = await review.review([hit("auction/1", "Поставка оборудования")], profile);

    expect(outcome?.verdict).toBe("relevant");
    expect(outcome?.decidedBy).toBe("card");
    expect(outcome?.status).toBe("unknown");
    expect(classify).not.toHaveBeenCalled();
  });

  it("drops a hit whose card carries an excluded word even before the model is asked", async () => {
    const classify = vi.fn(async (_input: SearchClassifierInput) => ({
      verdict: "relevant",
      confidence: 1,
      reason: "Похоже на щитовое оборудование.",
      needDeeper: false,
      matchedTerms: ["НКУ"],
    }));
    const review = createProcurementSearchReview({
      caller: cardCaller({
        "auction/2": cardWithLots("auction/2", "Текущий ремонт щитовой", ["Работы по ремонту"]),
      }),
      classifier: { classify },
    });

    const [outcome] = await review.review([hit("auction/2", "Текущий ремонт щитовой")], profile);

    expect(outcome?.verdict).toBe("irrelevant");
    expect(outcome?.decidedBy).toBe("card");
    expect(classify).not.toHaveBeenCalled();
  });

  it("asks the model only for a card that stays unclear and passes it the lots", async () => {
    const classify = vi.fn(async (_input: SearchClassifierInput) => ({
      verdict: "irrelevant",
      confidence: 0.95,
      reason: "Лабораторный инкубатор, не электрооборудование.",
      needDeeper: false,
      matchedTerms: [],
    }));
    const review = createProcurementSearchReview({
      caller: cardCaller({
        "auction/3": cardWithLots("auction/3", "СО2-инкубатор", ["Термостат электронный"]),
      }),
      classifier: { classify },
    });

    const [outcome] = await review.review([hit("auction/3", "СО2-инкубатор")], profile);

    expect(outcome?.verdict).toBe("irrelevant");
    expect(outcome?.decidedBy).toBe("model");
    expect(classify).toHaveBeenCalledTimes(1);
    const sent = classify.mock.calls[0]?.[0];
    expect(sent?.card?.lotTitles).toEqual(["Термостат электронный"]);
    expect(sent?.profile.keywords).toEqual(["КТПБ", "НКУ"]);
  });

  it("keeps a hesitant model verdict out of the list by handing it to a specialist", async () => {
    const review = createProcurementSearchReview({
      caller: cardCaller({
        "auction/4": cardWithLots("auction/4", "Электромонтажные работы", ["Монтаж щитов"]),
      }),
      classifier: {
        classify: async () => ({
          verdict: "relevant",
          confidence: 0.55,
          reason: "Возможно, поставка щитов.",
          needDeeper: true,
          matchedTerms: [],
        }),
      },
      minConfidence: 0.7,
    });

    const [outcome] = await review.review([hit("auction/4", "Электромонтажные работы")], profile);

    expect(outcome?.verdict).toBe("needs_human");
    expect(outcome?.confidence).toBeCloseTo(0.55);
  });

  it("survives a failed card fetch and a failing model without accepting the hit", async () => {
    const review = createProcurementSearchReview({
      caller: { callTool: async () => Promise.reject(new Error("source unavailable")) },
      classifier: { classify: async () => Promise.reject(new Error("LLM API returned HTTP 500")) },
    });

    const [outcome] = await review.review([hit("auction/5", "Неизвестная процедура")], profile);

    expect(outcome?.verdict).toBe("needs_human");
    expect(outcome?.decidedBy).toBe("model");
  });

  it("without a classifier leaves every unclear hit for a human instead of guessing", async () => {
    const review = createProcurementSearchReview({
      caller: cardCaller({
        "auction/6": cardWithLots("auction/6", "Электромонтажные работы", ["Монтаж"]),
      }),
    });

    const [outcome] = await review.review([hit("auction/6", "Электромонтажные работы")], profile);

    expect(outcome?.verdict).toBe("needs_human");
    expect(outcome?.decidedBy).toBe("none");
  });

  it("spends at most maxModelCalls per run and marks the rest as unreviewed", async () => {
    const classify = vi.fn(async (_input: SearchClassifierInput) => ({
      verdict: "irrelevant",
      confidence: 0.9,
      reason: "Не подходит.",
      needDeeper: false,
      matchedTerms: [],
    }));
    const ids = ["auction/7", "auction/8", "auction/9"];
    const review = createProcurementSearchReview({
      caller: cardCaller(
        Object.fromEntries(ids.map((id) => [id, cardWithLots(id, "Прочие работы", ["Работы"])])),
      ),
      classifier: { classify },
      maxModelCalls: 2,
      concurrency: 1,
    });

    const outcomes = await review.review(
      ids.map((id) => hit(id, "Прочие работы")),
      profile,
    );

    expect(classify).toHaveBeenCalledTimes(2);
    expect(outcomes.filter((item) => item.decidedBy === "model")).toHaveLength(2);
    expect(outcomes.filter((item) => item.decidedBy === "quota")).toHaveLength(1);
    expect(outcomes.every((item) => item.verdict !== "relevant")).toBe(true);
  });

  it("scores lot subject with the profile intent without a model call", async () => {
    const classify = vi.fn(async (_input: SearchClassifierInput) => ({}));
    const review = createProcurementSearchReview({
      caller: cardCaller({
        "auction/10": cardWithLots(
          "auction/10",
          "Выбор субподрядной организации по объекту в Жлобине",
          [
            "работы по монтажу электрооборудования распределительного пункта, пусконаладочных работ",
          ],
        ),
      }),
      classifier: { classify },
    });
    const worksProfile = {
      name: "Монтаж и пусконаладка электросилового оборудования",
      keywords: ["электрооборудование", "монтаж", "пусконаладка"],
      excludeKeywords: [] as string[],
      intent: inferSearchIntentPlan({
        name: "Монтаж и пусконаладка электросилового оборудования",
        keywords: ["электрооборудование", "монтаж", "пусконаладка"],
        excludeKeywords: [],
      }),
    };

    const [outcome] = await review.review(
      [hit("auction/10", "Выбор субподрядной организации по объекту в Жлобине")],
      worksProfile,
    );

    expect(outcome?.verdict).toBe("relevant");
    expect(outcome?.decidedBy).toBe("card");
    expect(classify).not.toHaveBeenCalled();
  });

  it("accepts a matching later lot without a model call in either lot order", async () => {
    const card = cardWithLots("auction/13", "Закупка оборудования", [
      "Поставка НКУ для освещения",
      "Поставка НКУ для насосов",
    ]);
    const classify = vi.fn(async () => ({}));
    const intent = inferSearchIntentPlan({
      name: "НКУ для насосов",
      keywords: ["НКУ"],
      excludeKeywords: [],
    });
    intent.excluded_context = ["освещение"];
    for (const lots of [card.lots, [...card.lots].reverse()]) {
      const review = createProcurementSearchReview({
        caller: cardCaller({ "auction/13": { ...card, lots } }),
        classifier: { classify },
      });
      const [outcome] = await review.review([hit("auction/13", card.title)], {
        name: "НКУ для насосов",
        keywords: ["НКУ"],
        excludeKeywords: [],
        intent,
      });
      expect(outcome?.verdict).toBe("relevant");
      expect(outcome?.decidedBy).toBe("card");
      expect(outcome?.reason).toContain("Лот 2:");
      expect(outcome?.matchedTerms).toContain("НКУ");
    }
    expect(classify).not.toHaveBeenCalled();
  });

  it("asks the model which side of a mixed supply-and-works lot is the subject", async () => {
    const classify = vi.fn(async (input: SearchClassifierInput) => {
      expect(input.mixedActions?.desired).toEqual(["поставка"]);
      expect(input.mixedActions?.excluded).toContain("монтаж");
      expect(input.mixedActions?.question).toMatch(/основным предметом/);
      return {
        verdict: "needs_human",
        confidence: 0.6,
        reason: "Закупка под ключ: поставка и монтаж сопоставимы.",
        needDeeper: false,
        matchedTerms: ["КТП"],
      };
    });
    const review = createProcurementSearchReview({
      caller: cardCaller({
        "auction/12": cardWithLots("auction/12", "Выбор подрядчика по объекту «Микрорайон №5»", [
          "монтаж КТП, поставка и пусконаладка оборудования",
        ]),
      }),
      classifier: { classify },
    });
    const supplyProfile = {
      name: "КТП",
      keywords: ["КТП"],
      excludeKeywords: [] as string[],
      intent: inferSearchIntentPlan({ name: "КТП", keywords: ["КТП"], excludeKeywords: [] }),
    };

    const [outcome] = await review.review(
      [hit("auction/12", "Выбор подрядчика по объекту «Микрорайон №5»")],
      supplyProfile,
    );

    expect(classify).toHaveBeenCalledTimes(1);
    expect(outcome?.verdict).toBe("needs_human");
    expect(outcome?.decidedBy).toBe("model");
  });

  it("hands commissioning without the profile object to the model instead of a silent card discard", async () => {
    const classify = vi.fn(async () => ({
      verdict: "irrelevant",
      confidence: 0.95,
      reason: "Зерноочистительный комплекс, электрооборудование не является предметом.",
      needDeeper: false,
      matchedTerms: [],
    }));
    const review = createProcurementSearchReview({
      caller: cardCaller({
        "auction/11": cardWithLots(
          "auction/11",
          "Пусконаладка зернового комплекса",
          ["Пусконаладочные работы оборудования зерноочистительного комплекса"],
        ),
      }),
      classifier: { classify },
    });
    const worksProfile = {
      name: "Монтаж и пусконаладка электросилового оборудования",
      keywords: ["электрооборудование", "монтаж", "пусконаладка"],
      excludeKeywords: [] as string[],
      intent: inferSearchIntentPlan({
        name: "Монтаж и пусконаладка электросилового оборудования",
        keywords: ["электрооборудование", "монтаж", "пусконаладка"],
        excludeKeywords: [],
      }),
    };

    const [outcome] = await review.review(
      [hit("auction/11", "Пусконаладка зернового комплекса")],
      worksProfile,
    );

    expect(outcome?.verdict).toBe("irrelevant");
    expect(outcome?.decidedBy).toBe("model");
    expect(classify).toHaveBeenCalledTimes(1);
  });
});
