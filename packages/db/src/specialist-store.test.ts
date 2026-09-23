import { describe, expect, it } from "vitest";
import {
  blobStorageKey,
  canonicalJson,
  caseListTimeShouldBump,
  comparableCardJson,
  jsonbSafe,
  postgresErrorMessage,
  profileRowMatches,
  toIsoDateTime,
  uniqueBySource,
  dedupeReviewVerdicts,
  workspaceDecisionKey,
} from "./specialist-store.js";
import { SpecialistProcurementCard, SpecialistWorkingProfile } from "@procurement/contracts";
import type { workspaceProfiles } from "./schema.js";

describe("blobStorageKey", () => {
  it("keeps the sha256 as the object name so PostgreSQL stores the hash, not the bytes", () => {
    const hash = "a".repeat(64);
    expect(blobStorageKey(hash)).toBe(`blobs/${hash}`);
  });
});

describe("toIsoDateTime", () => {
  it("turns Postgres timestamptz strings into ISO so profile load can parse lastDiscoveryAt", () => {
    expect(toIsoDateTime("2026-09-09 10:00:00+00")).toBe("2026-09-09T10:00:00.000Z");
    expect(toIsoDateTime("2026-09-09 10:00:00.651+00")).toBe("2026-09-09T10:00:00.651Z");
    expect(toIsoDateTime("2026-09-09T10:00:00.000Z")).toBe("2026-09-09T10:00:00.000Z");
  });
});

describe("workspaceDecisionKey", () => {
  it("produces the same key for a timestamptz Date and an ISO string so dedup matches", () => {
    const fromRow = workspaceDecisionKey(
      "auction/1",
      "reject",
      new Date("2026-09-18T11:25:41.807Z"),
    );
    const fromSnapshot = workspaceDecisionKey(
      "auction/1",
      "reject",
      "2026-09-18T11:25:41.807Z",
    );
    expect(fromRow).toBe(fromSnapshot);
  });
});

describe("jsonbSafe", () => {
  it("strips NUL bytes that PostgreSQL rejects inside jsonb", () => {
    expect(jsonbSafe({ title: "КТП\u0000Б" })).toEqual({ title: "КТПБ" });
  });

  it("keeps undefined so a missing jsonb field is not JSON.parse'd", () => {
    expect(jsonbSafe(undefined)).toBeUndefined();
  });
});

describe("uniqueBySource", () => {
  it("keeps the case that already has a source card over an inbox stub", () => {
    const stub = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000001",
      title: "Заглушка",
      status: "unknown",
      statusLabel: "неизвестен",
      url: "https://goszakupki.by/request/view/1",
      sourceProcurementId: "request/1",
    });
    const full = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000002",
      title: "Полная",
      status: "accepting_bids",
      statusLabel: "приём",
      url: "https://goszakupki.by/request/view/1",
      sourceProcurementId: "request/1",
      sourceCard: {
        sourceId: "goszakupki_by",
        sourceProcurementId: "request/1",
        url: "https://goszakupki.by/request/view/1",
        title: "Полная",
        fetchedAt: "2026-09-11T00:00:00.000Z",
      },
    });
    expect(uniqueBySource([stub, full])).toEqual([full]);
  });

  it("keeps a rejected case over an inbox stub so persist cannot empty trash", () => {
    const stub = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000001",
      title: "Заглушка",
      status: "unknown",
      statusLabel: "неизвестен",
      url: "https://goszakupki.by/request/view/1",
      sourceProcurementId: "request/1",
    });
    const rejected = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000002",
      title: "Не нужно",
      status: "accepting_bids",
      statusLabel: "приём",
      url: "https://goszakupki.by/request/view/1",
      sourceProcurementId: "request/1",
      triage: "reject",
    });
    expect(uniqueBySource([stub, rejected])).toEqual([rejected]);
    expect(uniqueBySource([rejected, stub])).toEqual([rejected]);
  });
});

describe("caseListTimeShouldBump", () => {
  it("does not reshuffle the SQL list when persist only rewrites the same decision", () => {
    const previous = { triage: "participate", archived: false, foundAs: "search" };
    expect(caseListTimeShouldBump(previous, { triage: "participate", foundAs: "search" })).toBe(
      false,
    );
    expect(caseListTimeShouldBump(previous, { triage: "monitor", foundAs: "search" })).toBe(true);
    expect(
      caseListTimeShouldBump(previous, {
        triage: "participate",
        archived: true,
        foundAs: "search",
      }),
    ).toBe(true);
    expect(caseListTimeShouldBump(undefined, { triage: "participate" })).toBe(true);
  });
});

