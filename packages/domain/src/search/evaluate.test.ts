import { describe, expect, it } from "vitest";
import { evaluateSearch, metricsFromRows, type SearchEvalRow } from "./evaluate.js";
import {
  formatNkuClassReport,
  NKU_PUMP_CASES,
  NKU_PUMP_LIVE_CASES,
  NKU_PUMP_PROFILE,
  NKU_PUMP_SEED_CASES,
} from "./evaluate-nku-pumps.js";

describe("evaluateSearch", () => {
  it("covers the required NCU pump titles", () => {
    const titles = NKU_PUMP_CASES.map((item) => item.title);
    expect(titles).toContain("Поставка НКУ");
    expect(titles).toContain("Поставка НКУ для насосов");
    expect(titles).toContain("Изготовление шкафа управления насосами");
    expect(titles).toContain("Шкаф управления насосами");
    expect(titles).toContain("Монтаж НКУ");
    expect(titles).toContain("Ремонт НКУ");
    expect(titles).toContain("Пусконаладка НКУ");
    expect(titles).toContain("Поставка НКУ с последующим монтажом силами заказчика");
    expect(titles).toContain("Реконструкция насосной станции");
    expect(titles).toContain("Открытый конкурс по закупке аудиторских услуг");
    expect(titles).toContain("СО2-инкубатор (термостат электронный)");
    expect(titles).toContain("Набор аспирационный хирургический тип Янкувер");
    expect(titles).toContain("Закупка шкаф управления наружным освещением");
    expect(titles).toContain("Шкаф управления котельной");
  });

  it("keeps a live goszakupki dump of at least 30 labelled cards", () => {
    expect(NKU_PUMP_LIVE_CASES.length).toBeGreaterThanOrEqual(30);
    expect(NKU_PUMP_LIVE_CASES.some((item) => item.id === "request/3657757")).toBe(true);
  });

  it("gives the new listing higher precision than the old keyword match on the seed set", () => {
    const report = evaluateSearch(NKU_PUMP_SEED_CASES, NKU_PUMP_PROFILE);
    expect(report.next.precision ?? 0).toBeGreaterThan(report.old.precision ?? 0);
    expect(report.next.falsePositives).toBeLessThan(report.old.falsePositives);
    expect(report.next.truePositives).toBeGreaterThanOrEqual(report.old.truePositives);
  });

  it("reviews missing purpose and discards substring noise", () => {
    const report = evaluateSearch(NKU_PUMP_SEED_CASES, NKU_PUMP_PROFILE);
    const byId = Object.fromEntries(report.rows.map((row) => [row.id, row]));
    expect(byId["nku-contest-substring"]?.newDecision).toBe("discard");
    expect(byId["nku-incubator-substring"]?.newDecision).toBe("discard");
    expect(byId["nku-yankauer-substring"]?.newDecision).toBe("discard");
    expect(byId["nku-street-lighting"]?.newDecision).toBe("review");
    expect(byId["nku-boiler-cabinet"]?.newDecision).toBe("review");
    expect(byId["nku-supplier-person"]?.newDecision).toBe("review");
    expect(byId["nku-no-purpose"]?.newDecision).toBe("review");
    expect(byId["nku-for-pumps"]?.newDecision).toBe("match");
  });

  it("reports STAGE-51 problem classes with lighting as a new discard", () => {
    const text = formatNkuClassReport(evaluateSearch(NKU_PUMP_SEED_CASES, NKU_PUMP_PROFILE));
    expect(text).toMatch(/Чужое назначение[\s\S]*?new FP=0 FN=0/);
    expect(text).toMatch(/Подстрока НКУ[\s\S]*?new: match=0 review=0 discard=3/);
  });
});

describe("metricsFromRows", () => {
  it("computes precision, recall and F1 from labelled rows and skips uncertain gold", () => {
    const rows: SearchEvalRow[] = [
      {
        id: "tp",
        title: "a",
        gold: "relevant",
        oldDecision: "match",
        newDecision: "match",
      },
      {
        id: "fp",
        title: "b",
        gold: "irrelevant",
        oldDecision: "match",
        newDecision: "discard",
      },
      {
        id: "fn",
        title: "c",
        gold: "relevant",
        oldDecision: "discard",
        newDecision: "match",
      },
      {
        id: "skip",
        title: "d",
        gold: "uncertain",
        oldDecision: "match",
        newDecision: "match",
      },
    ];
    const old = metricsFromRows(rows, "oldDecision");
    expect(old.truePositives).toBe(1);
    expect(old.falsePositives).toBe(1);
    expect(old.falseNegatives).toBe(1);
    expect(old.precision).toBeCloseTo(0.5);
    expect(old.recall).toBeCloseTo(0.5);
    expect(old.f1).toBeCloseTo(0.5);
    const next = metricsFromRows(rows, "newDecision");
    expect(next.falsePositives).toBe(0);
    expect(next.falseNegatives).toBe(0);
    expect(next.precision).toBe(1);
    expect(next.recall).toBe(1);
    expect(next.f1).toBe(1);
  });
});
