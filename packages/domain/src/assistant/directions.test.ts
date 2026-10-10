import { describe, expect, it } from "vitest";
import {
  directionTermKey,
  parseAssistantDirections,
  validateAssistantDirections,
  type DirectionSubject,
} from "./directions.js";

const subject = (title: string, text?: string): DirectionSubject => ({
  title,
  subject: text ?? title,
});

const REJECTED = [
  subject("Закрытие ЦТП-10 с устройством ИТП"),
  subject("Реконструкция теплового пункта №5 в г. Минске"),
  subject("Модернизация ЦТП-8"),
  subject("Демонтаж ЦТП-3"),
  subject("Поверка приборов учёта тепла"),
];
const ACCEPTED = [
  subject("Монтаж сетей 0,4 кВ в д. Озерцо"),
  subject("Выполнение работ по устройству сетей 0,4кВ"),
  subject("Реконструкция сетей 0,4 кВ подстанции"),
];

const base = {
  rejected: REJECTED,
  accepted: ACCEPTED,
  keywords: ["сети 0,4 кВ"],
  excludeKeywords: [] as string[],
  offeredTermKeys: [] as string[],
};

describe("parse assistant directions", () => {
  it("keeps well-formed directions and drops broken ones", () => {
    const directions = parseAssistantDirections({
      directions: [
        { name: "Тепловые пункты", phrases: ["ЦТП", "тепловой пункт", "ЦТП"] },
        { name: "", phrases: ["что-то"] },
        { name: "Без фраз", phrases: [] },
      ],
    });
    expect(directions).toEqual([{ name: "Тепловые пункты", phrases: ["ЦТП", "тепловой пункт"] }]);
  });

  it("returns nothing on malformed payloads", () => {
    expect(parseAssistantDirections(null)).toEqual([]);
    expect(parseAssistantDirections("junk")).toEqual([]);
    expect(parseAssistantDirections({ other: true })).toEqual([]);
  });
});

describe("validate assistant directions", () => {
  it("keeps a phrase that covers several rejects and no taken case", () => {
    const validated = validateAssistantDirections({
      ...base,
      directions: [{ name: "Тепловые пункты", phrases: ["ЦТП", "тепловой"] }],
    });
    expect(validated).toHaveLength(1);
    expect(validated[0]!.name).toBe("Тепловые пункты");
    expect(validated[0]!.phrases).toContain("ЦТП");
    expect(validated[0]!.phrases).toContain("тепловой");
    expect(validated[0]!.rejectCount).toBe(5);
    expect(validated[0]!.examples).toHaveLength(3);
  });

  it("drops a phrase that hits a taken case", () => {
    const validated = validateAssistantDirections({
      ...base,
      directions: [{ name: "Работы", phrases: ["ЦТП", "сетей"] }],
    });
    expect(validated[0]?.phrases).toEqual(["ЦТП"]);
  });

  it("drops a phrase covering a single reject — one refusal is not a direction", () => {
    const validated = validateAssistantDirections({
      ...base,
      directions: [{ name: "Поверка", phrases: ["ЦТП", "приборов учёта"] }],
    });
    expect(validated[0]?.phrases).toEqual(["ЦТП"]);
  });

  it("drops a direction when no phrase survives", () => {
    const validated = validateAssistantDirections({
      ...base,
      directions: [{ name: "Поверка", phrases: ["приборов учёта"] }],
    });
    expect(validated).toEqual([]);
  });

  it("skips phrases that are already search terms, exclusions or offered terms", () => {
    const validated = validateAssistantDirections({
      ...base,
      excludeKeywords: ["тепловой"],
      offeredTermKeys: ["цтп"],
      directions: [{ name: "Тепловые пункты", phrases: ["ЦТП", "тепловой", "модернизация ЦТП"] }],
    });
    // «ЦТП» was offered before, «тепловой» is excluded, «модернизация ЦТП»
    // overlaps the offered «цтп» — nothing left to offer.
    expect(validated).toEqual([]);
  });

  it("skips a phrase made only of the profile's own keywords", () => {
    const validated = validateAssistantDirections({
      ...base,
      directions: [{ name: "Сети", phrases: ["сети 0,4 кВ", "ЦТП"] }],
    });
    expect(validated[0]?.phrases).toEqual(["ЦТП"]);
  });

  it("derives a term key like a term key of a word phrase", () => {
    expect(directionTermKey("наружного освещения")).toBe("наруж освеще");
    expect(directionTermKey("ЦТП")).toBe("цтп");
  });
});
