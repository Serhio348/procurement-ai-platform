import { describe, expect, it } from "vitest";
import { termMatches } from "./term-match.js";

describe("termMatches", () => {
  it("rejects an abbreviation inside an ordinary word", () => {
    expect(termMatches("Отправка почтовой корреспонденции, заказчик банку", "НКУ")).toBe(
      false,
    );
    expect(termMatches("услуги круглосуточной охраны", "КРУ")).toBe(false);
  });

  it("accepts a whole word and its inflected forms", () => {
    expect(termMatches("Низковольтное комплектное устройство НКУ", "НКУ")).toBe(true);
    expect(termMatches("монтаж трансформаторной подстанции", "трансформатор")).toBe(
      true,
    );
    expect(termMatches("подстанция в д. Застенки", "подстанция")).toBe(true);
  });

  it("keeps model-like tokens such as 2БКТПБ and БКТПБ-746", () => {
    expect(termMatches("2БКТПБ 400кВА-10/0,4 кВ", "КТПБ")).toBe(true);
    expect(termMatches("Реконструкция ВЛ-0,4 кВ от БКТПБ-746", "КТПБ")).toBe(true);
    expect(termMatches("Комплектная подстанция БКТПБ", "КТПБ")).toBe(true);
    expect(termMatches("НКУ-0,4 кВ", "НКУ")).toBe(true);
  });

  it("matches a multi-word term only as a bounded phrase", () => {
    expect(
      termMatches("КТП и сетей электроснабжения района", "сетей электроснабжения"),
    ).toBe(true);
    expect(
      termMatches("комплект сетей электроснабжениями", "сетей электроснабжения"),
    ).toBe(false);
  });
});
