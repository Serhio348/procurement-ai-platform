import { describe, expect, it } from "vitest";
import {
  addPlatformKeyword,
  mergePlatformKeywords,
  platformKeywordEdits,
  removePlatformKeyword,
  resolvePlatformKeywords,
  searchPhrasesFromLookingFor,
} from "./looking-for.js";

describe("searchPhrasesFromLookingFor", () => {
  it("turns the looking-for text into platform queries and drops filler words", () => {
    expect(searchPhrasesFromLookingFor("нужны КТПБ, НКУ и подстанция")).toEqual([
      "КТПБ",
      "НКУ",
      "подстанция",
    ]);
  });

  it("keeps a short product phrase as one query", () => {
    expect(searchPhrasesFromLookingFor("комплектная трансформаторная подстанция")).toEqual([
      "комплектная трансформаторная подстанция",
    ]);
  });

  it("returns nothing when the specialist has not written what to look for", () => {
    expect(searchPhrasesFromLookingFor("  ")).toEqual([]);
    expect(searchPhrasesFromLookingFor("нужны и для")).toEqual([]);
  });

  it("keeps specialist-edited platform lines and fills them only when empty", () => {
    expect(resolvePlatformKeywords("кабель", ["КТПБ", "ВРУ"])).toEqual(["КТПБ", "ВРУ"]);
    expect(resolvePlatformKeywords("нужны КТПБ, НКУ", [])).toEqual(["КТПБ", "НКУ"]);
  });

  it("merges looking-for words with extras and does not keep dropped derived words", () => {
    expect(platformKeywordEdits("нужны КТПБ, НКУ", ["КТПБ", "ВРУ"])).toEqual({
      extras: ["ВРУ"],
      removed: ["НКУ"],
    });
    expect(mergePlatformKeywords("кабель", ["ВРУ"], ["КТПБ"])).toEqual(["кабель", "ВРУ"]);
    expect(addPlatformKeyword("КТПБ", [], ["КТПБ"], "ктпб")).toEqual({
      extras: [],
      removed: [],
    });
    expect(removePlatformKeyword("КТПБ, НКУ", ["ВРУ"], [], "НКУ")).toEqual({
      extras: ["ВРУ"],
      removed: ["НКУ"],
    });
  });

  it("turns a prose looking-for sentence into platform queries", () => {
    expect(
      searchPhrasesFromLookingFor(
        "Поиск закупок комплектных трансформаторных подстанций, низковольтных устройств и щитового оборудования.",
      ),
    ).toEqual([
      "комплектных трансформаторных подстанций",
      "низковольтных устройств",
      "щитового оборудования",
    ]);
  });
});
