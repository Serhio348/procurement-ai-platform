import { describe, expect, it } from "vitest";
import { quoteIsOnPage } from "./provenance.js";

describe("quoteIsOnPage", () => {
  it("accepts a quote that is on the page even with different whitespace", () => {
    expect(quoteIsOnPage("Аванс  30 процентов", "Техническое задание.\nАванс 30 процентов.")).toBe(
      true,
    );
  });

  it("rejects a hallucinated quote that the page does not contain", () => {
    expect(quoteIsOnPage("Аванс 90 процентов", "Техническое задание. Аванс 30 процентов.")).toBe(
      false,
    );
  });
});
