import { ProcedureCard, SearchIntentPlan } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import {
  extraPlatformSearchTerms,
  inferSearchIntentPlan,
  parseSearchIntentPlan,
  platformSearchTerms,
} from "./intent-plan.js";
import {
  scoreSearchIntent,
  scoreSearchIntentFromProcedure,
  SEARCH_INTENT_WEIGHTS,
} from "./intent-score.js";

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

function procedureCard(title: string, lotTitle: string) {
  return ProcedureCard.parse({
    sourceId: "goszakupki_by",
    sourceProcurementId: "auction/1",
    url: "https://goszakupki.by/auction/view/1",
    title,
    lots: [{ number: "1", title: lotTitle }],
    fetchedAt: "2026-09-15T00:00:00.000Z",
  });
}

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

  it("matches a works profile from lot subject when the procedure title is empty of objects", () => {
    const worksPlan = inferSearchIntentPlan({
      name: "Монтаж и пусконаладка электросилового оборудования",
      keywords: ["электрооборудование", "монтаж", "пусконаладка"],
      excludeKeywords: [],
    });
    const result = scoreSearchIntentFromProcedure(
      procedureCard(
        "Выбор субподрядной организации по объекту: «Проект застройки микрорайона №21 в г.Жлобине. Генплан и инженерные сети» 1 очередь строительства.",
        "Выбор субподрядной организации для выполнения работ по монтажу электрооборудования распределительного пункта с трансформаторной подстанцией (РП с ТП), АСКУЭ, пусконаладочных работ, электрических измерений и сдачи результата работ",
      ),
      worksPlan,
    );
    expect(worksPlan.intent).toBe("works");
    expect(result.decision).toBe("match");
    expect(result.matchedObjects).toContain("электрооборудование");
    expect(result.matchedDesired).toEqual(expect.arrayContaining(["монтаж", "пусконаладка"]));
    expect(result.score).toBeGreaterThanOrEqual(SEARCH_INTENT_WEIGHTS.MIN_MATCH_SCORE);
  });

  it("does not match a design profile on a construction object named проект", () => {
    const designPlan = inferSearchIntentPlan({
      name: "Проектирование электроснабжения и электрооборудования",
      keywords: ["проектирование", "электроснабжение", "электрооборудование"],
      excludeKeywords: [],
    });
    const result = scoreSearchIntentFromProcedure(
      procedureCard(
        "Выбор субподрядной организации по объекту: «Проект застройки микрорайона №21 в г.Жлобине. Генплан и инженерные сети» 1 очередь строительства.",
        "Выбор субподрядной организации для выполнения работ по монтажу электрооборудования распределительного пункта с трансформаторной подстанцией (РП с ТП), АСКУЭ, пусконаладочных работ, электрофизических измерений и сдачи результата работ эксплуатирующей организации Филиалу «Жлобинские электрические сети» РУП «Гомельэнерго», при строительстве объекта: «Проект застройки микрорайона №21 в г.Жлобине. Генплан и инженерные сети» 1 очередь строительства.",
      ),
      designPlan,
    );
    expect(result.decision).not.toBe("match");
    expect(result.matchedDesired).not.toContain("проектирование");
  });

  it("matches a design profile from lot design documentation", () => {
    const designPlan = inferSearchIntentPlan({
      name: "Проектирование электроснабжения и электрооборудования",
      keywords: ["проектирование", "электроснабжение", "электрооборудование"],
      excludeKeywords: [],
    });
    const result = scoreSearchIntentFromProcedure(
      procedureCard(
        "Закупка услуг",
        "Разработка проектной документации по электроснабжению",
      ),
      designPlan,
    );
    expect(result.decision).toBe("match");
    expect(result.matchedObjects).toContain("электроснабжение");
    expect(result.matchedDesired).toContain("проектирование");
  });

  it("does not match a works profile on commissioning alone without the object", () => {
    const worksPlan = inferSearchIntentPlan({
      name: "Монтаж и пусконаладка электросилового оборудования",
      keywords: ["электрооборудование", "монтаж", "пусконаладка"],
      excludeKeywords: [],
    });
    const result = scoreSearchIntentFromProcedure(
      procedureCard(
        "Пусконаладка зернового комплекса",
        "Пусконаладочные работы оборудования зерноочистительного комплекса",
      ),
      worksPlan,
    );
    expect(result.decision).not.toBe("match");
    expect(result.matchedObjects).toEqual([]);
  });

  it("scores the same card independently for a supply profile", () => {
    const worksPlan = inferSearchIntentPlan({
      name: "Монтаж и пусконаладка электросилового оборудования",
      keywords: ["электрооборудование", "монтаж", "пусконаладка"],
      excludeKeywords: [],
    });
    const card = procedureCard(
      "Выбор субподрядной организации по объекту в Жлобине",
      "работы по монтажу электрооборудования распределительного пункта, пусконаладочных работ",
    );
    expect(scoreSearchIntentFromProcedure(card, worksPlan).decision).toBe("match");
    expect(scoreSearchIntentFromProcedure(card, nkuPlan).decision).not.toBe("match");
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
  it("keeps every saved phrase and adds distinct plan objects", () => {
    const plan = SearchIntentPlan.parse({
      objects: ["электрооборудование", "КТП"],
      desired_actions: ["монтаж"],
      intent: "works",
    });
    expect(
      platformSearchTerms(plan, ["КТПБ", "КТП", "сети электроснабжения"]),
    ).toEqual(["КТПБ", "КТП", "сети электроснабжения", "электрооборудование"]);
  });

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
