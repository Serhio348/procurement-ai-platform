import { SearchIntentPlan } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { extraPlatformSearchTerms, inferSearchIntentPlan, parseSearchIntentPlan } from "./intent-plan.js";
import { scoreSearchIntent, SEARCH_INTENT_WEIGHTS } from "./intent-score.js";

const nkuPlan = SearchIntentPlan.parse({
  objects: ["НКУ", "шкаф управления"],
  desired_actions: ["поставка", "изготовление"],
  excluded_actions: ["монтаж", "ремонт", "обслуживание", "проектирование", "пусконаладка"],
  intent: "equipment_purchase",
});

const pumpPlan = SearchIntentPlan.parse({
  objects: ["НКУ", "шкаф управления"],
  required_context: ["насос", "насосное оборудование"],
  excluded_context: ["освещение", "котельная"],
  desired_actions: ["поставка", "изготовление"],
  excluded_actions: ["монтаж", "ремонт", "обслуживание", "проектирование", "пусконаладка"],
  intent: "equipment_purchase",
});

describe("scoreSearchIntent", () => {
  it("scores a supply of NCU for a pump station high", () => {
    const result = scoreSearchIntent(
      { title: "Поставка НКУ для насосной станции" },
      nkuPlan,
    );
    expect(result.decision).toBe("match");
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.matchedObjects).toContain("НКУ");
    expect(result.matchedDesired).toContain("поставка");
    expect(result.reason).toMatch(/НКУ/);
    expect(result.reason).toMatch(/поставка/i);
    expect(result.reason).toMatch(/монтаж/i);
  });

  it("scores fabrication of a pump control cabinet high", () => {
    const result = scoreSearchIntent(
      { title: "Изготовление шкафа управления насосами" },
      nkuPlan,
    );
    expect(result.decision).toBe("match");
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.matchedObjects.some((item) => item.toLowerCase().includes("шкаф"))).toBe(true);
  });

  it("vetoes installation of NCU", () => {
    const result = scoreSearchIntent({ title: "Монтаж НКУ" }, nkuPlan);
    expect(result.decision).toBe("veto");
    expect(result.score).toBeLessThan(SEARCH_INTENT_WEIGHTS.MIN_MATCH_SCORE);
    expect(result.reason).toMatch(/монтажн/i);
  });

  it("vetoes repair of NCU even with inflected words", () => {
    const result = scoreSearchIntent({ title: "Ремонт НКУ в насосной" }, nkuPlan);
    expect(result.decision).toBe("veto");
    expect(result.score).toBeLessThan(SEARCH_INTENT_WEIGHTS.MIN_MATCH_SCORE);
  });

  it("vetoes commissioning of NCU including hyphen forms", () => {
    const result = scoreSearchIntent(
      { title: "Выполнение работ по пуско-наладке НКУ" },
      nkuPlan,
    );
    expect(result.decision).toBe("veto");
    expect(result.score).toBeLessThan(SEARCH_INTENT_WEIGHTS.MIN_MATCH_SCORE);
  });

  it("does not veto supply that only mentions later installation by the buyer", () => {
    const result = scoreSearchIntent(
      {
        title: "Поставка НКУ с последующим монтажом силами заказчика",
      },
      nkuPlan,
    );
    expect(result.decision).toBe("match");
    expect(result.excludedRole).toBe("mention");
    expect(result.score).toBeGreaterThanOrEqual(SEARCH_INTENT_WEIGHTS.MIN_MATCH_SCORE);
  });

  it("does not auto-match NCU that appears only in extra text", () => {
    const result = scoreSearchIntent(
      {
        title: "Реконструкция насосной станции",
        extraText: "в комплекте упомянуто НКУ",
      },
      nkuPlan,
    );
    expect(result.decision).not.toBe("match");
    expect(result.score).toBeLessThan(SEARCH_INTENT_WEIGHTS.MIN_MATCH_SCORE);
    expect(result.reason).toMatch(/дополнительн/i);
  });

  it("discards a title with no target object instead of sending score 0 to review", () => {
    const result = scoreSearchIntent({ title: "Открытый конкурс по закупке аудиторских услуг" }, nkuPlan);
    expect(result.decision).toBe("discard");
    expect(result.score).toBe(0);
  });

  it("does not treat a supplier as the supply action", () => {
    const result = scoreSearchIntent(
      { title: "Выбор поставщика шкафа управления котельной" },
      pumpPlan,
    );
    expect(result.matchedDesired).not.toContain("поставка");
    expect(result.decision).toBe("discard");
    expect(result.contextRole).toBe("mismatch");
  });

  it("matches a pump control cabinet and rejects lighting or boiler cabinets", () => {
    const pump = scoreSearchIntent({ title: "Шкаф управления насосами" }, pumpPlan);
    expect(pump.decision).toBe("match");
    expect(pump.contextRole).toBe("match");
    const lights = scoreSearchIntent(
      { title: "Закупка шкаф управления наружным освещением" },
      pumpPlan,
    );
    expect(lights.decision).toBe("discard");
    expect(lights.contextRole).toBe("mismatch");
    const boiler = scoreSearchIntent(
      { title: "Шкаф управления котельной" },
      pumpPlan,
    );
    expect(boiler.decision).toBe("discard");
    expect(boiler.contextRole).toBe("mismatch");
  });

  it("reviews NCU supply without a stated purpose and does not treat it as junk", () => {
    const result = scoreSearchIntent({ title: "Поставка НКУ 0,4 кВ" }, pumpPlan);
    expect(result.decision).toBe("review");
    expect(result.contextRole).toBe("missing");
    expect(result.matchedObjects).toContain("НКУ");
  });

  it("discards NCU whose purpose is clearly something else", () => {
    const result = scoreSearchIntent(
      { title: "Поставка НКУ для уличного освещения" },
      pumpPlan,
    );
    expect(result.decision).toBe("discard");
    expect(result.contextRole).toBe("mismatch");
  });
});

