import { describe, expect, it } from "vitest";
import {
  listingKeepsPlatformHit,
  listingMatchesAnyKeyword,
  stemWord,
  stemsShareRoot,
  termOccurs,
} from "./query-terms.js";

describe("stemWord", () => {
  it("treats inflected монтаж forms as one stem", () => {
    expect(stemWord("монтаж")).toBe(stemWord("монтажа"));
    expect(stemWord("монтаж")).toBe(stemWord("монтажу"));
    expect(stemsShareRoot(stemWord("монтаж"), stemWord("монтажные"))).toBe(true);
  });

  it("treats short nouns in different cases as one term", () => {
    expect(termOccurs("Строительство сетей электроснабжения микрорайона", "сети электроснабжения")).toBe(true);
    expect(termOccurs("Ремонт сети электроснабжения", "сетей электроснабжения")).toBe(true);
    expect(termOccurs("Поставка шкафов", "шкаф")).toBe(true);
    expect(stemWord("шкаф")).toBe("шкаф");
    expect(stemWord("банк")).toBe("банк");
  });

  it("joins hyphen and concatenated пусконаладка", () => {
    expect(termOccurs("пуско-наладочные работы насоса", "пусконаладка")).toBe(true);
    expect(termOccurs("пусконаладочные работы", "пуско-наладка")).toBe(true);
  });
});

describe("поставка vs поставщик", () => {
  it("treats supply verbs as the same action", () => {
    expect(termOccurs("Поставка НКУ", "поставка")).toBe(true);
    expect(termOccurs("поставить НКУ", "поставка")).toBe(true);
    expect(termOccurs("НКУ поставляется комплектом", "поставка")).toBe(true);
  });

  it("does not treat a supplier person as the supply action", () => {
    expect(termOccurs("Выбор поставщика оборудования", "поставка")).toBe(false);
    expect(termOccurs("договор с поставщика шкафа", "поставка")).toBe(false);
    expect(termOccurs("извещение поставщику", "поставка")).toBe(false);
    expect(termOccurs("перечень поставщики", "поставка")).toBe(false);
    expect(stemsShareRoot(stemWord("поставка"), stemWord("поставщика"))).toBe(false);
  });
});

describe("проект vs проектирование", () => {
  it("does not treat a construction object name as the design action", () => {
    expect(termOccurs("Проект застройки микрорайона", "проектирование")).toBe(false);
    expect(termOccurs("Проект строительства", "проектирование")).toBe(false);
    expect(termOccurs("Проект объекта. Монтаж электрооборудования", "проектирование")).toBe(
      false,
    );
  });

  it("treats design documentation as the design action", () => {
    expect(
      termOccurs("Разработка проектной документации по электроснабжению", "проектирование"),
    ).toBe(true);
    expect(termOccurs("проектной документации", "проектный")).toBe(true);
    expect(termOccurs("проектирование электроснабжения", "проектирование")).toBe(true);
    expect(
      termOccurs("Проектная документация на электроснабжение объекта", "проектирование"),
    ).toBe(true);
  });

  it("does not treat a designer person as the design action", () => {
    expect(termOccurs("проектировщик системы электроснабжения", "проектирование")).toBe(false);
  });

  it("still matches монтаж inflections after the project-family split", () => {
    expect(termOccurs("монтаж электрооборудования", "монтаж")).toBe(true);
  });
});

describe("termOccurs", () => {
  it("does not treat НКУ as a hit inside банку", () => {
    expect(termOccurs("услуги банку и охрана", "НКУ")).toBe(false);
    expect(termOccurs("НКУ-0,4 кВ", "НКУ")).toBe(true);
  });

  it("does not treat НКУ as a hit inside конкурс, инкубатор or Янкувер", () => {
    expect(termOccurs("Открытый конкурс по закупке аудиторских услуг", "НКУ")).toBe(false);
    expect(termOccurs("СО2-инкубатор (термостат электронный)", "НКУ")).toBe(false);
    expect(termOccurs("Набор аспирационный хирургический тип Янкувер", "НКУ")).toBe(false);
    expect(termOccurs("Закупка НКУ (УКН) 0,4 кВ", "НКУ")).toBe(true);
  });
});

describe("listingMatchesAnyKeyword", () => {
  it("keeps a real NCU token and drops substring noise", () => {
    expect(listingMatchesAnyKeyword("Закупка НКУ 0,4 кВ", ["НКУ"])).toBe(true);
    expect(listingMatchesAnyKeyword("Открытый конкурс", ["НКУ"])).toBe(false);
    expect(listingMatchesAnyKeyword("инкубатор", ["НКУ"])).toBe(false);
  });

  it("keeps abbreviations КИП and МТР as whole terms", () => {
    expect(listingMatchesAnyKeyword("Поставка КИП для насосной", ["КИП"])).toBe(true);
    expect(listingMatchesAnyKeyword("закупка материалов МТР", ["МТР"])).toBe(true);
    expect(listingMatchesAnyKeyword("экипировка персонала", ["КИП"])).toBe(false);
  });
});

describe("listingKeepsPlatformHit", () => {
  it("keeps a row the site returned when the keyword is only on the card", () => {
    expect(
      listingKeepsPlatformHit(
        "Выбор субподрядной организации по объекту в Жлобине",
        ["АСКУЭ"],
      ),
    ).toBe(true);
  });

  it("still drops substring noise that the site matched in the listing title", () => {
    expect(listingKeepsPlatformHit("Открытый конкурс", ["НКУ"])).toBe(false);
    expect(listingKeepsPlatformHit("инкубатор", ["НКУ"])).toBe(false);
  });

  it("keeps an abbreviation embedded in another uppercase equipment code", () => {
    expect(
      listingKeepsPlatformHit("Блочная комплектная подстанция БКТПБ №3", ["КТПБ"]),
    ).toBe(true);
  });
});
