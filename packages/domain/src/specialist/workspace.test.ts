import { describe, expect, it } from "vitest";
import {
  REVIEW_VERDICT_MAX_AGE_MS,
  SpecialistWorkspace,
  discoveryPublishedFrom,
} from "./workspace.js";

const write = {
  name: "Щиты",
  purpose: "",
  description: "",
  keywords: ["КТПБ"],
  excludeKeywords: [],
  statuses: ["accepting_bids" as const],
  excludeSingleSource: false,
  filters: {},
};

describe("discovery watermark", () => {
  it("asks the source from the day before the last pass, and for everything on the first pass", () => {
    expect(discoveryPublishedFrom({ lastDiscoveryAt: undefined })).toBeUndefined();
    expect(discoveryPublishedFrom({ lastDiscoveryAt: "2026-09-09T10:00:00.000Z" })).toBe("2026-09-08");
    // The margin crosses midnight: a pass just after 00:00 still covers yesterday.
    expect(discoveryPublishedFrom({ lastDiscoveryAt: "2026-09-09T00:30:00.000Z" })).toBe("2026-09-08");
  });

  it("survives a profile save that keeps the search phrases and resets when they change", () => {
    const workspace = new SpecialistWorkspace();
    const id = workspace.profile().id;
    workspace.replaceProfile(write);
    workspace.markDiscovered(id, "2026-09-09T10:00:00.000Z");
    expect(workspace.profile().lastDiscoveryAt).toBe("2026-09-09T10:00:00.000Z");

    workspace.replaceProfile({ ...write, name: "Щиты и подстанции" });
    expect(workspace.profile().lastDiscoveryAt).toBe("2026-09-09T10:00:00.000Z");

    workspace.replaceProfile({ ...write, keywords: ["КТПБ", "НКУ"] });
    expect(workspace.profile().lastDiscoveryAt).toBeUndefined();
  });

  it("round-trips through the snapshot", () => {
    const workspace = new SpecialistWorkspace();
    workspace.markDiscovered(workspace.profile().id, "2026-09-09T10:00:00.000Z");
    const restored = SpecialistWorkspace.parse(workspace.snapshot());
    expect(restored.profile().lastDiscoveryAt).toBe("2026-09-09T10:00:00.000Z");
  });
});

describe("profile survives a restart", () => {
  it("keeps the specialist's own keywords even when the profile is called like the stock seed", () => {
    const workspace = new SpecialistWorkspace();
    workspace.replaceProfile({
      ...write,
      name: "Электротехническое оборудование",
      keywords: ["КТПБ", "НКУ", "кабель"],
      excludeKeywords: ["ремонт"],
    });

    const restored = SpecialistWorkspace.parse(workspace.snapshot());

    expect(restored.profile().name).toBe("Электротехническое оборудование");
    expect(restored.profile().keywords).toEqual(["КТПБ", "НКУ", "кабель"]);
    expect(restored.profile().excludeKeywords).toEqual(["ремонт"]);
  });

  it("keeps the stock keyword set when the specialist typed it in by hand", () => {
    const workspace = new SpecialistWorkspace();
    workspace.replaceProfile({
      ...write,
      name: "Подстанции",
      keywords: ["КТПБ", "КТПП", "НКУ", "ВРУ", "ЩО", "подстанция", "трансформаторная подстанция", "2БКТПБ", "БКТП"],
    });

    const restored = SpecialistWorkspace.parse(workspace.snapshot());

    expect(restored.profile().keywords).toHaveLength(9);
  });
});

describe("archive", () => {
  it("remembers archived source ids across a snapshot round-trip and unarchives", () => {
    const workspace = new SpecialistWorkspace();
    workspace.setArchived("auction/1", true);
    workspace.setArchived("auction/2", true);
    workspace.setArchived("auction/2", false);

    const restored = SpecialistWorkspace.parse(workspace.snapshot());
    expect(restored.isArchived("auction/1")).toBe(true);
    expect(restored.isArchived("auction/2")).toBe(false);
  });
});

describe("remembered review verdicts", () => {
  it("remembers an irrelevant hit per profile and forgets it when the phrases change", () => {
    const workspace = new SpecialistWorkspace();
    const first = workspace.profile().id;
    workspace.replaceProfile(write);
    const second = workspace.addProfile().id;
    workspace.rememberIrrelevant(first, "auction/1", "2026-09-09T10:00:00.000Z");

    expect(workspace.isReviewedIrrelevant(first, "auction/1")).toBe(true);
    // The same procedure may well fit another direction.
    expect(workspace.isReviewedIrrelevant(second, "auction/1")).toBe(false);

    workspace.activate(first);
    workspace.replaceProfile({ ...write, excludeKeywords: ["ремонт"] });
    expect(workspace.isReviewedIrrelevant(first, "auction/1")).toBe(false);
  });

  it("expires old verdicts and drops those of removed profiles, but keeps fresh ones", () => {
    const workspace = new SpecialistWorkspace();
    const kept = workspace.profile().id;
    const removed = workspace.addProfile().id;
    workspace.rememberIrrelevant(kept, "auction/old", "2026-08-01T10:00:00.000Z");
    workspace.rememberIrrelevant(kept, "auction/new", "2026-09-08T10:00:00.000Z");
    workspace.rememberIrrelevant(removed, "auction/gone", "2026-09-08T10:00:00.000Z");
    workspace.removeProfile(removed);

    const forgotten = workspace.forgetStaleVerdicts("2026-09-09T10:00:00.000Z", REVIEW_VERDICT_MAX_AGE_MS);

    expect(forgotten).toBe(2);
    expect(workspace.isReviewedIrrelevant(kept, "auction/old")).toBe(false);
    expect(workspace.isReviewedIrrelevant(kept, "auction/new")).toBe(true);
    const restored = SpecialistWorkspace.parse(workspace.snapshot());
    expect(restored.isReviewedIrrelevant(kept, "auction/new")).toBe(true);
  });
});

describe("lastWorkingKind", () => {
  it("restores the last Слежу/Участвую after «Убрать», otherwise Слежу", () => {
    const workspace = new SpecialistWorkspace();
    expect(workspace.lastWorkingKind("auction/1")).toBe("monitor");

    workspace.recordDecision("auction/1", "participate", "2026-09-10T10:00:00.000Z");
    workspace.recordDecision("auction/1", "reject", "2026-09-11T10:00:00.000Z");
    expect(workspace.lastWorkingKind("auction/1")).toBe("participate");

    workspace.recordDecision("auction/1", "monitor", "2026-09-12T10:00:00.000Z");
    workspace.recordDecision("auction/1", "reject", "2026-09-13T10:00:00.000Z");
    expect(workspace.lastWorkingKind("auction/1")).toBe("monitor");
  });
});
