import { describe, expect, it } from "vitest";
import {
  blobStorageKey,
  caseListTimeShouldBump,
  jsonbSafe,
  postgresErrorMessage,
  toIsoDateTime,
  uniqueBySource,
} from "./specialist-store.js";
import { SpecialistProcurementCard } from "@procurement/contracts";

describe("dedupeReviewVerdicts", () => {
  it("keeps one row per profile and source, preferring the newer decision", async () => {
    const { dedupeReviewVerdicts } = await import("./specialist-store.js");
    const older = {
      profileId: "00000000-0000-4000-8000-000000000901",
      sourceProcurementId: "request/3675640",
      decidedAt: "2026-09-16T10:00:00.000Z",
      algorithmVersion: "search-review-v4",
    };
    const newer = {
      ...older,
      decidedAt: "2026-09-16T13:11:53.823Z",
    };
    expect(dedupeReviewVerdicts([older, newer, older])).toEqual([newer]);
  });
});

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
