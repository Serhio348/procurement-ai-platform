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

  it("downgrades a keyword buried inside a foreign code to a weak hint", () => {
    const result = cheapClassifyHit(
      { title: "Реконструкция ВЛ-0,4 кВ от БКТПБ-746 в аг. Каменюки" },
      profile,
    );
    expect(result.verdict).toBe("weak");
    expect(result.matchedTerms).toEqual(["КТПБ"]);
  });

  it("keeps the exact verdict when an exact and an embedded hit coexist", () => {
    const result = cheapClassifyHit(
      { title: "Поставка КТПБ для замены БКТПБ-746" },
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
