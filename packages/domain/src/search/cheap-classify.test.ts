import { describe, expect, it } from "vitest";
import { cheapClassifyHit } from "./cheap-classify.js";

const profile = {
  keywords: ["КТПБ", "подстанция"],
  excludeKeywords: ["бытов"],
};

describe("cheapClassifyHit", () => {
  it("lets an exclude keyword discard a hit even when a profile keyword is also present", () => {
    const result = cheapClassifyHit(
      { title: "Бытовой щиток и КТПБ для дачи" },
      profile,
    );
    expect(result.verdict).toBe("irrelevant");
    expect(result.excludedBy).toEqual(["бытов"]);
    expect(result.matchedTerms).toEqual([]);
  });

  it("accepts an obvious keyword match without asking a model", () => {
    const result = cheapClassifyHit(
      { title: "Поставка комплектной трансформаторной подстанции КТПБ-250" },
      profile,
    );
    expect(result.verdict).toBe("relevant");
    expect(result.matchedTerms).toEqual(["КТПБ"]);
  });

  it("leaves synonym-only titles for the model instead of guessing", () => {
    const result = cheapClassifyHit(
      { title: "Поставка распределительного устройства 10 кВ" },
      profile,
    );
    expect(result.verdict).toBe("ambiguous");
  });
});
