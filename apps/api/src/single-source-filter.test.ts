import { ProcedureCard, SearchHit } from "@procurement/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFailedSingleSourceFilter } from "./single-source-filter.js";

function hit(id: string, kind?: string) {
  return SearchHit.parse({
    sourceId: "goszakupki_by",
    sourceProcurementId: id,
    url: `https://goszakupki.by/${id.replace("/", "/view/")}`,
    title: "Подстанция",
    ...(kind === undefined ? {} : { kind }),
  });
}

function card(id: string, basis?: string) {
  return ProcedureCard.parse({
    sourceId: "goszakupki_by",
    sourceProcurementId: id,
    url: `https://goszakupki.by/${id.replace("/", "/view/")}`,
    title: "Подстанция",
    kind: "single_source",
    fetchedAt: "2026-09-11T00:00:00.000Z",
    ...(basis === undefined ? {} : { singleSourceBasis: basis }),
  });
}

describe("createFailedSingleSourceFilter", () => {
  it("reads only single-source cards, drops the after-failed ones and caches the verdict", async () => {
    const read = vi.fn(async (id: string) =>
      id === "single-source/1"
        ? card(id, "7. Признание процедуры государственной закупки несостоявшейся")
        : card(id, "1. Иное основание"),
    );
    const filter = createFailedSingleSourceFilter({ cardWatch: { read } });
    const hits = [hit("auction/1", "electronic_auction"), hit("single-source/1", "single_source"), hit("single-source/2", "single_source")];

    const first = await filter.apply(hits, { excludeSingleSourceAfterFailed: true });
    expect(first.hits.map((item) => item.sourceProcurementId)).toEqual(["auction/1", "single-source/2"]);
    expect(first.droppedCount).toBe(1);
    expect(read).toHaveBeenCalledTimes(2);

    await filter.apply(hits, { excludeSingleSourceAfterFailed: true });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does nothing when the profile does not ask, and keeps a hit whose card could not be read", async () => {
    const read = vi.fn(async () => undefined);
    const filter = createFailedSingleSourceFilter({ cardWatch: { read } });
    const hits = [hit("single-source/1", "single_source")];

    const off = await filter.apply(hits, { excludeSingleSourceAfterFailed: false });
    expect(off.hits).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();

    const unreadable = await filter.apply(hits, { excludeSingleSourceAfterFailed: true });
    expect(unreadable.hits).toHaveLength(1);
    expect(unreadable.droppedCount).toBe(0);
    // Not cached: the next pass tries the card again.
    await filter.apply(hits, { excludeSingleSourceAfterFailed: true });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("paces card reads through the caller's rate limiter", async () => {
    const beforeRequest = vi.fn(async () => undefined);
    const filter = createFailedSingleSourceFilter({
      cardWatch: { read: async (id) => card(id) },
    });
    await filter.apply(
      [hit("single-source/1", "single_source"), hit("single-source/2", "single_source")],
      { excludeSingleSourceAfterFailed: true },
      { beforeRequest },
    );
    expect(beforeRequest).toHaveBeenCalledTimes(2);
  });
});
