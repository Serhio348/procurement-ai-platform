import { describe, expect, it } from "vitest";
import { blobStorageKey, jsonbSafe, postgresErrorMessage, uniqueBySource } from "./specialist-store.js";
import { SpecialistProcurementCard } from "@procurement/contracts";

describe("blobStorageKey", () => {
  it("keeps the sha256 as the object name so PostgreSQL stores the hash, not the bytes", () => {
    const hash = "a".repeat(64);
    expect(blobStorageKey(hash)).toBe(`blobs/${hash}`);
  });
});

describe("jsonbSafe", () => {
  it("strips NUL bytes that PostgreSQL rejects inside jsonb", () => {
    expect(jsonbSafe({ title: "КТП\u0000Б" })).toEqual({ title: "КТПБ" });
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
});
