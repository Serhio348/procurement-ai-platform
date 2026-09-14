import { describe, expect, it } from "vitest";
import { termMatchStrength, termMatches } from "./term-match.js";

describe("termMatches", () => {
  it("rejects an abbreviation inside an ordinary word", () => {
    expect(termMatches("Отправка почтовой корреспонденции, заказчик банку", "НКУ")).toBe(
      false,
    );
    expect(termMatches("услуги круглосуточной охраны", "КРУ")).toBe(false);
    expect(
      termMatches("СО2-инкубатор (термостат электронный)", "НКУ"),
    ).toBe(false);
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

describe("termMatchStrength", () => {
  it("treats a whole word, a phrase, and a term leading a model code as exact", () => {
    expect(termMatchStrength("Низковольтное комплектное устройство НКУ", "НКУ")).toBe("exact");
    expect(termMatchStrength("НКУ-0,4 кВ", "НКУ")).toBe("exact");
    expect(termMatchStrength("Поставка КТПБ-250", "КТПБ")).toBe("exact");
    expect(termMatchStrength("монтаж трансформаторной подстанции", "трансформатор")).toBe(
      "exact",
    );
    expect(
      termMatchStrength("КТП и сетей электроснабжения района", "сетей электроснабжения"),
    ).toBe("exact");
  });

  it("marks a term buried inside a foreign code as embedded, not exact", () => {
    expect(termMatchStrength("Реконструкция ВЛ-0,4 кВ от БКТПБ-746", "КТПБ")).toBe("embedded");
    expect(termMatchStrength("2БКТПБ 400кВА-10/0,4 кВ", "КТПБ")).toBe("embedded");
    expect(termMatchStrength("Комплектная подстанция БКТПБ", "КТПБ")).toBe("embedded");
    expect(termMatchStrength("Реконструкция ВЛ-0,4 кВ от БКТПБ-746", "КТП")).toBe("embedded");
  });

  it("prefers exact over embedded when both are present", () => {
    expect(termMatchStrength("Поставка КТПБ для замены БКТПБ-746", "КТПБ")).toBe("exact");
  });

  it("returns none for abbreviations inside ordinary words", () => {
    expect(termMatchStrength("СО2-инкубатор (термостат электронный)", "НКУ")).toBe("none");
    expect(termMatchStrength("Открытый конкурс по закупке", "НКУ")).toBe("none");
    expect(termMatchStrength("тип Янкувер", "НКУ")).toBe("none");
    expect(termMatchStrength("услуги круглосуточной охраны", "КРУ")).toBe("none");
    expect(termMatchStrength("Закупка НКУ (УКН) 0,4 кВ", "НКУ")).toBe("exact");
  });
});