describe("parseSearchIntentPlan", () => {
  it("drops a score the model tried to attach", () => {
    const parsed = parseSearchIntentPlan({
      objects: ["НКУ"],
      desired_actions: ["поставка"],
      excluded_actions: ["монтаж"],
      intent: "equipment_purchase",
      score: 99,
      relevanceScore: 99,
    });
    expect(parsed?.objects).toEqual(["НКУ"]);
    expect(parsed?.excluded_context).toEqual([]);
    expect(parsed && "score" in parsed).toBe(false);
  });

  it("accepts excluded_context from the model JSON", () => {
    const parsed = parseSearchIntentPlan({
      objects: ["клапан"],
      required_context: ["нефтехимия"],
      excludedContext: ["отопление"],
      desired_actions: ["поставка"],
      excluded_actions: ["монтаж"],
      intent: "equipment_purchase",
    });
    expect(parsed?.required_context).toEqual(["нефтехимия"]);
    expect(parsed?.excluded_context).toEqual(["отопление"]);
  });
});

describe("inferSearchIntentPlan", () => {
  it("turns an equipment profile into objects plus default work exclusions", () => {
    const plan = inferSearchIntentPlan({
      name: "НКУ для управления насосами",
      keywords: ["НКУ", "шкаф управления"],
      excludeKeywords: [],
    });
    expect(plan.objects).toEqual(["НКУ", "шкаф управления"]);
    expect(plan.required_context.some((item) => item.toLowerCase().includes("насос"))).toBe(true);
    expect(plan.excluded_context).toEqual([]);
    expect(plan.desired_actions).toContain("поставка");
    expect(plan.excluded_actions).toContain("монтаж");
    expect(plan.intent).toBe("equipment_purchase");
  });
});

describe("extraPlatformSearchTerms", () => {
  it("returns only objects the cheap listing has not already queried", () => {
    const inferred = inferSearchIntentPlan({
      name: "НКУ для управления насосами",
      keywords: ["НКУ"],
      excludeKeywords: [],
    });
    const fromModel = SearchIntentPlan.parse({
      objects: ["НКУ", "шкаф управления"],
      desired_actions: ["поставка"],
      intent: "equipment_purchase",
    });
    expect(extraPlatformSearchTerms(inferred.objects, fromModel, ["НКУ"])).toEqual(["шкаф управления"]);
    expect(extraPlatformSearchTerms(["НКУ", "шкаф управления"], fromModel, ["НКУ"])).toEqual([]);
  });
});
