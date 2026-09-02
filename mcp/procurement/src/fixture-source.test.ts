import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SearchQuery } from "@procurement/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { FixtureProcurementSource } from "./fixture-source.js";

describe("FixtureProcurementSource", () => {
  let source: FixtureProcurementSource;

  beforeAll(async () => {
    const fixturePath = fileURLToPath(
      new URL("../../../tests/fixtures/procurement/normalized.json", import.meta.url),
    );
    source = new FixtureProcurementSource(
      JSON.parse(await readFile(fixturePath, "utf8")) as unknown,
    );
  });

  it("keeps date-only publication values as calendar dates", async () => {
    const result = await source.search(
      SearchQuery.parse({
        sourceId: "fixture",
        keywords: ["Трансформаторы силовые"],
        publishedFrom: "2026-07-01T23:59:00+03:00",
        publishedTo: "2026-07-01T23:59:59+03:00",
      }),
    );

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.sourceProcurementId).toBe("marketing-001");
    expect(result.hits[0]?.publishedAt).toEqual({
      precision: "date",
      date: "2026-07-01",
      timeZone: "Europe/Minsk",
    });
  });

  it("rejects duplicate source record ids in a fixture dataset", () => {
    const minimalCard = {
      sourceId: "fixture",
      sourceProcurementId: "duplicate",
      url: "https://example.test/duplicate",
      title: "Duplicate",
      fetchedAt: "2026-09-01T10:00:00+03:00",
    };

    expect(
      () =>
        new FixtureProcurementSource({
          sourceId: "fixture",
          records: [{ card: minimalCard }, { card: minimalCard }],
        }),
    ).toThrow(/unique/);
  });
});
