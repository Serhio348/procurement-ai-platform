import { describe, expect, it } from "vitest";
import type { DecisionMemoryEntry } from "@procurement/contracts";
import { stemWord, termOccurs } from "../search/query-terms.js";
import {
  decisionTerms,
  nextSuggestionTerm,
  profileTermTable,
  rejectSignals,
} from "./decision-terms.js";

const PROFILE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

let sequence = 0;
function decision(
  kind: DecisionMemoryEntry["kind"],
  title: string,
  profileIds: string[] = [PROFILE],
  lotTitles: string[] = [],
): DecisionMemoryEntry {
  sequence += 1;
  return {
    sourceProcurementId: `request/${sequence}`,
    kind,
    profileIds,
    title,
    lotTitles,
    decidedAt: new Date(Date.UTC(2026, 9, 1, 0, sequence)).toISOString(),
  };
}

const profile = { id: PROFILE, keywords: ["сети 0,4 кВ"], excludeKeywords: [] as string[] };

const taken = [
  decision("participate", "Монтаж сетей 0,4 кВ в д. Озерцо"),
  decision("participate", "Выполнение работ по устройству сетей 0,4кВ"),
  decision("monitor", "Реконструкция сетей 0,4 кВ подстанции"),
];

const lightingRejects = [
  decision("reject", "Капитальный ремонт наружного освещения ул. Ленина"),
  decision("reject", "Текущий ремонт сетей наружного освещения в г. Пинске"),
  decision("reject", "Монтаж наружного освещения парка"),
  decision("reject", "Устройство наружного освещения дворовой территории"),
  decision("reject", "Модернизация наружного освещения стадиона"),
];

describe("decision terms", () => {
  it("counts inflected forms as one term and keeps pairs inside one phrase", () => {
    const keys = decisionTerms({
      title: "Ремонт наружного освещения, работы по ремонту освещению",
      lotTitles: [],
    }).map((term) => term.key);
    const lighting = stemWord("освещения");
    expect(stemWord("освещению")).toBe(lighting);
    expect(keys.filter((key) => key === lighting)).toHaveLength(1);
    expect(keys).toContain(`${stemWord("наружного")} ${lighting}`);
    // The preposition and the comma both break a pair.
    expect(keys).not.toContain(`${stemWord("работы")} ${stemWord("ремонту")}`);
    expect(keys).not.toContain(`${lighting} ${stemWord("работы")}`);
  });

  it("reads lot subjects too", () => {
    const keys = decisionTerms({ title: "Закупка", lotTitles: ["Кабель силовой"] }).map(
      (term) => term.key,
    );
    expect(keys.some((key) => key.startsWith("кабел"))).toBe(true);
  });
});

describe("profile term table", () => {
  it("offers a pair that repeats across rejects and never occurs in a taken case", () => {
    const table = profileTermTable([...taken, ...lightingRejects], profile);
    const signals = rejectSignals(table);
    expect(signals.map((term) => term.label)).toEqual(["наружного освещения"]);
    expect(signals[0]?.rejectCount).toBe(5);
    expect(signals[0]?.rejectExamples).toHaveLength(3);
  });

  it("does not offer a word the specialist also took", () => {
    const table = profileTermTable([...taken, ...lightingRejects], profile);
    const montage = table.terms.find((term) => term.key.startsWith("монтаж") && !term.key.includes(" "));
    expect(montage?.acceptCount).toBeGreaterThan(0);
    expect(rejectSignals(table).some((term) => term.key === montage?.key)).toBe(false);
  });

  it("stays silent below five rejects — one refusal can be chance", () => {
    const table = profileTermTable([...taken, ...lightingRejects.slice(0, 4)], profile);
    expect(rejectSignals(table)).toEqual([]);
  });

  it("stays silent while the profile has too few taken cases to tell a reason from a common word", () => {
    const table = profileTermTable([taken[0]!, ...lightingRejects], profile);
    expect(rejectSignals(table)).toEqual([]);
  });

  it("learns which words are generic from the cabinet's own taken cases, not from a built-in list", () => {
    const works = Array.from({ length: 8 }, (_, index) =>
      decision("reject", `Выполнение работ на объекте ${index + 1}`),
    );
    const table = profileTermTable([...taken, ...works], profile);
    // «Выполнение работ» is also in a taken case, so eight rejects do not make it a reason.
    expect(rejectSignals(table).map((term) => term.label)).toEqual(["объекте"]);
  });

  it("skips terms the profile already searches for or already excludes", () => {
    const rejects = Array.from({ length: 6 }, (_, index) =>
      decision("reject", `Сети 0,4 кВ наружного освещения, объект ${index + 1}`),
    );
    const excluded = { ...profile, excludeKeywords: ["освещение"] };
    const table = profileTermTable([...taken, ...rejects], excluded);
    expect(table.terms.some((term) => term.key.split(" ").some((stem) => stem.startsWith("освещ")))).toBe(
      false,
    );
    expect(table.terms.some((term) => term.key === "сет")).toBe(false);
  });

  it("does not offer a term again, nor a narrower or wider form of it", () => {
    const table = profileTermTable([...taken, ...lightingRejects], profile);
    const signals = rejectSignals(table);
    const first = nextSuggestionTerm(signals, []);
    expect(first?.label).toBe("наружного освещения");
    expect(nextSuggestionTerm(signals, [first!.key])).toBeUndefined();
    expect(nextSuggestionTerm(signals, [stemWord("освещения")])).toBeUndefined();
    expect(nextSuggestionTerm(signals, ["кровл"])?.label).toBe("наружного освещения");
  });

  it("offers a label that, once excluded, cuts every reject it was counted from", () => {
    const table = profileTermTable([...taken, ...lightingRejects], profile);
    const offered = nextSuggestionTerm(rejectSignals(table), []);
    expect(offered).toBeDefined();
    for (const reject of lightingRejects) {
      expect(termOccurs(reject.title, offered!.label)).toBe(true);
    }
    for (const accepted of taken) {
      expect(termOccurs(accepted.title, offered!.label)).toBe(false);
    }
    expect(termOccurs("Обслуживание наружное освещение квартала", offered!.label)).toBe(true);
  });

  it("never counts another profile's decisions", () => {
    const foreign = lightingRejects.map((entry) => ({ ...entry, profileIds: [OTHER] }));
    const table = profileTermTable([...taken, ...foreign], profile);
    expect(table.rejectCount).toBe(0);
    expect(rejectSignals(table)).toEqual([]);
  });
});
