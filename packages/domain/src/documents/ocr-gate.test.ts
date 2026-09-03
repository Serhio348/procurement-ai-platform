import { describe, expect, it } from "vitest";
import { ocrNeedsHuman } from "./ocr-gate.js";

describe("ocrNeedsHuman", () => {
  it("escalates a poorly read scan instead of treating garbled OCR as a fact", () => {
    expect(ocrNeedsHuman(0.31, 0.75)).toBe(true);
    expect(ocrNeedsHuman(0.9, 0.75)).toBe(false);
  });
});