describe("postgresErrorMessage", () => {
  it("unwraps a pg unique-violation cause", () => {
    const cause = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "specialist_cases_source_uq",
    });
    const wrapped = Object.assign(new Error("Failed query"), { cause });
    expect(postgresErrorMessage(wrapped)).toContain("specialist_cases_source_uq");
  });

  it("does not treat a Zod issue code as a Postgres SQLSTATE", () => {
    const cause = Object.assign(new Error("invalid input syntax for type json"), {
      code: "22P02",
    });
    const wrapped = Object.assign(new Error("Failed query"), {
      code: "invalid_type",
      cause,
    });
    expect(postgresErrorMessage(wrapped)).toContain("22P02");
  });
});


describe("dedupeReviewVerdicts", () => {
  it("keeps the latest decidedAt for the same profile and source", () => {
    const older = {
      profileId: "00000000-0000-4000-8000-000000000001",
      sourceProcurementId: "auction/1",
      decidedAt: "2026-09-01T00:00:00.000Z",
      algorithmVersion: "v1",
    };
    const newer = {
      ...older,
      decidedAt: "2026-09-02T00:00:00.000Z",
    };
    expect(dedupeReviewVerdicts([older, newer, older])).toEqual([newer]);
  });
});

describe("canonicalJson", () => {
  it("ignores object key order so a jsonb round-trip still compares equal (R37)", () => {
    expect(canonicalJson({ b: 1, a: { d: [2], c: "x" } })).toBe(
      canonicalJson({ a: { c: "x", d: [2] }, b: 1 }),
    );
    expect(canonicalJson(["а", "б"])).not.toBe(canonicalJson(["б", "а"]));
  });
});

describe("comparableCardJson", () => {
  it("treats a stored canonicalProcurementId as no change (R37)", () => {
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000001",
      title: "Карточка",
      status: "accepting_bids",
      statusLabel: "приём",
      url: "https://goszakupki.by/auction/view/1",
      sourceProcurementId: "auction/1",
      triage: "monitor",
    });
    const stored = { ...card, canonicalProcurementId: "00000000-0000-4000-8000-0000000000ff" };
    expect(comparableCardJson(stored)).toBe(comparableCardJson(card));
    expect(comparableCardJson({ ...card, title: "Другая" })).not.toBe(
      comparableCardJson(stored),
    );
  });
});

describe("profileRowMatches", () => {
  const profile = SpecialistWorkingProfile.parse({
    id: "00000000-0000-4000-8000-0000000000a1",
    name: "КТПБ",
    purpose: "подстанции",
    description: "описание",
    keywords: ["КТПБ", "КТП"],
    excludeKeywords: ["б/у"],
    statuses: ["accepting_bids"],
    excludeSingleSource: true,
    filters: { buyerUnp: "123456789" },
    watchNewProcurements: true,
    lastDiscoveryAt: "2026-09-09T10:00:00.000Z",
  });
  const row: typeof workspaceProfiles.$inferSelect = {
    id: profile.id,
    workspaceId: "00000000-0000-4000-8000-000000000010",
    name: "КТПБ",
    purpose: "подстанции",
    description: "описание",
    keywords: ["КТПБ", "КТП"],
    excludeKeywords: ["б/у"],
    statuses: ["accepting_bids"],
    excludeSingleSource: true,
    filters: { buyerUnp: "123456789" },
    watchNewProcurements: true,
    lastDiscoveryAt: "2026-09-09 10:00:00+00",
    createdAt: "2026-01-01 00:00:00+00",
    updatedAt: "2026-01-01 00:00:00+00",
  };

  it("matches a round-tripped row despite jsonb order and timestamptz format (R37)", () => {
    expect(profileRowMatches(profile, { ...row, filters: { buyerUnp: "123456789" } })).toBe(true);
  });

  it("detects any persisted field difference", () => {
    expect(profileRowMatches(profile, { ...row, name: "Другое" })).toBe(false);
    expect(profileRowMatches(profile, { ...row, keywords: ["КТП"] })).toBe(false);
    expect(profileRowMatches(profile, { ...row, filters: {} })).toBe(false);
    expect(profileRowMatches(profile, { ...row, lastDiscoveryAt: null })).toBe(false);
    expect(profileRowMatches(profile, { ...row, watchNewProcurements: false })).toBe(false);
  });
});
