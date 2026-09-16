import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FALLBACK_STATUS_OPTIONS,
  goszakupkiStatusIds,
  parseGoszakupkiSearchFilters,
  searchQueryStatusIds,
} from "./goszakupki-by-filters.js";

const fixtureDirectory = new URL("../../../tests/fixtures/goszakupki-by/", import.meta.url);

describe("goszakupki search status filters", () => {
  it("reads status checkbox values from the site form", async () => {
    const html = await readFile(
      fileURLToPath(new URL("search-filters.html", fixtureDirectory)),
      "utf8",
    );
    const parsed = parseGoszakupkiSearchFilters(html);
    expect(parsed.statuses).toEqual([
      { value: "1", label: "Подача предложений" },
      { value: "2", label: "Подача документов/сведений" },
      { value: "3", label: "Рассмотрение предложений" },
      { value: "4", label: "Проведение аукциона" },
      { value: "5", label: "Завершена" },
      { value: "6", label: "Отменена" },
      { value: "7", label: "Не состоялась" },
    ]);
  });

  it("maps the profile Подача предложений checkbox to both accepting-bids site codes", () => {
    expect(goszakupkiStatusIds(["accepting_bids"], FALLBACK_STATUS_OPTIONS)).toEqual([
      "Submission",
      "SubmissionEss",
    ]);
  });

  it("uses the live form values, not the fallback names, when the form was parsed", async () => {
    const html = await readFile(
      fileURLToPath(new URL("search-filters.html", fixtureDirectory)),
      "utf8",
    );
    const options = parseGoszakupkiSearchFilters(html).statuses;
    expect(
      searchQueryStatusIds({ statusIds: [], statuses: ["accepting_bids"] }, options),
    ).toEqual(["1", "2"]);
  });
});
