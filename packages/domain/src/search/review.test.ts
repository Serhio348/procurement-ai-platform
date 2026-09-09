import { ProcedureCard, SearchHit } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import {
  buildSearchClassifierInput,
  outcomeFromCardReview,
  outcomeFromModel,
  reviewByCard,
} from "./review.js";

const profile = {
  name: "Электротехническое оборудование",
  purpose: "Поставка КТПБ и НКУ",
  keywords: ["КТПБ", "НКУ"],
  excludeKeywords: ["ремонт"],
};

function card(title: string, lots: Array<{ title: string; description?: string }>) {
  return ProcedureCard.parse({
    sourceId: "goszakupki_by",
    sourceProcurementId: "auction/1",
    url: "https://goszakupki.by/auction/view/1",
    title,
    lots: lots.map((lot, index) => ({ number: String(index + 1), ...lot })),
    fetchedAt: "2026-09-09T00:00:00.000Z",
  });
}

describe("reviewByCard", () => {
  it("accepts a hit whose title said nothing but whose lot names the equipment exactly", () => {
    const result = reviewByCard(
      card("Поставка оборудования для объекта", [{ title: "НКУ-0,4 кВ, 2 шт." }]),
      profile,
    );
    expect(result.verdict).toBe("relevant");
    expect(outcomeFromCardReview(result)?.decidedBy).toBe("card");
    expect(outcomeFromCardReview(result)?.reason).toContain("НКУ");
  });

  it("lets an exclude word in a lot description drop the hit", () => {
    const result = reviewByCard(
      card("Поставка оборудования", [{ title: "НКУ", description: "текущий ремонт щитовой" }]),
      profile,
    );
    expect(result.verdict).toBe("irrelevant");
    expect(outcomeFromCardReview(result)?.verdict).toBe("irrelevant");
  });

  it("stays undecided when the card only repeats the buried code", () => {
    const result = reviewByCard(
      card("Реконструкция ВЛ-0,4 кВ от БКТПБ-746", [{ title: "Строительно-монтажные работы" }]),
      profile,
    );
    expect(result.verdict).toBe("weak");
    expect(outcomeFromCardReview(result)).toBeUndefined();
  });
});

describe("outcomeFromModel", () => {
  it("accepts a confident verdict and hands a hesitant one to a human", () => {
    const sure = outcomeFromModel(
      {
        verdict: "irrelevant",
        confidence: 0.95,
        reason: "Лабораторный инкубатор, не электрооборудование.",
        needDeeper: false,
        matchedTerms: [],
      },
      0.7,
    );
    expect(sure.verdict).toBe("irrelevant");
    expect(sure.decidedBy).toBe("model");

    const unsure = outcomeFromModel(
      {
        verdict: "relevant",
        confidence: 0.5,
        reason: "Возможно, поставка щитов.",
        needDeeper: true,
        matchedTerms: [],
      },
      0.7,
    );
    expect(unsure.verdict).toBe("needs_human");
    expect(unsure.reason).toContain("не уверена");
  });

  it("treats a malformed answer as a question for the specialist, not as a verdict", () => {
    expect(outcomeFromModel({ score: 87 }, 0.7).verdict).toBe("needs_human");
    expect(outcomeFromModel("relevant", 0.7).verdict).toBe("needs_human");
  });
});

describe("buildSearchClassifierInput", () => {
  it("passes the working profile text and a trimmed card, never a score request", () => {
    const hit = SearchHit.parse({
      sourceId: "goszakupki_by",
      sourceProcurementId: "auction/1",
      url: "https://goszakupki.by/auction/view/1",
      title: "СО2-инкубатор",
    });
    const input = buildSearchClassifierInput(
      profile,
      hit,
      card("СО2-инкубатор", Array.from({ length: 10 }, (_, i) => ({ title: `Лот ${String(i)}` }))),
    );
    expect(input.profile.purpose).toBe("Поставка КТПБ и НКУ");
    expect(input.profile.keywords).toEqual(["КТПБ", "НКУ"]);
    expect(input.card?.lotTitles).toHaveLength(8);
    expect(buildSearchClassifierInput(profile, hit, undefined).card).toBeUndefined();
  });
});
